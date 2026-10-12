/**
 * The six low-severity findings of the final security review.
 *
 * 1. A caught error's message was logged whole at warn/error one layer up from
 *    where the sub-server had already been careful: a PDF URL that failed to
 *    download came back as "Could not fetch <URL with its signed query>: HTTP
 *    403", and LayerManager wrote that to stderr and LOG_FILE.
 * 2. The sub-server's get_generated_file and get_file_info read or stat'ed any
 *    path, with no allowed-roots check.
 * 3. A request's `model` went into agy's argv unchecked.
 * 4. Existence was checked before the roots were (existsSync in the sub-server,
 *    statSync in LayerManager's code-file routing), so a path outside the roots
 *    answered differently depending on whether it existed -- and the refusal
 *    named its realpath.
 * 5. Redaction missed `host.tld?query`, credential labels (`Bearer`, `api_key=`,
 *    `token:`), and token-shaped path segments; `cgmb info` printed 12
 *    characters of a key, and an invalid key logged 8.
 * 6. A step reference's path walked inherited properties: `@s1.__proto__...`.
 *
 * Log lines are captured from the logger's own winston instance, in process.
 * The sub-server is the real one, spawned over stdio.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import Transport from 'winston-transport';

import { startFakeGemini } from './fixtures/fake-gemini.mjs';
import { createCliStubs, readCalls } from './fixtures/routing-stubs.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const AI_STUDIO_SERVER = join(ROOT, 'dist', 'mcp-servers', 'ai-studio-mcp-server.js');
const FAKE_KEY = 'AIzaFakeKeyForTestsOnly000000000';

// realpath: on macOS tmpdir() is reached through a symlink, and the roots are
// compared both as given and resolved.
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'cgmb-low-')));
const workspace = join(scratch, 'workspace');
const outside = join(scratch, 'outside');
const childTmp = join(scratch, 'tmp');
for (const dir of [workspace, outside, childTmp, join(workspace, 'output', 'images'), join(scratch, 'stubs')]) {
  mkdirSync(dir, { recursive: true });
}

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);
writeFileSync(join(workspace, 'output', 'images', 'generated-image-1.png'), TINY_PNG);
writeFileSync(join(workspace, 'report.txt'), 'inside the workspace\n');
writeFileSync(join(workspace, 'util.ts'), 'export const x = 1;\n');
writeFileSync(join(outside, 'secret.txt'), 'SENTINEL-OUTSIDE-CONTENT\n');

let escapeLinkAvailable = true;
const escapeLink = join(workspace, 'looks-innocent.txt');
try {
  symlinkSync(join(outside, 'secret.txt'), escapeLink);
} catch {
  // Windows needs developer mode or elevation for symlinks.
  escapeLinkAvailable = false;
}

// The in-process half of this file: what LayerManager, AIStudioLayer and the
// agy layer read from the environment. Set before they are imported.
const savedEnv = { ...process.env };
Object.assign(process.env, {
  AI_STUDIO_API_KEY: FAKE_KEY,
  CGMB_ALLOWED_ROOTS: workspace,
  // The PDF URL below is served from 127.0.0.1.
  CGMB_ALLOW_PRIVATE_URLS: 'true',
  ENABLE_CACHING: 'false',
  HOME: scratch,
  USERPROFILE: scratch,
  // The agy layer's per-request workspaces are cgmb-agy-* under tmpdir(),
  // which antigravity-cli.test.mjs scans for leftovers while this file runs.
  TMPDIR: childTmp,
  TMP: childTmp,
  TEMP: childTmp,
});
for (const name of ['LOG_FILE', 'LOG_LEVEL', 'CGMB_DEBUG', 'ANTIGRAVITY_MODEL', 'GOOGLE_GEMINI_BASE_URL']) {
  delete process.env[name];
}

const { LayerManager } = await import('../dist/core/LayerManager.js');
const { AIStudioLayer } = await import('../dist/layers/AIStudioLayer.js');
const { AntigravityCLILayer } = await import('../dist/layers/AntigravityCLILayer.js');
const { DEFAULT_ANTIGRAVITY_MODEL, firstLineForLog, redactUrls } = await import('../dist/core/types.js');
const { logger } = await import('../dist/utils/logger.js');
const { maskApiKey } = await import('../dist/auth/OAuthManager.js');

after(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) { delete process.env[key]; }
  }
  Object.assign(process.env, savedEnv);
  rmSync(scratch, { recursive: true, force: true });
});

// --- log capture -------------------------------------------------------------------

let captured = [];
class Capture extends Transport {
  log(info, callback) {
    captured.push({ level: info.level, line: JSON.stringify(info) });
    callback();
  }
}
const capture = new Capture();
let savedLevel;

before(() => {
  savedLevel = logger.getLevel();
  // Everything, debug included: the finding is about any line, not only warn.
  logger.setLevel('debug');
  logger.logger.add(capture);
});
after(() => {
  logger.logger.remove(capture);
  logger.setLevel(savedLevel);
});

async function logsOf(fn) {
  captured = [];
  let result;
  let thrown;
  try {
    result = await fn();
  } catch (error) {
    thrown = error;
  }
  await new Promise(resolve => setImmediate(resolve));
  return { result, thrown, logs: captured.slice() };
}

/** A manager whose layers are stubs, with `overrides` for some of them. */
function managerWith(overrides = {}, behaviour = async () => ({ items: ['one', 'two'] })) {
  const manager = new LayerManager();
  for (const [name, field] of [
    ['aistudio', 'aiStudioLayer'],
    ['claude', 'claudeLayer'],
    ['antigravity', 'antigravityLayer'],
  ]) {
    const layer = overrides[name] ?? {
      initialize: async () => {},
      isAvailable: async () => true,
      execute: async task => ({ success: true, data: await behaviour(name, task), metadata: { layer: name, duration: 1 } }),
    };
    manager[field] = layer;
    manager[`${field}Promise`] = Promise.resolve(layer);
    manager.layerInitialized[name] = true;
  }
  return manager;
}

