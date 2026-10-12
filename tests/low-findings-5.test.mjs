/**
 * Four low-severity findings: the last log and name items.
 *
 * 1. Image generation with a non-English prompt and no translation printed
 *    "Translation unavailable" with console.log -- onto the MCP server's
 *    stdout, which is its JSON-RPC channel. It goes to stderr now, and a static
 *    guard keeps every module `cgmb serve` and the AI Studio server load off
 *    stdout.
 * 2. The AI Studio server took a file's MIME type from its display name after
 *    cutting it to 200 characters for the log, so a long name lost its
 *    extension. The type is read from the name whole.
 * 3. The credential denylist saw only the name as given on every tool but
 *    `cgmb` (the only one that resolves a file and passes `givenPath`): a link
 *    `notes.txt -> .env` passed cgmb_multimodal_process and
 *    cgmb_document_analysis. It now also checks the basename of the realpath,
 *    and those tools refuse before any layer is asked.
 * 4. `cgmb aistudio -f` called the AI Studio layer itself, past the denylist
 *    LayerManager applies. It now checks the files first.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { makePdf } from './fixtures/make-pdf.mjs';
import { createCliStubs, readCalls, startRoutingGemini } from './fixtures/routing-stubs.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const CLI = join(DIST, 'cli.js');
const AI_STUDIO_SERVER = join(DIST, 'mcp-servers', 'ai-studio-mcp-server.js');
const FAKE_KEY = 'AIzaFakeKeyForTestsOnly000000000';
const SECRET = 'CGMB_LOW5_SECRET=never-sent';

// realpath: on macOS tmpdir() is reached through a symlink.
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'cgmb-low5-')));
const workspace = join(scratch, 'workspace');
const childTmp = join(scratch, 'tmp');
const stubDir = join(scratch, 'stubs');
for (const dir of [workspace, join(workspace, 'real'), childTmp, stubDir]) {
  mkdirSync(dir, { recursive: true });
}
writeFileSync(join(workspace, '.env'), `${SECRET}\n`);
writeFileSync(join(workspace, 'plain.txt'), 'PLAIN-CONTENT\n');
// A PDF whose own name does not say so: only the name it is shown by does.
writeFileSync(join(workspace, 'real', 'paper.bin'), makePdf(['A text layer long enough to be sent as text instead of uploaded. '.repeat(4)]));

/** Make a symlink; false where the platform will not (Windows without developer mode). */
function link(target, path) {
  try {
    symlinkSync(target, path);
    return true;
  } catch {
    return false;
  }
}
const symlinks = process.platform !== 'win32' && link('.env', join(workspace, 'notes.txt'));
const SKIP_LINKS = !symlinks && 'symlinks unavailable on this platform';
const SKIP_SHIMS = process.platform === 'win32' && 'the layer stand-ins are POSIX shims';

const savedEnv = { ...process.env };
after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

// The environment of every child below: the workspace is its cwd and only root.
function childEnv(extra = {}) {
  const env = { ...savedEnv, AI_STUDIO_API_KEY: FAKE_KEY, HOME: scratch, USERPROFILE: scratch, TMPDIR: childTmp, TMP: childTmp, TEMP: childTmp, ENABLE_CACHING: 'false', ...extra };
  for (const name of ['NODE_TEST_CONTEXT', 'LOG_LEVEL', 'CGMB_DEBUG', 'LOG_FILE', 'CGMB_ALLOWED_ROOTS', 'CGMB_CLI_MODE', 'CGMB_ENV_PATH', 'GEMINI_API_KEY', 'GOOGLE_AI_STUDIO_API_KEY', 'GEMINI_CLI_PATH', 'ANTIGRAVITY_MODEL']) {
    delete env[name];
  }
  return env;
}

// --- an MCP client over a real server's stdio, keeping every stdout line ---------

class McpChild {
  constructor(argv, { cwd, env }) {
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = '';
    this.stdoutLines = [];
    this.child = spawn(process.execPath, argv, { cwd, env, windowsHide: true });
    this.exited = new Promise(resolve => this.child.on('exit', resolve));
    let buffered = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => {
      buffered += chunk;
      let brk;
      while ((brk = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, brk);
        buffered = buffered.slice(brk + 1);
        this.stdoutLines.push(line);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        this.pending.get(message.id)?.(message);
        this.pending.delete(message.id);
      }
    });
    this.child.stdout.on('end', () => { if (buffered) { this.stdoutLines.push(buffered); } });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', chunk => { this.stderr += chunk; });
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`no answer to ${method} within 90s. stderr:\n${this.stderr.slice(-1500)}`));
      }, 90000);
      this.pending.set(id, message => { clearTimeout(timer); resolve(message); });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  async start() {
    const init = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'low-findings-5-test', version: '1' },
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

