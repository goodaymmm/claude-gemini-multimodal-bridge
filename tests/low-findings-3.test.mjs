/**
 * The five low-severity findings of the roots pass.
 *
 * 1. The main server's `cgmb` tool ran existsSync / statSync / accessSync on any
 *    path before the roots were consulted, and its messages differed ("File not
 *    found" with the resolved path and the working directory, "Not a file",
 *    "Permission denied"). It now asks checkAgainstRoots first, gives the
 *    sub-server's one refusal for every path outside, and names neither the
 *    resolved path nor the working directory.
 * 2. A link inside a root to a directory outside answered
 *    `<root>/link/existing` with the refusal and `<root>/link/missing` with "not
 *    found". A path that does not resolve now counts as outside when the part
 *    of it that exists leads outside.
 * 3. Credential labels: `Authorization: Basic`, quoted JSON keys and form-style
 *    `password=` / `secret=` are redacted too.
 * 4. Claude routing resolved the same path twice (canInlineForClaude, then
 *    inlineCodeFiles); the file read is now the one that was checked.
 * 5. An inside-looking path reaching outside reported its errno (ELOOP,
 *    EACCES); by item 2's rule it is now the refusal, while a path that really
 *    is inside keeps its code.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createCliStubs, readCalls, startRoutingGemini } from './fixtures/routing-stubs.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'dist', 'cli.js');
const AI_STUDIO_SERVER = join(ROOT, 'dist', 'mcp-servers', 'ai-studio-mcp-server.js');
const FAKE_KEY = 'AIzaFakeKeyForTestsOnly000000000';
const SENTINEL = 'SENTINEL-ROOTS-PASS-CONTENT';

// realpath: on macOS tmpdir() is reached through a symlink.
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'cgmb-low3-')));
const workspace = join(scratch, 'workspace');
const outside = join(scratch, 'outside');
const childTmp = join(scratch, 'tmp');
const stubDir = join(scratch, 'stubs');
for (const dir of [workspace, join(workspace, 'sub'), outside, join(outside, 'dir'), childTmp, stubDir]) {
  mkdirSync(dir, { recursive: true });
}
writeFileSync(join(workspace, 'notes.txt'), 'inside the workspace\n');
writeFileSync(join(outside, 'secret.txt'), `${SENTINEL}\n`);
writeFileSync(join(outside, 'dir', 'existing.txt'), `${SENTINEL}\n`);
writeFileSync(join(workspace, 'a.ts'), 'export const fromA = "A-CONTENT";\n');
writeFileSync(join(workspace, 'b.ts'), 'export const fromB = "B-CONTENT";\n');
writeFileSync(join(outside, 'target.ts'), `export const s = "${SENTINEL}";\n`);

/** Make a symlink; false where the platform will not (Windows without developer mode). */
function link(target, path) {
  try {
    symlinkSync(target, path);
    return true;
  } catch {
    return false;
  }
}

// The link layouts these findings are about. Symlinks are POSIX-shaped here;
// on Windows they need elevation, and the Windows path handling is covered by
// the tests that do not use them.
const symlinks = process.platform !== 'win32' && [
  link(join(outside, 'dir'), join(workspace, 'link')),                     // a directory outside
  link(join(outside, 'nothing.txt'), join(workspace, 'dangling.txt')),     // a dangling link
  link('loop-b.txt', join(workspace, 'loop-a.txt')),                       // a loop, inside
  link('loop-a.txt', join(workspace, 'loop-b.txt')),
  link(join(outside, 'loop-x.txt'), join(workspace, 'out-loop.txt')),      // a loop, first link outside
  link('loop-y.txt', join(outside, 'loop-x.txt')),
  link('loop-x.txt', join(outside, 'loop-y.txt')),
  link('loop-x.txt', join(outside, 'dir', 'loop-x.txt')),                  // a loop behind the directory link
  link('loop-x.txt', join(outside, 'dir', 'loop-y.txt')),
].every(Boolean);
const SKIP_LINKS = !symlinks && 'symlinks unavailable on this platform';

// The in-process half: what LayerManager reads. Set before it is imported.
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
const { checkAgainstRoots, notReadableMessage, redactUrls } = await import('../dist/core/types.js');

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
      clientInfo: { name: 'low-findings-3-test', version: '1' },
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

const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The roots of every server below: the workspace, which is its cwd, and nothing else.
function childEnv(extra = {}) {
  const env = { ...savedEnv, AI_STUDIO_API_KEY: FAKE_KEY, HOME: scratch, USERPROFILE: scratch, TMPDIR: childTmp, TMP: childTmp, TEMP: childTmp, ENABLE_CACHING: 'false', ...extra };
  for (const name of ['NODE_TEST_CONTEXT', 'LOG_LEVEL', 'CGMB_DEBUG', 'LOG_FILE', 'CGMB_ALLOWED_ROOTS', 'CGMB_CLI_MODE', 'CGMB_ENV_PATH', 'GEMINI_API_KEY', 'GOOGLE_AI_STUDIO_API_KEY', 'GEMINI_CLI_PATH', 'ANTIGRAVITY_MODEL']) {
    delete env[name];
  }
  return env;
}

