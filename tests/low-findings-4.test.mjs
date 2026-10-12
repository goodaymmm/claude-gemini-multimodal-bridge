/**
 * The last four low-severity findings of the roots pass.
 *
 * 1. The main server checked the realpath of an attached file but handed the
 *    layers the lexical path, which they resolved again. It now attaches the
 *    realpath it checked, and keeps the path as given (`givenPath`) for names.
 * 2. leadsOutside followed a link's target lexically: under a parent that is
 *    itself a link (`dirA -> real/a`), `..` in the target climbed from dirA
 *    rather than from real/a, so a target inside the roots could be judged
 *    outside. The target is now resolved against the parent's realpath.
 * 3. A quoted credential value inside an escaped JSON string stopped at the
 *    escaped quote in the value (`\"a\\\"b\"`), leaving the rest of it in the
 *    log; the value now runs to the first unescaped closing quote.
 * 4. The Claude layer's inlined `File:` header and its "not a text file" error
 *    named the realpath of a file given through a link; they name the path as
 *    given.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { makePdf } from './fixtures/make-pdf.mjs';
import { createCliStubs, readCalls, startRoutingGemini } from './fixtures/routing-stubs.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'dist', 'cli.js');
const AI_STUDIO_SERVER = join(ROOT, 'dist', 'mcp-servers', 'ai-studio-mcp-server.js');
const FAKE_KEY = 'AIzaFakeKeyForTestsOnly000000000';

// realpath: on macOS tmpdir() is reached through a symlink.
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'cgmb-low4-')));
const workspace = join(scratch, 'workspace');
const outside = join(scratch, 'outside');
const childTmp = join(scratch, 'tmp');
const stubDir = join(scratch, 'stubs');
for (const dir of [
  workspace, join(workspace, 'real', 'a'), join(workspace, 'real', 'b'),
  outside, join(outside, 'a'), join(outside, 'b'), childTmp, stubDir,
]) {
  mkdirSync(dir, { recursive: true });
}
writeFileSync(join(workspace, 'real', 'target.txt'), 'TARGET-CONTENT\n');
writeFileSync(join(workspace, 'real', 'impl.ts'), 'export const impl = "IMPL-CONTENT";\n');
writeFileSync(join(workspace, 'real', 'blob-impl.ts'), Buffer.from([0x65, 0x78, 0x00, 0x01, 0x02, 0x0a]));
writeFileSync(join(workspace, 'real', 'b', 'file.txt'), 'B-FILE\n');
writeFileSync(join(outside, 'b', 'file.txt'), 'OUTSIDE-B-FILE\n');

/** Make a symlink; false where the platform will not (Windows without developer mode). */
function link(target, path) {
  try {
    symlinkSync(target, path);
    return true;
  } catch {
    return false;
  }
}

const symlinks = process.platform !== 'win32' && [
  // 1 and 4: links inside the roots to files inside the roots.
  link('real/target.txt', join(workspace, 'alias.txt')),
  link('real/impl.ts', join(workspace, 'alias.ts')),
  link('real/blob-impl.ts', join(workspace, 'blob.ts')),
  // 2: a parent that is a link inside the roots, and links under it whose `..`
  // means something else from dirA than from real/a.
  link('real/a', join(workspace, 'dirA')),
  link('../b/file.txt', join(workspace, 'real', 'a', 'link')),           // real/b/file.txt
  link('../../c', join(workspace, 'real', 'a', 'up')),                   // <ws>/c; lexically <scratch>/c
  link('../../real/a/loop2', join(workspace, 'real', 'a', 'loop1')),     // a loop inside; lexically outside
  link('loop1', join(workspace, 'real', 'a', 'loop2')),
  link('../../../outside/b/file.txt', join(workspace, 'real', 'a', 'outlink')),
  link('../../../outside/gone', join(workspace, 'real', 'a', 'outdir')),
  // ... and a parent that is a link to outside, whose `..` lexically stays inside.
  link('../outside/a', join(workspace, 'dirB')),
  link('../b/file.txt', join(outside, 'a', 'link')),                     // <outside>/b/file.txt; lexically <ws>/b/file.txt
  link('../gone', join(outside, 'a', 'gone')),
].every(Boolean);
const SKIP_LINKS = !symlinks && 'symlinks unavailable on this platform';

const savedEnv = { ...process.env };
Object.assign(process.env, {
  AI_STUDIO_API_KEY: FAKE_KEY,
  CGMB_ALLOWED_ROOTS: workspace,
  ENABLE_CACHING: 'false',
  HOME: scratch,
  USERPROFILE: scratch,
  TMPDIR: childTmp,
  TMP: childTmp,
  TEMP: childTmp,
});
for (const name of ['LOG_FILE', 'LOG_LEVEL', 'CGMB_DEBUG']) {
  delete process.env[name];
}