/** The error text of a tools/call response, or null when it succeeded. */
const errorOf = response => response.error?.message
  ?? (response.result?.isError ? response.result.content.map(part => part.text ?? '').join('\n') : null);

/** Run the CLI to completion without blocking this process (the stand-ins live in it). */
function runCli(args, env) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: workspace, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
    child.on('exit', status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

// =====================================================================================
// 1. Nothing but JSON-RPC on the servers' stdout
// =====================================================================================

describe('1. no module the MCP servers load writes to stdout', () => {
  // Every module `cgmb serve` (dist/cli.js) and the AI Studio server load lives
  // in these directories, plus cli.js itself.
  const SCANNED_DIRS = ['core', 'layers', 'mcp-servers', 'utils', 'auth', 'tools'];
  const STDOUT_WRITE = /\bconsole\.(?:log|info|debug)\(|\bprocess\.stdout\.write\(/g;

  /** Kept on purpose: never run by either server. */
  const ALLOWED = [
    {
      file: 'auth/InteractiveSetup.js',
      reason: 'the `cgmb setup` wizard talks to a terminal; only cli.js imports it, and only the setup command runs it',
    },
    {
      file: 'cli.js',
      except: 'serve',
      reason: 'the one-shot commands (chat, analyze, aistudio, ...) print their answers to stdout; the serve action must not, and is checked below',
    },
  ];

  function* jsFiles(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { yield* jsFiles(full); } else if (entry.name.endsWith('.js')) { yield full; }
    }
  }

  /** Line numbers of every stdout write in `src`. */
  function stdoutWrites(src) {
    const lines = [];
    STDOUT_WRITE.lastIndex = 0;
    let m;
    while ((m = STDOUT_WRITE.exec(src))) {
      lines.push(src.slice(0, m.index).split('\n').length);
    }
    return lines;
  }

  it('finds the patterns it is meant to find', () => {
    const sample = [
      "console.log('a');",
      "console.info('b');",
      "console.debug('c');",
      "process.stdout.write('d');",
      "console.error('fine');",
      "console.warn('fine');",
      "logger.info('fine');",
    ].join('\n');
    assert.deepEqual(stdoutWrites(sample), [1, 2, 3, 4]);
  });

  it('finds none outside the allow-list', () => {
    const offenders = [];
    const seen = new Map();
    const files = [CLI, ...SCANNED_DIRS.flatMap(dir => [...jsFiles(join(DIST, dir))])];
    for (const file of files) {
      const rel = relative(DIST, file).split('\\').join('/');
      const hits = stdoutWrites(readFileSync(file, 'utf8'));
      seen.set(rel, hits.length);
      if (hits.length > 0 && !ALLOWED.some(a => a.file === rel)) {
        offenders.push(`${rel}: lines ${hits.join(', ')}`);
      }
    }
    assert.deepEqual(offenders, [], 'write to stderr (console.error) or the logger: stdout is the MCP JSON-RPC channel');
    // The allow-list is not stale: each entry still has writes to excuse.
    for (const entry of ALLOWED) {
      assert.ok((seen.get(entry.file) ?? 0) > 0, `${entry.file} has no stdout writes left; drop it from the allow-list`);
    }
  });

  it('the serve action in cli.js writes nothing to stdout', () => {
    const src = readFileSync(CLI, 'utf8');
    const start = src.indexOf(".command('serve')");
    assert.ok(start >= 0, 'serve command not found in dist/cli.js');
    const end = src.indexOf('.command(', start + 1);
    assert.ok(end > start, 'no command after serve');
    assert.deepEqual(stdoutWrites(src.slice(start, end)), []);
  });

  it('the allow-listed setup wizard is imported by cli.js alone', () => {
    const importers = [CLI, ...SCANNED_DIRS.flatMap(dir => [...jsFiles(join(DIST, dir))])]
      .filter(file => /\bfrom\s+['"][^'"]*InteractiveSetup\.js['"]|import\(\s*['"][^'"]*InteractiveSetup\.js['"]/.test(readFileSync(file, 'utf8')))
      .map(file => relative(DIST, file).split('\\').join('/'));
    assert.deepEqual(importers, ['cli.js']);
  });
});

describe('1. cgmb serve: a Japanese image prompt with no translation keeps stdout JSON-RPC', { skip: SKIP_SHIMS }, () => {
  let stubs;
  let gemini;
  let server;

  before(async () => {
    mkdirSync(join(stubDir, 'serve-ja'), { recursive: true });
    stubs = createCliStubs(join(stubDir, 'serve-ja'));
    // The Antigravity CLI answers its probes but fails every request: the
    // translation step throws, and generation goes on in Japanese.
    stubs.setFailing('antigravity', true);
    gemini = await startRoutingGemini(stubs.logPath);
    server = await new McpChild([CLI, 'serve'], {
      cwd: workspace,
      env: childEnv({
        GOOGLE_GEMINI_BASE_URL: gemini.baseUrl,
        ANTIGRAVITY_CLI_PATH: stubs.agyPath,
        CLAUDE_CODE_PATH: stubs.claudePath,
      }),
    }).start();
  });
  after(async () => {
    await server?.close();
    await gemini?.close();
  });

  it('generates the image, says so on stderr, and writes only JSON-RPC lines to stdout', async () => {
    const mark = readCalls(stubs.logPath).length;
    const prompt = '夕焼けの海辺を歩く猫の画像を生成してください';
    const response = await server.call('cgmb', { prompt });
    const calls = readCalls(stubs.logPath).slice(mark).filter(entry => entry.kind !== 'probe');

    // Translation was attempted and failed ...
    assert.ok(calls.some(entry => entry.layer === 'antigravity' && entry.failed), JSON.stringify(calls));
    assert.match(server.stderr, /Translation unavailable\. Continuing with image generation in the input language\./);
    // ... and the image was asked for in the input language.
    const images = calls.filter(entry => entry.layer === 'aistudio' && entry.kind === 'call' && /-image/.test(entry.model ?? ''));
    assert.equal(images.length, 1, JSON.stringify(calls));
    assert.ok(images[0].promptHead.includes('猫'), images[0].promptHead);
    assert.equal(errorOf(response), null, JSON.stringify(response).slice(0, 500));

    // Every line the server wrote to stdout is a JSON-RPC message.
    assert.ok(server.stdoutLines.length >= 2, 'initialize and the call were answered');
    for (const line of server.stdoutLines) {
      if (line.trim() === '') { continue; }
      let message;
      assert.doesNotThrow(() => { message = JSON.parse(line); }, `not JSON on stdout: ${line.slice(0, 200)}`);
      assert.equal(message.jsonrpc, '2.0', line.slice(0, 200));
    }
  });
});

// =====================================================================================
// 2. The MIME type of a long display name
// =====================================================================================

describe('2. a display name over 200 characters keeps its extension for the type', { skip: SKIP_SHIMS }, () => {
  const pdf = join(workspace, 'real', 'paper.bin');
  // Long enough that the 200-character log form ends inside the name, before ".pdf".
  const longName = join(workspace, `${'a'.repeat(260)}.pdf`);
  let stubs;
  let gemini;
  let server;

  before(async () => {
    mkdirSync(join(stubDir, 'long-name'), { recursive: true });
    stubs = createCliStubs(join(stubDir, 'long-name'));
    gemini = await startRoutingGemini(stubs.logPath);
    server = await new McpChild([AI_STUDIO_SERVER], { cwd: workspace, env: childEnv({ GOOGLE_GEMINI_BASE_URL: gemini.baseUrl }) }).start();
  });
  after(async () => {
    await server?.close();
    await gemini?.close();
  });

  it('multimodal_process: the PDF path is taken (metadata.pdfs, stderr)', async () => {
    const before = server.stderr.length;
    const outcome = await server.call('multimodal_process', {
      files: [{ path: pdf, type: 'document', displayName: longName }],
      instructions: 'Summarise',
      pdf_mode: 'local',
    });
    assert.equal(errorOf(outcome), null, JSON.stringify(outcome).slice(0, 500));
    const stderr = server.stderr.slice(before);
    assert.match(stderr, /File detected as MIME type: application\/pdf/);
    assert.deepEqual(outcome.result.metadata.pdfs.map(p => p.sent_as), ['text']);
    // The display form is still the capped one.
    assert.ok(!stderr.includes('a'.repeat(250)), 'the log line is capped');
  });

  it('analyze_documents: the same for display_names', async () => {
    const before = server.stderr.length;
    const outcome = await server.call('analyze_documents', {
      documents: [pdf],
      display_names: [longName],
      instructions: 'Summarise',
      pdf_mode: 'local',
    });
    assert.equal(errorOf(outcome), null, JSON.stringify(outcome).slice(0, 500));
    assert.match(server.stderr.slice(before), /Document detected as MIME type: application\/pdf/);
    assert.deepEqual(outcome.result.metadata.pdfs.map(p => p.sent_as), ['text']);
  });

  it('without a display name the real name still decides', async () => {
    const before = server.stderr.length;
    const outcome = await server.call('multimodal_process', {
      files: [{ path: join(workspace, 'plain.txt'), type: 'text' }],
      instructions: 'Summarise',
    });
    assert.equal(errorOf(outcome), null);
    assert.match(server.stderr.slice(before), /File detected as MIME type: text\/plain/);
  });
});

// =====================================================================================
// 3. The denylist sees where a link points, on every tool
// =====================================================================================

describe('3. assertNoCredentialFiles checks the realpath\'s name too', { skip: SKIP_LINKS }, () => {
  it('refuses a harmless name that resolves to a credential file, given relative or absolute', async () => {
    const { assertNoCredentialFiles } = await import('../dist/core/LayerManager.js');
    for (const task of [
      { files: [{ path: join(workspace, 'notes.txt'), type: 'document' }] },
      { documents: [join(workspace, 'notes.txt')] },
    ]) {
      assert.throws(() => assertNoCredentialFiles(task), error => {
        assert.equal(error.code, 'CREDENTIAL_FILE_REFUSED');
        return true;
      });
    }
  });

  it('judges a path that does not resolve by its given name alone', async () => {
    const { assertNoCredentialFiles } = await import('../dist/core/LayerManager.js');
    assert.doesNotThrow(() => assertNoCredentialFiles({ files: [{ path: join(workspace, 'missing.txt'), type: 'document' }] }));
    assert.doesNotThrow(() => assertNoCredentialFiles({ files: [{ path: 'https://example.com/.env/report.pdf', type: 'pdf' }] }));
    assert.doesNotThrow(() => assertNoCredentialFiles({ files: [{ path: join(workspace, 'plain.txt'), type: 'document' }] }));
    assert.throws(() => assertNoCredentialFiles({ files: [{ path: join(workspace, 'gone', '.env'), type: 'document' }] }), /credential file pattern/);
  });

  it('keeps checking givenPath as before', async () => {
    const { assertNoCredentialFiles } = await import('../dist/core/LayerManager.js');
    assert.throws(() => assertNoCredentialFiles({ files: [{ path: join(workspace, 'plain.txt'), givenPath: join(workspace, '.env'), type: 'document' }] }), /credential file pattern/);
  });

  it('a workflow refuses before its first step', async () => {
    const { LayerManager } = await import('../dist/core/LayerManager.js');
    const manager = new LayerManager();
    let stepsRun = 0;
    manager.executeWithLayer = async () => { stepsRun += 1; return { success: true, data: 'x', metadata: { layer: 'claude', duration: 0 } }; };
    await assert.rejects(
      manager.executeWorkflow(
        { steps: [{ id: 'one', layer: 'claude', action: 'analyze', input: {} }] },
        { files: [{ path: join(workspace, 'notes.txt'), type: 'document' }] },
        { executionMode: 'sequential' }
      ),
      error => error.code === 'CREDENTIAL_FILE_REFUSED'
    );
    assert.equal(stepsRun, 0);
  });
});

describe('3. cgmb serve: notes.txt -> .env is refused on cgmb_multimodal_process and cgmb_document_analysis', { skip: SKIP_SHIMS || SKIP_LINKS }, () => {
  let stubs;
  let gemini;
  let server;

  before(async () => {
    mkdirSync(join(stubDir, 'serve-link'), { recursive: true });
    stubs = createCliStubs(join(stubDir, 'serve-link'));
    gemini = await startRoutingGemini(stubs.logPath);
    server = await new McpChild([CLI, 'serve'], {
      cwd: workspace,
      env: childEnv({
        GOOGLE_GEMINI_BASE_URL: gemini.baseUrl,
        ANTIGRAVITY_CLI_PATH: stubs.agyPath,
        CLAUDE_CODE_PATH: stubs.claudePath,
      }),
    }).start();
  });
  after(async () => {
    await server?.close();
    await gemini?.close();
  });

  async function callTool(name, args) {
    const mark = readCalls(stubs.logPath).length;
    const response = await server.call(name, args);
    const calls = readCalls(stubs.logPath).slice(mark).filter(entry => entry.kind !== 'probe');
    return { response, text: errorOf(response), calls };
  }

  const cases = file => [
    ['cgmb_multimodal_process', { prompt: 'Summarise this file', files: [{ path: file, type: 'document' }], workflow: 'analysis' }],
    ['cgmb_document_analysis', { documents: [file], analysis_type: 'summary' }],
  ];

  for (const [name, args] of cases('notes.txt')) {
    it(`${name}: refused with CREDENTIAL_FILE_REFUSED, no layer called`, async () => {
      const result = await callTool(name, args);
      assert.match(result.text ?? '', /\(CREDENTIAL_FILE_REFUSED\): Refusing to process \.env: it matches a credential file pattern/, JSON.stringify(result.response).slice(0, 500));
      assert.deepEqual(result.calls, [], 'no layer was asked');
    });
  }

  for (const [name, args] of cases(join(workspace, 'notes.txt'))) {
    it(`${name}: the same given as an absolute path`, async () => {
      const result = await callTool(name, args);
      assert.match(result.text ?? '', /CREDENTIAL_FILE_REFUSED/);
      assert.deepEqual(result.calls, []);
    });
  }

  for (const [name, args] of cases('plain.txt')) {
    it(`${name}: a plain file still passes`, async () => {
      const result = await callTool(name, args);
      assert.equal(result.text, null, JSON.stringify(result.response).slice(0, 500));
      assert.ok(result.calls.some(entry => entry.layer === 'aistudio' && entry.kind === 'call'), JSON.stringify(result.calls));
      for (const entry of result.calls) {
        assert.ok(!(entry.promptHead ?? '').includes(SECRET), 'the credential file never went out');
      }
    });
  }
});

// =====================================================================================
// 4. The CLI's own layer calls
// =====================================================================================

describe('4. the CLI applies the denylist before any request', { skip: SKIP_SHIMS }, () => {
  let stubs;
  let gemini;
  let env;

  before(async () => {
    mkdirSync(join(stubDir, 'cli'), { recursive: true });
    stubs = createCliStubs(join(stubDir, 'cli'));
    gemini = await startRoutingGemini(stubs.logPath);
    env = childEnv({
      GOOGLE_GEMINI_BASE_URL: gemini.baseUrl,
      ANTIGRAVITY_CLI_PATH: stubs.agyPath,
      CLAUDE_CODE_PATH: stubs.claudePath,
    });
  });
  after(async () => {
    await gemini?.close();
  });

  async function run(args) {
    const mark = readCalls(stubs.logPath).length;
    const result = await runCli(args, env);
    return { ...result, calls: readCalls(stubs.logPath).slice(mark) };
  }

  it('cgmb aistudio -f .env exits non-zero with the credential message; nothing is sent', async () => {
    const result = await run(['aistudio', '-p', 'Summarise this file', '-f', '.env']);
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /Refusing to process \.env: it matches a credential file pattern/);
    // Not even the key probe: the layer was never started.
    assert.deepEqual(result.calls, []);
  });

  it('cgmb aistudio -f notes.txt (a link to .env) is refused the same way', { skip: SKIP_LINKS }, async () => {
    const result = await run(['aistudio', '-p', 'Summarise this file', '-f', 'plain.txt', 'notes.txt']);
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /Refusing to process \.env: it matches a credential file pattern/);
    assert.deepEqual(result.calls, []);
  });

  it('cgmb analyze notes.txt (through LayerManager) is refused too', { skip: SKIP_LINKS }, async () => {
    const result = await run(['analyze', 'notes.txt']);
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stdout + result.stderr, /credential file pattern/);
    assert.deepEqual(result.calls.filter(entry => entry.kind !== 'probe'), []);
  });

  it('cgmb aistudio -f plain.txt still reaches Gemini', async () => {
    const result = await run(['aistudio', '-p', 'Summarise this file', '-f', 'plain.txt']);
    assert.equal(result.status, 0, result.stderr.slice(-1500));
    const sent = result.calls.filter(entry => entry.layer === 'aistudio' && entry.kind === 'call');
    assert.equal(sent.length, 1, JSON.stringify(result.calls));
    assert.match(sent[0].promptHead, /PLAIN-CONTENT/);
  });
});