// =====================================================================================
// 1, 2 and 5 through the main server's `cgmb` tool
// =====================================================================================

describe('1. the main server checks the roots before it looks at a path', { skip: process.platform === 'win32' && 'the layer stand-ins are POSIX shims' }, () => {
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

  /** The `cgmb` tool's answer for one attached file, and the layers it reached. */
  async function attach(path, extra = {}) {
    const mark = readCalls(stubs.logPath).length;
    const response = await server.call('cgmb', { prompt: 'Summarise this file', files: [{ path, type: 'text' }], ...extra });
    const calls = readCalls(stubs.logPath).slice(mark).filter(entry => entry.kind !== 'probe');
    return { response, text: errorOf(response), calls };
  }

  it('gives an existing and a missing file outside the roots the identical refusal, naming neither the realpath nor cwd', async () => {
    const probe = join(outside, 'probe-main.txt');
    const missing = await attach(probe);
    writeFileSync(probe, `${SENTINEL}\n`);
    const existing = await attach(probe);

    assert.ok(missing.text, `refused: ${JSON.stringify(missing.response).slice(0, 300)}`);
    assert.equal(existing.text, missing.text);
    assert.deepEqual(existing.response, { ...missing.response, id: existing.response.id });
    assert.match(missing.text, new RegExp(escape(notReadableMessage(probe))));
    for (const result of [missing, existing]) {
      assert.deepEqual(result.calls, [], 'no layer was reached');
      const whole = JSON.stringify(result.response);
      assert.ok(!whole.includes(SENTINEL));
      assert.ok(!whole.includes(workspace), `the working directory is not named: ${whole}`);
      assert.doesNotMatch(whole, /Resolved|Working directory|Current directory/);
    }
  });

  it('refuses `..` out of the roots by the name it was given, without the realpath', async () => {
    const existing = await attach('../outside/secret.txt');
    const missing = await attach('../outside/no-such.txt');
    assert.match(existing.text, /File is not readable: \.\.\/outside\/secret\.txt\. It is outside every allowed directory/);
    assert.equal(missing.text, existing.text.replaceAll('secret.txt', 'no-such.txt'));
    for (const result of [existing, missing]) {
      assert.ok(!result.text.includes(scratch), `no absolute path: ${result.text}`);
    }
  });

  it('a workingDirectory outside the roots does not make a path inside them', async () => {
    const existing = await attach('secret.txt', { workingDirectory: outside });
    const missing = await attach('no-such.txt', { workingDirectory: outside });
    assert.match(existing.text, /File is not readable: secret\.txt\./);
    assert.equal(missing.text, existing.text.replaceAll('secret.txt', 'no-such.txt'));
    assert.ok(!existing.text.includes(outside));
  });

  it('still says "not found" for a missing file inside the roots, without the resolved path or cwd', async () => {
    const result = await attach('sub/missing.txt');
    assert.match(result.text, /File not found: sub\/missing\.txt/);
    assert.ok(!result.text.includes(workspace), result.text);
    assert.doesNotMatch(result.text, /Resolved|Working directory|Current directory/);
    assert.deepEqual(result.calls, []);
  });

  it('says "Not a file" for a directory inside the roots', async () => {
    const result = await attach('sub');
    assert.match(result.text, /Not a file: sub\b/);
    assert.ok(!result.text.includes(workspace), result.text);
  });

  it('a path in the prompt outside the roots is not attached, whether or not it exists', async () => {
    const mention = join(outside, 'mentioned.txt');
    const ask = async () => {
      const mark = readCalls(stubs.logPath).length;
      const response = await server.call('cgmb', { prompt: `What is in ${mention}?` });
      return { response, calls: readCalls(stubs.logPath).slice(mark).filter(entry => entry.kind !== 'probe') };
    };
    const missing = await ask();
    writeFileSync(mention, `${SENTINEL}\n`);
    const existing = await ask();

    const layers = result => result.calls.map(entry => `${entry.layer}:${entry.kind}`);
    assert.deepEqual(layers(existing), layers(missing));
    assert.ok(!existing.calls.some(entry => entry.kind === 'upload'), 'nothing was uploaded');
    assert.ok(!JSON.stringify(existing.calls).includes(SENTINEL), 'no layer was given its content');
    assert.ok(!JSON.stringify(existing).includes(SENTINEL));
    assert.equal(errorOf(existing.response), errorOf(missing.response));
  });

  describe('2 and 5. links out of the roots', { skip: SKIP_LINKS }, () => {
    it('gives <root>/link/existing and <root>/link/missing the identical refusal', async () => {
      const existing = await attach('link/existing.txt');
      const missing = await attach('link/missing.txt');
      assert.match(existing.text, /File is not readable: link\/existing\.txt\. It is outside every allowed directory/);
      assert.equal(missing.text, existing.text.replaceAll('existing.txt', 'missing.txt'));
      for (const result of [existing, missing]) {
        assert.ok(!result.text.includes(outside), `the link's target is not named: ${result.text}`);
        assert.deepEqual(result.calls, []);
      }
    });

    it('refuses a dangling link inside the root the same way', async () => {
      const dangling = await attach('dangling.txt');
      const missing = await attach('link/missing.txt');
      assert.equal(dangling.text, missing.text.replaceAll('link/missing.txt', 'dangling.txt'));
    });

    it('keeps the code for a loop inside the roots', async () => {
      const result = await attach('loop-a.txt');
      assert.match(result.text, /Cannot resolve loop-a\.txt: ELOOP/);
    });

    it('refuses a loop whose first link is outside, and one behind a link to outside', async () => {
      const reference = (await attach('link/missing.txt')).text;
      for (const path of ['out-loop.txt', 'link/loop-x.txt']) {
        const result = await attach(path);
        assert.equal(result.text, reference.replaceAll('link/missing.txt', path), path);
        assert.doesNotMatch(result.text, /ELOOP/);
      }
    });
  });
});