// --- an MCP client over the real sub-server's stdio ---------------------------------

class McpChild {
  constructor(script, { cwd, env }) {
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = '';
    this.child = spawn(process.execPath, [script], { cwd, env, windowsHide: true });
    this.exited = new Promise(resolve => this.child.on('exit', resolve));
    let buffered = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => {
      buffered += chunk;
      let brk;
      while ((brk = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, brk);
        buffered = buffered.slice(brk + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        this.pending.get(message.id)?.(message);
        this.pending.delete(message.id);
      }
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', chunk => { this.stderr += chunk; });
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`no answer to ${method} within 30s. stderr:\n${this.stderr.slice(-1500)}`));
      }, 30000);
      this.pending.set(id, message => { clearTimeout(timer); resolve(message); });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  async start() {
    const init = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'low-findings-test', version: '1' },
    });
    assert.ok(init.result, `initialize failed: ${JSON.stringify(init.error)}`);
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    return this;
  }

  call(name, args) {
    return this.request('tools/call', { name, arguments: args });
  }

  async close() {
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 5000);
    await this.exited;
    clearTimeout(timer);
  }
}

/** The error message of a tools/call response, or null when it succeeded. */
const errorOf = response => response.error?.message ?? (response.result?.isError ? JSON.stringify(response.result.content) : null);

// =====================================================================================
// 1. Error messages one layer up
// =====================================================================================