const { LayerManager } = await import('../dist/core/LayerManager.js');
const { AIStudioLayer } = await import('../dist/layers/AIStudioLayer.js');
const { checkAgainstRoots, redactUrls } = await import('../dist/core/types.js');

after(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) { delete process.env[key]; }
  }
  Object.assign(process.env, savedEnv);
  rmSync(scratch, { recursive: true, force: true });
});

// --- an MCP client over a real server's stdio -----------------------------------

class McpChild {
  constructor(argv, { cwd, env }) {
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = '';
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
        reject(new Error(`no answer to ${method} within 60s. stderr:\n${this.stderr.slice(-1500)}`));
      }, 60000);
      this.pending.set(id, message => { clearTimeout(timer); resolve(message); });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  async start() {
    const init = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'low-findings-4-test', version: '1' },
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

// The roots of every server below: the workspace, which is its cwd, and nothing else.
function childEnv(extra = {}) {
  const env = { ...savedEnv, AI_STUDIO_API_KEY: FAKE_KEY, HOME: scratch, USERPROFILE: scratch, TMPDIR: childTmp, TMP: childTmp, TEMP: childTmp, ENABLE_CACHING: 'false', ...extra };
  for (const name of ['NODE_TEST_CONTEXT', 'LOG_LEVEL', 'CGMB_DEBUG', 'LOG_FILE', 'CGMB_ALLOWED_ROOTS', 'CGMB_CLI_MODE', 'CGMB_ENV_PATH', 'GEMINI_API_KEY', 'GOOGLE_AI_STUDIO_API_KEY', 'GEMINI_CLI_PATH', 'ANTIGRAVITY_MODEL']) {
    delete env[name];
  }
  return env;
}

// =====================================================================================
// 1 and 4 through the main server's `cgmb` tool
// =====================================================================================