// =====================================================================================
// 2 and 5 through the AI Studio sub-server
// =====================================================================================

describe('2 and 5. the sub-server: what the part of a path that exists leads to', { skip: SKIP_LINKS }, () => {
  let server;

  before(async () => {
    server = await new McpChild([AI_STUDIO_SERVER], { cwd: workspace, env: childEnv({ GOOGLE_GEMINI_BASE_URL: 'http://127.0.0.1:9' }) }).start();
  });
  after(async () => {
    await server?.close();
  });

  const info = async filePath => errorOf(await server.call('get_file_info', { filePath }));

  it('refuses <root>/link/existing and <root>/link/missing identically, and a dangling link', async () => {
    const existing = await info(join(workspace, 'link', 'existing.txt'));
    const missing = await info(join(workspace, 'link', 'missing.txt'));
    const dangling = await info(join(workspace, 'dangling.txt'));
    assert.match(existing, /File is not readable: /);
    assert.equal(missing, existing.replaceAll('existing.txt', 'missing.txt'));
    assert.equal(dangling, existing.replaceAll(join('link', 'existing.txt'), 'dangling.txt'));
  });

  it('still reports a missing file under a real subdirectory of the root', async () => {
    assert.match(await info(join(workspace, 'sub', 'missing.txt')), /File not found: /);
  });

  it('keeps ELOOP for a loop inside, and refuses one that starts outside', async () => {
    assert.match(await info(join(workspace, 'loop-a.txt')), /Cannot resolve .*loop-a\.txt: ELOOP/);
    for (const path of [join(workspace, 'out-loop.txt'), join(workspace, 'link', 'loop-x.txt')]) {
      const message = await info(path);
      assert.match(message, /File is not readable: /, path);
      assert.doesNotMatch(message, /ELOOP/);
    }
  });
});

describe('2 and 5. checkAgainstRoots', { skip: SKIP_LINKS }, () => {
  const roots = { real: [workspace], given: [workspace] };
  const verdict = path => checkAgainstRoots(join(workspace, path), roots);

  it('calls a missing path behind a link to outside outside, like an existing one', () => {
    assert.deepEqual(verdict('link/existing.txt'), { kind: 'outside' });
    assert.deepEqual(verdict('link/missing.txt'), { kind: 'outside' });
    assert.deepEqual(verdict('link/no/such/dir/missing.txt'), { kind: 'outside' });
    assert.deepEqual(verdict('dangling.txt'), { kind: 'outside' });
  });

  it('keeps missing and inside for paths that are inside', () => {
    assert.deepEqual(verdict('sub/missing.txt'), { kind: 'missing' });
    assert.deepEqual(verdict('no/such/dir/missing.txt'), { kind: 'missing' });
    assert.deepEqual(verdict('notes.txt/child'), { kind: 'missing' });
    assert.deepEqual(verdict('notes.txt'), { kind: 'inside', resolved: join(workspace, 'notes.txt') });
  });

  it('reports ELOOP only when the loop is inside', () => {
    assert.deepEqual(verdict('loop-a.txt'), { kind: 'error', code: 'ELOOP' });
    assert.deepEqual(verdict('out-loop.txt'), { kind: 'outside' });
    assert.deepEqual(verdict('link/loop-x.txt'), { kind: 'outside' });
  });
});