describe('1. a failed PDF URL download, logged one layer up', () => {
  const SIGNATURE = 'SENTINELSIG0123456789abcdef';
  const CREDENTIAL = 'SENTINELCRED';
  let server;
  let pdfUrl;

  before(async () => {
    server = createServer((req, res) => {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('denied');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    pdfUrl = `http://127.0.0.1:${server.address().port}/files/report.pdf?X-Goog-Signature=${SIGNATURE}&X-Goog-Credential=${CREDENTIAL}`;
  });
  after(() => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }));

  it('writes no log line with the URL\'s query, and the caller still gets all of it', async () => {
    // The real AI Studio layer, spawning the real sub-server; the other two
    // layers are stubs that are never reached (they cannot read files).
    const layer = new AIStudioLayer();
    layer.isInitialized = true;
    const manager = managerWith({ aistudio: layer });

    try {
      const { thrown, logs } = await logsOf(() => {
        const decision = manager.decideRoute({ prompt: 'Summarise this', urls: [pdfUrl] });
        assert.equal(decision.kind, 'file_url');
        return manager.executeRoute(decision, { prompt: 'Summarise this', files: [{ path: pdfUrl, type: 'pdf' }] });
      });

      assert.ok(thrown, 'a 403 is a failure');
      assert.ok(thrown.message.includes(`X-Goog-Signature=${SIGNATURE}`), `the thrown error is intact: ${thrown.message}`);

      for (const { line } of logs) {
        assert.ok(!line.includes(SIGNATURE) && !line.includes(CREDENTIAL) && !line.includes('X-Goog-'), line);
      }
      // The failure was logged -- by host -- at warn, where it used to leak.
      const warned = logs.filter(l => l.level === 'warn' && /Could not fetch http:\/\/127\.0\.0\.1:\d+\/…/.test(l.line));
      assert.ok(warned.length > 0, JSON.stringify(logs.filter(l => l.level !== 'debug' && l.level !== 'info')));
    } finally {
      await layer.shutdown();
    }
  });

  it('logs only the redacted first line at every fallback step', async () => {
    const message = `Could not fetch https://storage.example.com/a.pdf?sig=${SIGNATURE}: HTTP 403\nsecond line SENTINEL-SECOND`;
    const failing = {
      initialize: async () => {},
      isAvailable: async () => true,
      execute: async () => { throw new Error(message); },
    };
    const manager = managerWith({ antigravity: failing, claude: failing, aistudio: failing });

    const { thrown, logs } = await logsOf(() =>
      manager.executeRoute(manager.decideRoute({ prompt: 'what is the capital of France' }), { prompt: 'what is the capital of France' })
    );

    assert.ok(thrown?.message.includes(SIGNATURE), 'the caller is told everything');
    const failures = logs.filter(l => /failed/.test(l.line) && (l.level === 'warn' || l.level === 'error'));
    assert.ok(failures.length >= 2, JSON.stringify(logs));
    for (const { line } of logs) {
      assert.ok(!line.includes(SIGNATURE), line);
      assert.ok(!line.includes('SENTINEL-SECOND'), `only the first line: ${line}`);
    }
  });
});

// =====================================================================================
// 2 and 4. The sub-server's file tools and the allowed roots
// =====================================================================================