describe('1 and 4. the main server attaches the realpath it checked, and names the file as given', { skip: (process.platform === 'win32' && 'the layer stand-ins are POSIX shims') || SKIP_LINKS }, () => {
  let stubs;
  let gemini;
  let server;

  before(async () => {
    stubs = createCliStubs(stubDir);
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

  /** The `cgmb` tool's answer for one attached file, and the layer calls it made. */
  async function attach(prompt, path) {
    const mark = readCalls(stubs.logPath).length;
    const response = await server.call('cgmb', { prompt, files: [{ path, type: 'text' }] });
    const calls = readCalls(stubs.logPath).slice(mark).filter(entry => entry.kind !== 'probe');
    return { response, text: errorOf(response), calls };
  }

  it('1. a link inside the roots to a file inside them: the target is read, the model sees the name as given', async () => {
    const result = await attach('Summarise this file', 'alias.txt');
    assert.equal(result.text, null, JSON.stringify(result.response).slice(0, 500));
    const sent = result.calls.filter(entry => entry.layer === 'aistudio' && entry.kind === 'call');
    assert.equal(sent.length, 1, JSON.stringify(result.calls));
    // The realpath was read (its content went out) ...
    assert.match(sent[0].promptHead, /TARGET-CONTENT/);
    // ... and the file is named as given, in the prompt and in the answer.
    assert.ok(sent[0].promptHead.includes(`File: ${join(workspace, 'alias.txt')}\n`), sent[0].promptHead);
    assert.ok(!sent[0].promptHead.includes(join('real', 'target.txt')), sent[0].promptHead);
    assert.ok(!JSON.stringify(result.response).includes(join('real', 'target.txt')));
  });

  it('4. the Claude prompt heads the file with its name as given, not its realpath', async () => {
    const result = await attach('Review this code for bugs', 'alias.ts');
    assert.equal(result.text, null, JSON.stringify(result.response).slice(0, 500));
    const sent = result.calls.filter(entry => entry.layer === 'claude');
    assert.equal(sent.length, 1, JSON.stringify(result.calls));
    assert.ok(sent[0].promptHead.includes(`File: ${join(workspace, 'alias.ts')}\n`), sent[0].promptHead);
    assert.ok(!sent[0].promptHead.includes('impl.ts'), sent[0].promptHead);
    assert.match(sent[0].promptHead, /IMPL-CONTENT/, 'the content read is the realpath\'s');
  });

  it('4. "not a text file" names the link, not the file it points to', async () => {
    const result = await attach('Review this code for bugs', 'blob.ts');
    assert.match(result.text, /\bblob\.ts is not a text file; the Claude layer reads source code only\./);
    assert.ok(!result.text.includes('blob-impl'), result.text);
    assert.ok(!result.text.includes(workspace), result.text);
    assert.deepEqual(result.calls, [], 'nothing was sent');
  });
});

// =====================================================================================
// 1. The AI Studio layer and sub-server read `path` and show `givenPath`
// =====================================================================================

describe('1. AI Studio reads the realpath and shows the name as given', { skip: (process.platform === 'win32' && 'the layer stand-ins are POSIX shims') || SKIP_LINKS }, () => {
  const alias = join(workspace, 'alias.txt');
  const real = join(workspace, 'real', 'target.txt');
  const pdfAlias = join(workspace, 'paper-alias.pdf');
  const pdfReal = join(workspace, 'real', 'paper.pdf');
  let stubs;
  let gemini;
  let server;
  let layer;

  before(async () => {
    writeFileSync(pdfReal, makePdf(['A text layer long enough to be sent as text instead of uploaded. '.repeat(4)]));
    symlinkSync('real/paper.pdf', pdfAlias);
    mkdirSync(join(stubDir, 'aistudio'), { recursive: true });
    stubs = createCliStubs(join(stubDir, 'aistudio'));
    gemini = await startRoutingGemini(stubs.logPath);
    server = await new McpChild([AI_STUDIO_SERVER], { cwd: workspace, env: childEnv({ GOOGLE_GEMINI_BASE_URL: gemini.baseUrl }) }).start();
    // The in-process layer spawns its own sub-server from this environment.
    process.env.GOOGLE_GEMINI_BASE_URL = gemini.baseUrl;
    layer = new AIStudioLayer();
    layer.isInitialized = true;
  });
  after(async () => {
    await layer?.shutdown();
    delete process.env.GOOGLE_GEMINI_BASE_URL;
    await server?.close();
    await gemini?.close();
  });

  /** What one call sent Gemini (the text parts, as the stand-in logs them). */
  async function sentBy(call) {
    const mark = readCalls(stubs.logPath).length;
    const outcome = await call();
    const sent = readCalls(stubs.logPath).slice(mark).filter(entry => entry.kind === 'call');
    assert.equal(sent.length, 1, JSON.stringify(sent));
    return { outcome, promptHead: sent[0].promptHead };
  }

  it('the sub-server: multimodal_process names a file by displayName and reads path', async () => {
    const { outcome, promptHead } = await sentBy(() => server.call('multimodal_process', {
      files: [{ path: real, type: 'text', displayName: alias }],
      instructions: 'Summarise',
    }));
    assert.equal(errorOf(outcome), null);
    assert.ok(promptHead.includes(`File: ${alias}\n`), promptHead);
    assert.ok(!promptHead.includes(join('real', 'target.txt')), promptHead);
    assert.match(promptHead, /TARGET-CONTENT/);
  });

  it('the sub-server: without displayName the file is named by its path, as before', async () => {
    const { promptHead } = await sentBy(() => server.call('multimodal_process', {
      files: [{ path: real, type: 'text' }],
      instructions: 'Summarise',
    }));
    assert.ok(promptHead.includes(`File: ${real}\n`), promptHead);
  });

  it('the sub-server: analyze_documents names each document by display_names', async () => {
    const { outcome, promptHead } = await sentBy(() => server.call('analyze_documents', {
      documents: [real],
      display_names: [alias],
      instructions: 'Summarise',
    }));
    assert.equal(errorOf(outcome), null);
    assert.ok(promptHead.includes(`Document: ${alias}\n`), promptHead);
    assert.ok(!promptHead.includes(join('real', 'target.txt')), promptHead);
    assert.match(promptHead, /TARGET-CONTENT/);
  });

  it('the sub-server: metadata.pdfs names a PDF by displayName, sent as text or uploaded', async () => {
    for (const pdf_mode of ['local', 'upload']) {
      const { outcome } = await sentBy(() => server.call('multimodal_process', {
        files: [{ path: pdfReal, type: 'pdf', displayName: pdfAlias }],
        instructions: 'Summarise',
        pdf_mode,
      }));
      assert.equal(errorOf(outcome), null, JSON.stringify(outcome));
      const whole = JSON.stringify(outcome.result);
      assert.deepEqual(outcome.result.metadata.pdfs.map(p => [p.file, p.sent_as]), [['paper-alias.pdf', pdf_mode === 'local' ? 'text' : 'upload']]);
      assert.ok(!whole.includes('paper.pdf'), whole);
    }
  });

  it('the layer: files_processed and the prompt name the file as given; the realpath is read', async () => {
    const { outcome, promptHead } = await sentBy(() =>
      layer.processMultimodal([{ path: real, givenPath: alias, type: 'text' }], 'Summarise'));
    assert.deepEqual(outcome.files_processed, [alias]);
    assert.ok(promptHead.includes(`File: ${alias}\n`), promptHead);
    assert.ok(!promptHead.includes(join('real', 'target.txt')), promptHead);
    assert.match(promptHead, /TARGET-CONTENT/);
  });

  it('the layer: document analysis passes the names as given alongside the paths', async () => {
    const { outcome, promptHead } = await sentBy(() => layer.execute({
      action: 'process_documents',
      instructions: 'Summarise',
      files: [{ path: real, givenPath: alias, type: 'document' }],
    }));
    assert.equal(outcome.success, true, JSON.stringify(outcome));
    assert.ok(promptHead.includes(`Document: ${alias}\n`), promptHead);
    assert.ok(!promptHead.includes(join('real', 'target.txt')), promptHead);
  });
});

// =====================================================================================
// 4 in process: what inlineCodeFiles names
// =====================================================================================

describe('4. inlineCodeFiles names each file as the caller gave it', { skip: SKIP_LINKS }, () => {
  /** A LayerManager whose Claude layer records the prompt it is given. */
  function managerRecordingClaude() {
    const manager = new LayerManager();
    const seen = { prompt: undefined };
    const claude = {
      initialize: async () => {},
      isAvailable: async () => true,
      execute: async task => {
        seen.prompt = task.prompt;
        return { success: true, data: 'ok', metadata: { layer: 'claude', duration: 1 } };
      },
    };
    manager.claudeLayer = claude;
    manager.claudeLayerPromise = Promise.resolve(claude);
    manager.layerInitialized.claude = true;
    return { manager, seen };
  }

  it('a link inside the roots: the header is the link, the content the target\'s', async () => {
    const { manager, seen } = managerRecordingClaude();
    const alias = join(workspace, 'alias.ts');
    const result = await manager.executeCodeFilesOnClaudeDirect({ prompt: 'Review this.', files: [{ path: alias, type: 'code' }] });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.ok(seen.prompt.includes(`File: ${alias}\n`), seen.prompt);
    assert.ok(!seen.prompt.includes('impl.ts'), seen.prompt);
    assert.match(seen.prompt, /IMPL-CONTENT/);
  });

  it('a file the main server resolved: the header is givenPath, the file read is path', async () => {
    const { manager, seen } = managerRecordingClaude();
    const alias = join(workspace, 'alias.ts');
    const result = await manager.executeCodeFilesOnClaudeDirect({
      prompt: 'Review this.',
      files: [{ path: join(workspace, 'real', 'impl.ts'), givenPath: alias, type: 'code' }],
    });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.ok(seen.prompt.includes(`File: ${alias}\n`), seen.prompt);
    assert.ok(!seen.prompt.includes('impl.ts'), seen.prompt);
    assert.match(seen.prompt, /IMPL-CONTENT/);
  });

  it('a binary file through a link: the error names the link only', async () => {
    const { manager, seen } = managerRecordingClaude();
    await assert.rejects(
      manager.executeCodeFilesOnClaudeDirect({ prompt: 'Review this.', files: [{ path: join(workspace, 'blob.ts'), type: 'code' }] }),
      error => {
        assert.equal(error.message, 'blob.ts is not a text file; the Claude layer reads source code only.');
        return true;
      }
    );
    assert.equal(seen.prompt, undefined, 'Claude was not asked');
  });
});

// =====================================================================================
// 2. A link's target is resolved from where the link really is
// =====================================================================================

describe('2. checkAgainstRoots: `..` in a link target under a linked parent', { skip: SKIP_LINKS }, () => {
  const roots = { real: [workspace], given: [workspace] };
  const verdict = path => checkAgainstRoots(join(workspace, path), roots);

  it('dirA/link -> ../b/file.txt is real/b/file.txt, inside', () => {
    assert.deepEqual(verdict('dirA/link'), { kind: 'inside', resolved: join(workspace, 'real', 'b', 'file.txt') });
  });

  it('a target that climbs out of the roots from dirA but not from real/a is judged by where it lands', () => {
    // dirA/up -> ../../c: from real/a that is <workspace>/c, which does not
    // exist yet; from dirA it was <scratch>/c, outside, and refused.
    assert.deepEqual(verdict('dirA/up/new.txt'), { kind: 'missing' });
    mkdirSync(join(workspace, 'c'));
    writeFileSync(join(workspace, 'c', 'file.txt'), 'C-FILE\n');
    try {
      assert.deepEqual(verdict('dirA/up/file.txt'), { kind: 'inside', resolved: join(workspace, 'c', 'file.txt') });
      assert.deepEqual(verdict('dirA/up/new.txt'), { kind: 'missing' });
    } finally {
      rmSync(join(workspace, 'c'), { recursive: true, force: true });
    }
  });

  it('keeps the code for a loop that is inside, though its target climbs out from dirA', () => {
    assert.deepEqual(verdict('dirA/loop1'), { kind: 'error', code: 'ELOOP' });
  });

  it('still refuses a target that lands outside, existing or not', () => {
    assert.deepEqual(verdict('dirA/outlink'), { kind: 'outside' });
    assert.deepEqual(verdict('dirA/outdir'), { kind: 'outside' });
    assert.deepEqual(verdict('dirA/outdir/new.txt'), { kind: 'outside' });
  });

  it('a parent linked outside: `..` that lexically stays inside is outside, existing or not', () => {
    // dirB -> ../outside/a; dirB/link -> ../b/file.txt is <outside>/b/file.txt,
    // though from dirB it reads as <workspace>/b/file.txt.
    assert.deepEqual(verdict('dirB/link'), { kind: 'outside' });
    assert.deepEqual(verdict('dirB/gone'), { kind: 'outside' });
    assert.deepEqual(verdict('dirB/gone/new.txt'), { kind: 'outside' });
  });
});

// =====================================================================================
// 3. A quoted value ends at its first unescaped closing quote
// =====================================================================================

describe('3. redactUrls: escaped quotes inside a quoted value', () => {
  it('redacts only the value, up to its closing quote', () => {
    const cases = [
      [String.raw`"password": "a\"b", "next": "visible"`, String.raw`"password": "…", "next": "visible"`],
      [String.raw`{"secret": "x\\", "next": "visible"}`, String.raw`{"secret": "…", "next": "visible"}`],
      [String.raw`'password': 'a\'b', 'next': 'visible'`, String.raw`'password': '…', 'next': 'visible'`],
      [String.raw`{'passwd': 'it\'s', 'next': 'visible'}`, String.raw`{'passwd': '…', 'next': 'visible'}`],
      // Inside a JSON string: the value's own quote is \\\" there.
      [String.raw`{\"password\": \"a\\\"b\", \"next\": \"visible\"}`, String.raw`{\"password\": \"…\", \"next\": \"visible\"}`],
      [String.raw`{\"secret\": \"x\\\\\", \"next\": \"visible\"}`, String.raw`{\"secret\": \"…\", \"next\": \"visible\"}`],
      [String.raw`{\'password\': \'a\\\'b\', \'next\': \'visible\'}`, String.raw`{\'password\': \'…\', \'next\': \'visible\'}`],
      [JSON.stringify(JSON.stringify({ password: 'a"b', next: 'visible' })), JSON.stringify(JSON.stringify({ password: '…', next: 'visible' }))],
      [JSON.stringify(JSON.stringify({ secret: 'a\\b\nc', next: 'visible' })), JSON.stringify(JSON.stringify({ secret: '…', next: 'visible' }))],
    ];
    for (const [input, expected] of cases) {
      assert.equal(redactUrls(input), expected, input);
      assert.equal(redactUrls(expected), expected, `idempotent: ${expected}`);
    }
  });

  it('an unterminated value is redacted to the end of the line, without throwing', () => {
    assert.equal(redactUrls('"password": "abc'), '"password": "…');
    assert.equal(redactUrls(String.raw`"password": "a\"bc`), '"password": "…');
    assert.equal(redactUrls(String.raw`{\"password\": \"a\\\"bc`), String.raw`{\"password\": \"…`);
    assert.equal(redactUrls('"password": "abc\nnext line'), '"password": "…\nnext line');
    assert.doesNotThrow(() => redactUrls('"password": "abc\\'));
    assert.doesNotThrow(() => redactUrls('{\\"password\\": \\"abc\\'));
  });

  it('still leaves the lines that only look like labels alone', () => {
    for (const text of [
      '"keyboard": "us"',
      '{"keys": "abc"}',
      '"key": 3',
      '{"key":""}',
      'secretary',
      'the secretary=Jane',
      'the secret is out',
      'password policy: 12 chars',
      'password reset requested',
      'basic auth is disabled',
      'Basic dXNlcjpwYXNz',
      'WWW-Authenticate: Basic realm="api"',
      'Authorization: Basic',
      'password=',
    ]) {
      assert.equal(redactUrls(text), text, text);
    }
  });
});