// =====================================================================================
// 3. Credential labels
// =====================================================================================

describe('3. redactUrls: the new credential labels', () => {
  it('keeps the label and drops the value', () => {
    const cases = [
      ['Authorization: Basic dXNlcjpwYXNzd29yZA==', 'Authorization: Basic …'],
      ['authorization: basic dXNlcjpw', 'authorization: basic …'],
      ['Proxy-Authorization: Basic dXNlcjpwYXNz', 'Proxy-Authorization: Basic …'],
      ['{"Authorization": "Basic dXNlcjpwYXNz"}', '{"Authorization": "Basic …"}'],
      ['{"key": "AIzaSyD-SECRET-VALUE"}', '{"key": "…"}'],
      ['{"secret":"s3cr3t","n":1}', '{"secret":"…","n":1}'],
      ['{"password": "hunter2"}', '{"password": "…"}'],
      ['{"PASSWORD": "hunter2"}', '{"PASSWORD": "…"}'],
      ["{'passwd': 'hunter2'}", "{'passwd': '…'}"],
      ['{"client_secret": "GOCSPX-abc"}', '{"client_secret": "…"}'],
      ['{"access_token": "short"}', '{"access_token": "…"}'],
      ['{"refresh_token": "1//0gabc"}', '{"refresh_token": "…"}'],
      ['{"password": "a\\"b", "n": 1}', '{"password": "…", "n": 1}'],
      [JSON.stringify(JSON.stringify({ password: 'hunter2', n: 1 })), JSON.stringify(JSON.stringify({ password: '…', n: 1 }))],
      ['user=a&password=hunter2&x=1', 'user=a&password=…&x=1'],
      ['PASSWD=abc', 'PASSWD=…'],
      ['grant_type=x&client_secret=GOCSPX-abc&y=2', 'grant_type=x&client_secret=…&y=2'],
      ['secret=abc;next=1', 'secret=…;next=1'],
      ['db_password=xyz', 'db_password=…'],
    ];
    for (const [input, expected] of cases) {
      assert.equal(redactUrls(input), expected, input);
      assert.equal(redactUrls(expected), expected, `idempotent: ${expected}`);
    }
  });

  it('leaves the words that look like these labels alone', () => {
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

// =====================================================================================
// 4. Claude routing reads the file it checked
// =====================================================================================

describe('4. inlineCodeFiles reads exactly what canInlineForClaude validated', () => {
  it('returns the realpaths it checked, and null for a file outside the roots', () => {
    const manager = new LayerManager();
    assert.deepEqual(manager.canInlineForClaude([{ path: join(workspace, 'a.ts'), type: 'code' }]), [join(workspace, 'a.ts')]);
    assert.equal(manager.canInlineForClaude([{ path: join(outside, 'target.ts'), type: 'code' }]), null);
    assert.equal(manager.canInlineForClaude([{ path: join(workspace, 'missing.ts'), type: 'code' }]), null);
  });

  it('reads the validated path even when the name now points elsewhere', { skip: SKIP_LINKS }, async () => {
    const manager = new LayerManager();
    const swap = join(workspace, 'swap.ts');
    symlinkSync('a.ts', swap);
    try {
      const resolved = manager.canInlineForClaude([{ path: swap, type: 'code' }]);
      assert.deepEqual(resolved, [join(workspace, 'a.ts')]);

      // The name is repointed between the check and the read.
      unlinkSync(swap);
      symlinkSync(join(outside, 'target.ts'), swap);

      const inlined = await manager.inlineCodeFiles('Review this.', resolved);
      assert.match(inlined, /A-CONTENT/);
      assert.ok(inlined.includes(`File: ${join(workspace, 'a.ts')}`));
      assert.ok(!inlined.includes(SENTINEL));
    } finally {
      unlinkSync(swap);
    }
  });

  it('re-checks the resolved paths against the roots', async () => {
    const manager = new LayerManager();
    await assert.rejects(manager.inlineCodeFiles('Review this.', [join(outside, 'target.ts')]), /cannot read files/);
  });

  it('sends Claude the content of the file it validated', async () => {
    const manager = new LayerManager();
    let prompt;
    const claude = {
      initialize: async () => {},
      isAvailable: async () => true,
      execute: async task => {
        prompt = task.prompt;
        return { success: true, data: 'ok', metadata: { layer: 'claude', duration: 1 } };
      },
    };
    manager.claudeLayer = claude;
    manager.claudeLayerPromise = Promise.resolve(claude);
    manager.layerInitialized.claude = true;

    const result = await manager.executeCodeFilesOnClaudeDirect({ prompt: 'Review this.', files: [{ path: join(workspace, 'b.ts'), type: 'code' }] });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.match(prompt, /B-CONTENT/);
    assert.ok(prompt.includes(`File: ${join(workspace, 'b.ts')}`));
  });
});