describe('2 and 4. the sub-server reads only inside the roots, and does not say what exists outside them', () => {
  let fake;
  let server;

  before(async () => {
    fake = await startFakeGemini();
    const env = { ...savedEnv, AI_STUDIO_API_KEY: FAKE_KEY, GOOGLE_GEMINI_BASE_URL: fake.baseUrl, HOME: scratch, USERPROFILE: scratch };
    for (const name of ['NODE_TEST_CONTEXT', 'LOG_LEVEL', 'CGMB_DEBUG', 'LOG_FILE', 'CGMB_ALLOWED_ROOTS']) {
      delete env[name];
    }
    // Started in the workspace: that, and nothing else, is the allowed root.
    server = await new McpChild(AI_STUDIO_SERVER, { cwd: workspace, env }).start();
  });
  after(async () => {
    await server?.close();
    await fake?.close();
  });

  for (const tool of ['get_generated_file', 'get_file_info']) {
    it(`${tool} refuses a file outside the roots`, async () => {
      const response = await server.call(tool, { filePath: join(outside, 'secret.txt') });
      const message = errorOf(response);
      assert.ok(message, `refused: ${JSON.stringify(response.result)?.slice(0, 300)}`);
      assert.match(message, /File is not readable: /);
      assert.ok(!JSON.stringify(response).includes('SENTINEL-OUTSIDE-CONTENT'));
    });

    it(`${tool} refuses .. out of the workspace`, async () => {
      const response = await server.call(tool, { filePath: '../outside/secret.txt' });
      assert.match(errorOf(response) ?? '', /File is not readable: \.\.\/outside\/secret\.txt/);
    });
  }

  it('get_generated_file still returns a file the server generated', async () => {
    const response = await server.call('get_generated_file', { filePath: 'output/images/generated-image-1.png' });
    assert.equal(response.error, undefined, JSON.stringify(response.error));
    assert.equal(response.result.file.data, TINY_PNG.toString('base64'));
    assert.equal(response.result.file.type, 'image');
  });

  it('get_file_info still describes a file the server generated', async () => {
    const response = await server.call('get_file_info', { filePath: join(workspace, 'output', 'images', 'generated-image-1.png') });
    assert.equal(response.error, undefined, JSON.stringify(response.error));
    assert.equal(response.result.fileInfo.size, TINY_PNG.length);
  });

  it('keeps "not found" for a missing file inside the roots', async () => {
    const response = await server.call('get_file_info', { filePath: 'output/images/none.png' });
    assert.match(errorOf(response) ?? '', /File not found: output\/images\/none\.png/);
    const image = await server.call('analyze_image', { imagePath: join(workspace, 'none.png') });
    assert.match(errorOf(image) ?? '', /Image file not found/);
  });

  /** Every tool that takes a path, with the arguments that name `p`. */
  const PATH_TOOLS = {
    analyze_image: p => ({ imagePath: p }),
    multimodal_process: p => ({ files: [{ path: p, type: 'text' }], instructions: 'Summarise' }),
    analyze_documents: p => ({ documents: [p], instructions: 'Summarise' }),
    get_generated_file: p => ({ filePath: p }),
    get_file_info: p => ({ filePath: p }),
  };

  for (const [tool, argsFor] of Object.entries(PATH_TOOLS)) {
    it(`${tool}: a missing and an existing file outside the roots get the identical refusal`, async () => {
      // The same path, asked about before and after it exists.
      const probe = join(outside, `probe-${tool}.txt`);
      const missing = errorOf(await server.call(tool, argsFor(probe)));
      writeFileSync(probe, 'now it exists\n');
      const existing = errorOf(await server.call(tool, argsFor(probe)));

      assert.ok(missing, 'a missing file outside the roots is refused, not skipped');
      assert.equal(existing, missing);
      assert.match(missing, new RegExp(`File is not readable: ${probe.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));

      // And a directory outside that does not exist at all says the same thing.
      const nowhere = join(outside, 'no', 'such', 'dir', `probe-${tool}.txt`);
      const absent = errorOf(await server.call(tool, argsFor(nowhere)));
      assert.equal(absent, missing.replaceAll(probe, nowhere));
    });

    it(`${tool}: a symlink out of the roots is refused by the name it was given`, { skip: !escapeLinkAvailable && 'symlinks unavailable' }, async () => {
      const message = errorOf(await server.call(tool, argsFor(escapeLink)));
      assert.ok(message, 'refused');
      assert.match(message, /File is not readable: .*looks-innocent\.txt/);
      assert.ok(!message.includes('secret.txt'), `the link's target is not named: ${message}`);
      assert.ok(!message.includes(outside), `nor its directory: ${message}`);
    });
  }

  it('sent nothing to Gemini for any refused path', () => {
    assert.equal(fake.generateCalls().length, 0);
  });
});

describe('4. code-file routing does not stat outside the roots', () => {
  // In-process: this process's roots are its cwd and CGMB_ALLOWED_ROOTS (the
  // workspace). Anything outside goes to AI Studio, existing or not, so the
  // route says nothing about what is there.
  const route = path => new LayerManager().decideRoute({ prompt: 'review this', files: [{ path, type: 'code' }] }).kind;

  it('routes a code file outside the roots the same way whether or not it exists', () => {
    const probe = join(outside, 'probe.ts');
    const before = route(probe);
    writeFileSync(probe, 'export const y = 2;\n');
    assert.equal(route(probe), before);
    assert.equal(before, 'files');
  });

  it('still sends a code file inside the roots to Claude', () => {
    assert.equal(route(join(workspace, 'util.ts')), 'code_files');
  });

  it('does not follow a link out of the roots', { skip: !escapeLinkAvailable && 'symlinks unavailable' }, () => {
    const link = join(workspace, 'escape.ts');
    writeFileSync(join(outside, 'target.ts'), 'export const z = 3;\n');
    symlinkSync(join(outside, 'target.ts'), link);
    assert.equal(route(link), 'files');
  });
});

// =====================================================================================
// 3. agy --model
// =====================================================================================

describe('3. a request\'s model reaches agy\'s argv only when it is a model ID', () => {
  const stubs = createCliStubs(join(scratch, 'stubs'));

  async function runWithModel(model) {
    const layer = new AntigravityCLILayer();
    layer.isInitialized = true;
    layer.agyPath = stubs.agyPath;
    layer.agyVersion = '1.3.3';
    const before = readCalls(stubs.logPath).length;
    const { result, thrown, logs } = await logsOf(() => layer.execute({ prompt: 'hello', model, useSearch: false }));
    assert.equal(thrown, undefined, thrown?.message);
    assert.equal(result.success, true);
    const calls = readCalls(stubs.logPath).slice(before).filter(c => c.kind === 'call');
    assert.equal(calls.length, 1);
    return { argv: calls[0].argv, logs };
  }

  for (const model of [
    'x --yolo',
    'gemini-3.6-flash-high --yolo',
    'a b',
    'gemini-3.6-flash\n--yolo',
    'gemini\t3',
    '--yolo',
    'x'.repeat(65),
    'gemini;rm -rf ~',
    'gemini$(id)',
  ]) {
    it(`falls back to the default for ${JSON.stringify(model)}`, async () => {
      const { argv, logs } = await runWithModel(model);
      const at = argv.indexOf('--model');
      assert.ok(at >= 0, JSON.stringify(argv));
      assert.equal(argv[at + 1], DEFAULT_ANTIGRAVITY_MODEL);
      for (const arg of argv) {
        assert.doesNotMatch(arg, /yolo|\s|;|\$|x{65}/, `argv: ${JSON.stringify(argv)}`);
      }

      const rejected = logs.filter(l => l.level === 'warn' && /model was rejected/.test(l.line));
      assert.equal(rejected.length, 1, JSON.stringify(logs.filter(l => l.level === 'warn')));
      for (const { line } of logs) {
        assert.ok(!line.includes(model) && !line.includes(JSON.stringify(model).slice(1, -1)), `the rejected value is not logged: ${line}`);
        assert.ok(!line.includes('yolo'), line);
      }
    });
  }

  it('passes a model ID through unchanged', async () => {
    const { argv } = await runWithModel('gemini-3.6-flash-high');
    assert.equal(argv[argv.indexOf('--model') + 1], 'gemini-3.6-flash-high');
  });
});

// =====================================================================================
// 5. Redaction and key masking
// =====================================================================================

describe('5. redactUrls: the gaps', () => {
  it('cuts a bare host.tld?query with no slash', () => {
    assert.equal(redactUrls('fetch failed for storage.googleapis.com?X-Goog-Signature=abc123 now'), 'fetch failed for storage.googleapis.com?… now');
    assert.equal(redactUrls('example.com?token=abc'), 'example.com?…');
    assert.equal(redactUrls('api.example.co.uk:8443?key=AIzaSECRET'), 'api.example.co.uk:8443?…');
  });

  it('keeps a credential label and drops its value', () => {
    const cases = [
      ['Authorization: Bearer ya29.a0AfH6SMBx-secret', 'Authorization: Bearer …'],
      ['authorization: bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln', 'authorization: bearer …'],
      ['sent with Bearer abcdefghijklmnopqrstuvwxyz', 'sent with Bearer …'],
      ['api_key=AIzaSyD-SECRET-VALUE', 'api_key=…'],
      ['x-goog-api-key: AIzaSyD-SECRET-VALUE', 'x-goog-api-key: …'],
      ['apiKey: abc', 'apiKey: …'],
      ['API-KEY=xyz;next=1', 'API-KEY=…;next=1'],
      ['token=ghp_0123456789abcdefABCDEF', 'token=…'],
      ['access_token: 1/fFAGRNJru1FTz70BzhT3Zg', 'access_token: …'],
      ['TOKEN: abc.def.ghi', 'TOKEN: …'],
      ['{"token":"abcdef123456","n":1}', '{"token":"…","n":1}'],
      ["{'api_key': 'AIzaSECRET'}", "{'api_key': '…'}"],
    ];
    for (const [input, expected] of cases) {
      assert.equal(redactUrls(input), expected, input);
    }
  });

  it('cuts a token-shaped path segment when there is no query', () => {
    assert.equal(
      redactUrls('POST /v1/sessions/AbCdEf0123456789XyZ_-kq/messages failed'),
      'POST /v1/sessions/…/messages failed'
    );
    assert.equal(
      redactUrls('webhook /services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXX1'),
      'webhook /services/T00000000/B00000000/…'
    );
    assert.equal(redactUrls('upload/6e8bc430-9c3a-11d9-9669-0800200c9a66 done'), 'upload/… done');
  });

  it('leaves the legitimate lines that look like these alone', () => {
    for (const text of [
      'token: 3 retries',
      'token: expired',
      'token=undefined',
      'max tokens: 4096',
      'tokenizer: cl100k_base',
      'the Bearer scheme is required',
      'Bearer authentication failed',
      'api keys: 2 configured',
      'Reading /home/user/docs/report_quarterly_final_v2.pdf',
      '/home/x/quarterly-report-overview',
      '/home/user/claude-gemini-multimodal-bridge/dist/cli.js',
      '    at LayerManager.run (/home/user/claude-gemini-multimodal-bridge/dist/core/LayerManager.js:123:45)',
      'node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js',
      'see README.md for details',
      'is it config.json? yes',
    ]) {
      assert.equal(redactUrls(text), text, text);
    }
  });

  it('is idempotent on its own output, and firstLineForLog applies the new forms', () => {
    const once = redactUrls('a host.example?q=1 b Bearer ya29.a0AfH6SMBx c api_key=K d token: abcdef123 e /s/AbCdEf0123456789XyZ_-kq');
    assert.equal(redactUrls(once), once);
    assert.doesNotMatch(firstLineForLog(`${'y'.repeat(180)} Authorization: Bearer ya29.SECRETSECRET`), /SECRETSECRET/);
  });
});

describe('5. an invalid AI Studio key is logged by length and two characters', () => {
  it('logs no more than "AI" of the key', async () => {
    const saved = process.env.AI_STUDIO_API_KEY;
    process.env.AI_STUDIO_API_KEY = 'XYZSECRETKEYVALUE';
    try {
      const { logs } = await logsOf(() => new AIStudioLayer().getAIStudioApiKey());
      const lines = logs.filter(l => /Invalid AI Studio API key format/.test(l.line));
      assert.ok(lines.length >= 1, JSON.stringify(logs));
      const entry = JSON.parse(lines[0].line);
      assert.equal(entry.keyStart, 'XY');
      assert.equal(entry.keyLength, 'XYZSECRETKEYVALUE'.length);
      assert.equal(entry.keyPrefix, undefined);
      for (const { line } of logs) {
        assert.ok(!line.includes('XYZ'), line);
      }
    } finally {
      process.env.AI_STUDIO_API_KEY = saved;
    }
  });
});

// =====================================================================================
// 6. Step reference paths
// =====================================================================================

describe('6. a step reference walks own properties only', () => {
  const s1 = { id: 's1', layer: 'antigravity', action: 'search', input: { prompt: 's1' } };
  const s2 = input => ({ id: 's2', layer: 'claude', action: 'synthesize_response', input: { prompt: 's2', ...input }, dependsOn: ['s1'] });

  for (const mode of ['sequential', 'parallel']) {
    it(`resolves inherited names to the missing marker (${mode})`, async () => {
      const seen = [];
      const manager = managerWith({}, async (name, task) => {
        seen.push(task);
        return { items: ['one', 'two'], text: `did:${task.prompt}` };
      });

      const { result, logs } = await logsOf(() => manager.executeWorkflow({
        steps: [s1, s2({
          proto: '@s1.__proto__.constructor',
          ctor: '@s1.output.constructor',
          toStr: '@s1.output.toString',
          absent: '@s1.output.nothing',
          items: '@s1.output.items',
          first: '@s1.output.items.0',
        })],
      }, {}, { executionMode: mode }));

      assert.equal(result?.success, true, JSON.stringify(result?.results));
      const task = seen.find(t => t.prompt === 's2');
      for (const key of ['proto', 'ctor', 'toStr', 'absent']) {
        assert.equal(typeof task[key], 'object', `${key} is not a function from the runtime`);
        assert.equal(task[key]._stepMissing, true, `${key}: ${JSON.stringify(task[key])}`);
        assert.equal(task[key]._stepId, 's1');
      }
      assert.deepEqual(task.items, ['one', 'two']);
      assert.equal(task.first, 'one');

      // Logged by step id and path, as the other missing references are.
      const refLogs = new Set(logs.filter(l => /Could not resolve step reference/.test(l.line)).map(l => JSON.parse(l.line).path));
      assert.deepEqual([...refLogs].sort(), ['__proto__.constructor', 'output.constructor', 'output.nothing', 'output.toString']);
    });
  }
});

// =====================================================================================
// 1 and 5, everywhere: the logger itself, key masking, and a static guard
// =====================================================================================

describe('1. logger.error given an Error', () => {
  it('logs the first line, redacted, and the stack only at debug', async () => {
    const error = new Error('upload failed for https://example.com/a?sig=SENTINELSIG1\nSENTINEL-SECOND-LINE');

    logger.setLevel('error');
    let quiet;
    try {
      quiet = await logsOf(() => logger.error('Upload failed', error));
    } finally {
      logger.setLevel('debug');
    }
    assert.equal(quiet.logs.length, 1, JSON.stringify(quiet.logs));
    const entry = JSON.parse(quiet.logs[0].line);
    assert.equal(entry.level, 'error');
    assert.equal(entry.message, 'Upload failed');
    assert.equal(entry.error, 'upload failed for https://example.com/…');
    assert.equal(entry.stack, undefined);
    assert.doesNotMatch(quiet.logs[0].line, /SENTINEL/);

    const loud = await logsOf(() => logger.error('Upload failed', error));
    const stacks = loud.logs.filter(l => l.level === 'debug' && /Error stack: Upload failed/.test(l.line));
    assert.equal(stacks.length, 1, JSON.stringify(loud.logs));
    assert.match(JSON.parse(stacks[0].line).stack, /\n\s+at /);
    for (const { line } of loud.logs) {
      assert.ok(!line.includes('SENTINELSIG1'), line);
    }
  });

  it('passes a metadata record through as before', async () => {
    const { logs } = await logsOf(() => logger.error('Plain', { code: 7 }));
    assert.equal(JSON.parse(logs[0].line).code, 7);
  });
});

describe('5. maskApiKey', () => {
  it('shows four characters and the length, and only the length of a short key', () => {
    assert.equal(maskApiKey('AIzaTEST-0123456789-abcdefghij'), 'AIza… (30 characters)');
    assert.equal(maskApiKey('AIzaSHORT'), '… (9 characters)');
    assert.equal(maskApiKey(''), '(empty)');
  });
});

describe('1. no warn or error log site passes a raw error', () => {
  // A static guard over the built output: every `logger.warn(` / `logger.error(`
  // call is read whole, the sanitising calls in it (errorForLog,
  // firstLineForLog, redactUrls, ...) are blanked out, and what is left must not
  // read an error's message, interpolate an error, or pass one through.
  const DIST = join(ROOT, 'dist');

  /** End (exclusive) of the bracketed span whose opening bracket is at src[open]. */
  function spanEnd(src, open) {
    const frames = [{ mode: 'code', depth: 0, fromTpl: false }];
    for (let i = open; i < src.length; i++) {
      const c = src[i];
      const top = frames[frames.length - 1];
      if (top.mode === 'sq' || top.mode === 'dq') {
        if (c === '\\') { i++; continue; }
        if ((top.mode === 'sq' && c === "'") || (top.mode === 'dq' && c === '"')) { frames.pop(); }
        continue;
      }
      if (top.mode === 'tpl') {
        if (c === '\\') { i++; continue; }
        if (c === '`') { frames.pop(); continue; }
        if (c === '$' && src[i + 1] === '{') { frames.push({ mode: 'code', depth: 0, fromTpl: true }); i++; }
        continue;
      }
      if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) { return src.length; } continue; }
      if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2) + 1; continue; }
      if (c === "'") { frames.push({ mode: 'sq' }); continue; }
      if (c === '"') { frames.push({ mode: 'dq' }); continue; }
      if (c === '`') { frames.push({ mode: 'tpl' }); continue; }
      if (c === '(' || c === '[' || c === '{') { top.depth++; continue; }
      if (c === ')' || c === ']' || c === '}') {
        if (c === '}' && top.fromTpl && top.depth === 0) { frames.pop(); continue; }
        top.depth--;
        if (frames.length === 1 && top.depth === 0) { return i + 1; }
      }
    }
    return src.length;
  }

  const SAFE_CALL = /\b(?:errorForLog|firstLineForLog|redactUrls|hostsOf|describeToolArgs)\(/g;
  function withoutSafeCalls(text) {
    let out = text;
    for (;;) {
      SAFE_CALL.lastIndex = 0;
      const m = SAFE_CALL.exec(out);
      if (!m) { return out; }
      out = out.slice(0, m.index) + 'SAFE' + out.slice(spanEnd(out, m.index + m[0].length - 1));
    }
  }

  const ERR = String.raw`(?:error|err|e|reason|\w+Error|errorOutput|stderr|stdout)`;
  const RAW = [
    [/\.message\b/, 'reads .message'],
    [new RegExp(String.raw`\$\{\s*${ERR}\s*\}`), 'interpolates an error'],
    [new RegExp(String.raw`String\(\s*${ERR}\s*\)`), 'String(error)'],
    [new RegExp(String.raw`,\s*${ERR}\s*\)$`), 'passes the error itself'],
    [/[{,]\s*(?:error|reason|stderr)\s*[,}]/, 'shorthand error property'],
    [new RegExp(String.raw`:\s*${ERR}\s*[,}]`), 'an error as a property value'],
    [/:\s*\w+\.(?:error|stderr)\s*[,}]/, 'another object\'s error field'],
  ];

  /** Every raw-error warn/error call in `src`, as { line, why, call }. */
  function rawErrorCalls(src) {
    const found = [];
    const re = /\blogger\.(?:warn|error)\(/g;
    let m;
    while ((m = re.exec(src))) {
      const call = src.slice(m.index, spanEnd(src, m.index + m[0].length - 1));
      const hit = RAW.find(([pattern]) => pattern.test(withoutSafeCalls(call)));
      if (hit) {
        found.push({ line: src.slice(0, m.index).split('\n').length, why: hit[1], call: call.replace(/\s+/g, ' ') });
      }
    }
    return found;
  }

  /**
   * Sites kept on purpose: file (relative to dist) and the call's text.
   */
  const ALLOWED = [
    {
      file: 'utils/logger.js', call: 'logger.error(message, error)',
      reason: 'Logger.error itself: this branch passes a metadata record; an Error is handled above it',
    },
    {
      file: 'utils/SearchCache.js', call: "logger.error('Cache export failed', { error, filePath })",
      reason: 'an Error nested in metadata serialises to {} -- nothing of it reaches the log; file outside this change',
    },
    {
      file: 'utils/SearchCache.js', call: "logger.error('Cache import failed', { error, filePath })",
      reason: 'as above',
    },
    {
      file: 'auth/AuthCache.js', call: 'auth.error',
      reason: 'AuthResult.error is a message CGMB composes; file outside this change -- follow-up',
    },
  ];

  it('finds the patterns it is meant to find', () => {
    const sample = [
      "logger.warn('a', { error: error.message });",
      "logger.error('b', error);",
      'logger.error(`c ${error}`);',
      "logger.warn('d', { error: String(err) });",
      "logger.error('e', { code, error: errorOutput });",
      "logger.error('f', { error, filePath });",
      "logger.warn('g', { error: probe.error });",
      "logger.warn('ok', { error: errorForLog(error), out: firstLineForLog(x.message) });",
      "logger.error('ok2', { note: 'error: it\\'s fine (really)', n: 1 });",
    ].join('\n');
    assert.deepEqual(rawErrorCalls(sample).map(f => f.line), [1, 2, 3, 4, 5, 6, 7]);
  });

  it('finds none in dist beyond the allow-list', () => {
    function* jsFiles(dir) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { yield* jsFiles(full); } else if (entry.name.endsWith('.js')) { yield full; }
      }
    }
    const offenders = [];
    let scanned = 0;
    for (const file of jsFiles(DIST)) {
      const rel = relative(DIST, file).split('\\').join('/');
      for (const hit of rawErrorCalls(readFileSync(file, 'utf8'))) {
        scanned += 1;
        if (!ALLOWED.some(a => a.file === rel && hit.call.includes(a.call))) {
          offenders.push(`${rel}:${hit.line} (${hit.why}): ${hit.call.slice(0, 160)}`);
        }
      }
    }
    assert.deepEqual(offenders, [], 'wrap the error in errorForLog() or the text in firstLineForLog()');
    assert.ok(scanned >= ALLOWED.length - 1, 'the allow-listed sites are still seen');
  });
});
