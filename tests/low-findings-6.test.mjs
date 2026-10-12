/**
 * Three findings from a security review of this branch.
 *
 * 1. The credential denylist matched path.basename(), which on Linux and macOS
 *    splits on `/` only: `.\.env` and `x\..\.env` were single odd names that
 *    matched nothing. The AI Studio layer then rewrote every `\` to `/` on
 *    every platform, and the sub-server opened `./.env` inside its working
 *    directory and sent it to Gemini. The denylist now takes the last segment
 *    after either separator, with the trailing dots and spaces Windows strips
 *    removed (isCredentialFileName); the layer rewrites backslashes on Windows
 *    only; and the sub-server applies the denylist again to the name it
 *    actually opens, so a spelling the first check misses is still refused.
 * 2. processMultiplePDFs stat()ed each caller path before any allowed-
 *    directories check, so a workflow step naming `\\host\share\a.pdf` or
 *    `/net/host/...` made the OS contact that host. The roots check now comes
 *    first, and only the checked realpath is stat()ed.
 * 3. The PDF URL download checked a host's addresses and then let fetch()
 *    resolve the name again, so a DNS answer that changed in between (DNS
 *    rebinding) could reach a private address. The download now uses
 *    node:http / node:https with a lookup pinned to the addresses the check
 *    approved.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { startFakeGemini } from './fixtures/fake-gemini.mjs';
import { makePdf } from './fixtures/make-pdf.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const AI_STUDIO_SERVER = join(DIST, 'mcp-servers', 'ai-studio-mcp-server.js');
const LAYER_MANAGER_URL = pathToFileURL(join(DIST, 'core', 'LayerManager.js')).href;
const FAKE_KEY = 'AIzaFakeKeyForTestsOnly000000000';
const SECRET = 'CGMB_LOW6_SECRET=never-sent';
const IS_WINDOWS = process.platform === 'win32';

const { isCredentialFileName, lastPathSegment, notReadableMessage } = await import('../dist/core/types.js');
const { assertNoCredentialFiles } = await import('../dist/core/LayerManager.js');
const {
  ADDRESS_NOT_ALLOWED,
  ALLOW_PRIVATE_URLS_ENV,
  checkHostAllowed,
  downloadPdfUrl,
  pinnedLookup,
} = await import('../dist/utils/urlDownload.js');

// realpath: on macOS tmpdir() is reached through a symlink.
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'cgmb-low6-')));
const workspace = join(scratch, 'workspace');
const outside = join(scratch, 'outside');
const childTmp = join(scratch, 'tmp');
for (const dir of [workspace, outside, childTmp]) {
  mkdirSync(dir, { recursive: true });
}
writeFileSync(join(workspace, '.env'), `${SECRET}\n`);
writeFileSync(join(workspace, 'plain.txt'), 'PLAIN-CONTENT\n');
const TEXT_PDF = makePdf(['A text layer long enough to be sent as text instead of uploaded. '.repeat(4)]);
writeFileSync(join(workspace, 'one.pdf'), TEXT_PDF);
writeFileSync(join(workspace, 'two.pdf'), TEXT_PDF);
writeFileSync(join(outside, 'a.pdf'), TEXT_PDF);
writeFileSync(join(outside, 'b.pdf'), TEXT_PDF);
// On POSIX a backslash is part of a name; Windows cannot create this file.
if (!IS_WINDOWS) {
  writeFileSync(join(workspace, 'a\\b.txt'), 'BACKSLASH-NAME-CONTENT\n');
}

/** Make a symlink; false where the platform will not (Windows without developer mode). */
function link(target, path) {
  try {
    symlinkSync(target, path);
    return true;
  } catch {
    return false;
  }
}
const symlinks = !IS_WINDOWS && link('.env', join(workspace, 'notes.txt'));
const SKIP_LINKS = !symlinks && 'symlinks unavailable on this platform';
const SKIP_POSIX = IS_WINDOWS && 'a backslash is a separator on Windows';

const savedEnv = { ...process.env };
after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

// The environment of every child below: the workspace is its cwd and only root.
function childEnv(extra = {}) {
  const env = { ...savedEnv, AI_STUDIO_API_KEY: FAKE_KEY, HOME: scratch, USERPROFILE: scratch, TMPDIR: childTmp, TMP: childTmp, TEMP: childTmp, ENABLE_CACHING: 'false', ...extra };
  for (const name of ['NODE_TEST_CONTEXT', 'LOG_LEVEL', 'CGMB_DEBUG', 'LOG_FILE', 'CGMB_ALLOWED_ROOTS', 'CGMB_CLI_MODE', 'CGMB_ENV_PATH', 'GEMINI_API_KEY', 'GOOGLE_AI_STUDIO_API_KEY', 'GEMINI_CLI_PATH', 'ANTIGRAVITY_MODEL', ALLOW_PRIVATE_URLS_ENV]) {
    delete env[name];
  }
  return env;
}

/**
 * Run LayerManager.executeWithLayer('aistudio', task) from the built dist/ in a
 * child whose cwd is the workspace -- the only allowed root, as for a real
 * server started there -- with fs.promises.stat recorded.
 */
function runLayer(task, gemini) {
  const script = `
    import fs from 'node:fs';
    const stats = [];
    const realStat = fs.promises.stat;
    fs.promises.stat = (path, ...rest) => { stats.push(String(path)); return realStat(path, ...rest); };
    const { LayerManager } = await import(${JSON.stringify(LAYER_MANAGER_URL)});
    const manager = new LayerManager();
    let outcome;
    try {
      const result = await manager.executeWithLayer('aistudio', ${JSON.stringify(task)});
      outcome = { ok: true, data: result.data };
    } catch (error) {
      outcome = { ok: false, code: error.code, message: error.message };
    }
    try { await (await manager.getAIStudioLayerAsync()).shutdown(); } catch {}
    process.stdout.write('\\nLOW6:' + JSON.stringify({ ...outcome, stats }) + '\\n');
    process.exit(0);
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      cwd: workspace,
      env: childEnv({ GOOGLE_GEMINI_BASE_URL: gemini.baseUrl }),
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
    child.on('exit', () => {
      clearTimeout(timer);
      const line = stdout.split('\n').find(l => l.startsWith('LOW6:'));
      if (!line) {
        reject(new Error(`the child gave no outcome. stderr:\n${stderr.slice(-2000)}`));
        return;
      }
      resolve(JSON.parse(line.slice('LOW6:'.length)));
    });
  });
}

// --- an MCP client over the sub-server's stdio --------------------------------------

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
      clientInfo: { name: 'low-findings-6-test', version: '1' },
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

/** Every text part of every generateContent request the fake Gemini received. */
const sentTexts = gemini => gemini.generateCalls()
  .flatMap(body => body?.contents ?? [])
  .flatMap(content => content.parts ?? [])
  .map(part => part.text ?? '');

// =====================================================================================
// 1. Separator and trailing-character spellings of a credential file
// =====================================================================================

describe('1. isCredentialFileName', () => {
  it('matches the name part after either separator, on every platform', () => {
    for (const name of [
      '.env', '.\\.env', 'x\\..\\.env', 'dir/.env', 'dir\\sub/.env', '/abs/path/.env.production',
      'C:\\Users\\me\\.ssh\\id_rsa', '\\\\host\\share\\prod.pem', 'dir/.env/',
      'secrets.json', 'prod.pem', 'credentials', '.npmrc', '.netrc',
    ]) {
      assert.equal(isCredentialFileName(name), true, `${JSON.stringify(name)} must match`);
    }
  });

  it('strips the trailing dots and spaces Windows strips when opening', () => {
    for (const name of ['.env ', '.env.', 'id_rsa.', 'id_rsa . .', 'dir\\.npmrc  ', 'secrets.json.']) {
      assert.equal(isCredentialFileName(name), true, `${JSON.stringify(name)} must match`);
    }
  });

  it('reads a name around a colon as Windows does: a drive, or a stream', () => {
    for (const name of ['C:.env', '.env::$DATA', 'dir\\id_rsa:stream']) {
      assert.equal(isCredentialFileName(name), true, `${JSON.stringify(name)} must match`);
    }
  });

  it('leaves ordinary names alone', () => {
    for (const name of ['notes.txt', 'environment.md', '.envelope', 'dir\\report.pdf', 'a\\b.txt', 'secretsmanager.ts', '', '.', '..', 'C:', 'dir/']) {
      assert.equal(isCredentialFileName(name), false, `${JSON.stringify(name)} must not match`);
    }
  });

  it('lastPathSegment splits on both separators and ignores trailing ones', () => {
    assert.equal(lastPathSegment('.\\.env'), '.env');
    assert.equal(lastPathSegment('x\\..\\.env'), '.env');
    assert.equal(lastPathSegment('a/b\\c/'), 'c');
    assert.equal(lastPathSegment('plain'), 'plain');
  });
});

describe('1. assertNoCredentialFiles refuses separator variants and names them by the name part', () => {
  for (const task of [
    { documents: ['.\\.env'] },
    { files: [{ path: 'x\\..\\.env', type: 'document' }] },
    { files: [{ path: 'notes.txt', givenPath: 'dir\\.env ', type: 'document' }] },
  ]) {
    it(JSON.stringify(task), () => {
      assert.throws(() => assertNoCredentialFiles(task), error => {
        assert.equal(error.code, 'CREDENTIAL_FILE_REFUSED');
        assert.match(error.message, /^Refusing to process \.env ?: it matches a credential file pattern/);
        assert.ok(!error.message.includes('\\'), `only the name part is shown: ${error.message}`);
        return true;
      });
    });
  }

  it('still allows ordinary names, including one with a backslash in it', () => {
    assert.doesNotThrow(() => assertNoCredentialFiles({ documents: ['dir\\report.pdf', 'a\\b.txt'] }));
  });
});

describe('1. through the built layer and sub-server, in a working directory holding .env', () => {
  let gemini;

  before(async () => { gemini = await startFakeGemini(); });
  after(async () => { await gemini?.close(); });
  beforeEach(() => { gemini.reset(); });

  for (const documents of [['.\\.env'], ['x\\..\\.env']]) {
    it(`process_documents ${JSON.stringify(documents)} is refused and nothing reaches Gemini`, async () => {
      const outcome = await runLayer({ type: 'process_documents', documents, instructions: 'Summarise' }, gemini);
      assert.equal(outcome.ok, false, JSON.stringify(outcome).slice(0, 500));
      assert.equal(outcome.code, 'CREDENTIAL_FILE_REFUSED');
      assert.match(outcome.message, /Refusing to process \.env: it matches a credential file pattern/);
      assert.deepEqual(gemini.requests, []);
    });
  }

  it('a file literally named a\\b.txt is read under that name, not rewritten to a/b.txt', { skip: SKIP_POSIX }, async () => {
    const outcome = await runLayer({ type: 'process_documents', documents: ['a\\b.txt'], instructions: 'Summarise' }, gemini);
    assert.equal(outcome.ok, true, JSON.stringify(outcome).slice(0, 500));
    const texts = sentTexts(gemini);
    assert.ok(texts.some(text => text.startsWith('Document: a\\b.txt\n') && text.includes('BACKSLASH-NAME-CONTENT')), JSON.stringify(texts));
  });
});

describe('1. the sub-server refuses a credential-shaped name itself, without LayerManager', () => {
  let gemini;
  let server;

  before(async () => {
    gemini = await startFakeGemini();
    server = await new McpChild([AI_STUDIO_SERVER], { cwd: workspace, env: childEnv({ GOOGLE_GEMINI_BASE_URL: gemini.baseUrl }) }).start();
  });
  after(async () => {
    await server?.close();
    await gemini?.close();
  });
  beforeEach(() => { gemini.reset(); });

  const REFUSED = /Refusing to process \.env: it matches a credential file pattern/;

  it('analyze_documents with a document named .env in its working directory', async () => {
    const text = errorOf(await server.call('analyze_documents', { documents: ['.env'], instructions: 'Summarise' }));
    assert.match(text ?? '', REFUSED);
    assert.ok(!(text ?? '').includes(SECRET));
    assert.deepEqual(gemini.requests, []);
  });

  it('every tool that takes a path refuses .env, given relative or absolute', async () => {
    const tools = {
      analyze_image: p => ({ imagePath: p }),
      multimodal_process: p => ({ files: [{ path: p, type: 'text' }], instructions: 'Summarise' }),
      analyze_documents: p => ({ documents: [p], instructions: 'Summarise' }),
      get_generated_file: p => ({ filePath: p, returnBase64: true }),
      get_file_info: p => ({ filePath: p }),
    };
    for (const [tool, argsFor] of Object.entries(tools)) {
      for (const path of ['.env', join(workspace, '.env')]) {
        const response = await server.call(tool, argsFor(path));
        const text = errorOf(response);
        assert.match(text ?? '', REFUSED, `${tool} ${path}: ${JSON.stringify(response).slice(0, 300)}`);
        assert.ok(!JSON.stringify(response).includes(SECRET), `${tool} returned the secret`);
      }
    }
    assert.deepEqual(gemini.requests, []);
  });

  it('a credential-shaped display name is refused even when the file is plain', async () => {
    const multimodal = errorOf(await server.call('multimodal_process', {
      files: [{ path: join(workspace, 'plain.txt'), type: 'text', displayName: '.env' }],
      instructions: 'Summarise',
    }));
    assert.match(multimodal ?? '', REFUSED);
    const documents = errorOf(await server.call('analyze_documents', {
      documents: [join(workspace, 'plain.txt')],
      display_names: ['.env'],
      instructions: 'Summarise',
    }));
    assert.match(documents ?? '', REFUSED);
    assert.deepEqual(gemini.requests, []);
  });

  it('a link to .env is refused by its realpath, and named by the name it was given', { skip: SKIP_LINKS }, async () => {
    const text = errorOf(await server.call('analyze_documents', { documents: ['notes.txt'], instructions: 'Summarise' }));
    assert.match(text ?? '', /Refusing to process notes\.txt: it matches a credential file pattern/);
    assert.ok(!(text ?? '').includes('.env'), text);
    assert.deepEqual(gemini.requests, []);
  });

  it('a .env outside the roots keeps the one not-readable refusal', async () => {
    const path = join(outside, '.env');
    const text = errorOf(await server.call('analyze_documents', { documents: [path], instructions: 'Summarise' }));
    assert.ok((text ?? '').includes(notReadableMessage(path)), text);
  });

  it('a plain file still reaches Gemini', async () => {
    const response = await server.call('analyze_documents', { documents: ['plain.txt'], instructions: 'Summarise' });
    assert.equal(errorOf(response), null, JSON.stringify(response).slice(0, 500));
    assert.ok(sentTexts(gemini).some(text => text.includes('PLAIN-CONTENT')));
  });
});

// =====================================================================================
// 2. processMultiplePDFs checks the roots before it stats
// =====================================================================================

describe('2. multiplePDFs: no stat of a path outside the allowed directories', () => {
  let gemini;

  before(async () => { gemini = await startFakeGemini(); });
  after(async () => { await gemini?.close(); });
  beforeEach(() => { gemini.reset(); });

  /** A task that takes the multiple-PDF path: an action no arm handles, two PDFs, the flag. */
  const multiplePdfTask = paths => ({
    action: 'compare_reports',
    prompt: 'Compare these two reports',
    files: paths.map(path => ({ path, type: 'pdf' })),
    options: { multiplePDFs: true },
  });

  it('two PDFs outside the roots: the not-readable refusal, no stat, nothing sent', async () => {
    const paths = [join(outside, 'a.pdf'), join(outside, 'b.pdf')];
    const outcome = await runLayer(multiplePdfTask(paths), gemini);
    assert.equal(outcome.ok, false, JSON.stringify(outcome).slice(0, 500));
    assert.ok(outcome.message.includes(notReadableMessage(paths[0])), outcome.message);
    assert.deepEqual(outcome.stats.filter(path => path.startsWith(outside)), []);
    assert.deepEqual(gemini.generateCalls(), []);
  });

  it('a //host or \\\\host path is refused without being looked at', async () => {
    const paths = ['//cgmb-low6.invalid/share/a.pdf', '\\\\cgmb-low6.invalid\\share\\b.pdf'];
    const outcome = await runLayer(multiplePdfTask(paths), gemini);
    assert.equal(outcome.ok, false, JSON.stringify(outcome).slice(0, 500));
    assert.ok(outcome.message.includes(notReadableMessage(paths[0])), outcome.message);
    assert.deepEqual(outcome.stats.filter(path => path.includes('cgmb-low6.invalid')), []);
    assert.deepEqual(gemini.generateCalls(), []);
  });

  it('two PDFs inside the roots still go through', async () => {
    const outcome = await runLayer(multiplePdfTask([join(workspace, 'one.pdf'), join(workspace, 'two.pdf')]), gemini);
    assert.equal(outcome.ok, true, JSON.stringify(outcome).slice(0, 500));
    assert.equal(gemini.generateCalls().length, 1);
    assert.ok(sentTexts(gemini).some(text => /Process these 2 PDF documents together/.test(text)));
  });
});

// =====================================================================================
// 3. The PDF URL download connects to the address it checked
// =====================================================================================

describe('3. pinnedLookup', () => {
  const pinned = pinnedLookup([
    { address: '93.184.216.34', family: 4 },
    { address: '2606:2800:220:1::1', family: 6 },
  ]);
  const ask = options => new Promise(resolve => pinned('pdf.example', options, (error, address, family) => resolve({ error, address, family })));

  it('answers all: true with every checked address', async () => {
    const { error, address } = await ask({ all: true });
    assert.equal(error, null);
    assert.deepEqual(address, [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1::1', family: 6 },
    ]);
  });

  it('answers the single-address form with the first', async () => {
    assert.deepEqual(await ask({}), { error: null, address: '93.184.216.34', family: 4 });
  });

  it('honours a requested family', async () => {
    assert.deepEqual(await ask({ family: 6 }), { error: null, address: '2606:2800:220:1::1', family: 6 });
    assert.deepEqual((await ask({ family: 4, all: true })).address, [{ address: '93.184.216.34', family: 4 }]);
    const none = await new Promise(resolve => pinnedLookup([{ address: '93.184.216.34', family: 4 }])('pdf.example', { family: 6 }, error => resolve(error)));
    assert.equal(none?.code, 'ENOTFOUND');
  });
});

describe('3. checkHostAllowed returns what it checked', () => {
  const never = async () => { throw new Error('must not be resolved'); };

  it('the resolved addresses of a name, with their families', async () => {
    const addresses = await checkHostAllowed(new URL('https://pdf.example/a.pdf'), async () => [{ address: '93.184.216.34' }, { address: '2606:2800:220:1::1' }], {});
    assert.deepEqual(addresses, [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1::1', family: 6 },
    ]);
  });

  it('a literal address as written', async () => {
    assert.deepEqual(await checkHostAllowed(new URL('http://8.8.8.8/a.pdf'), never, {}), [{ address: '8.8.8.8', family: 4 }]);
    assert.deepEqual(await checkHostAllowed(new URL('http://[2606:4700:4700::1111]/a.pdf'), never, {}), [{ address: '2606:4700:4700::1111', family: 6 }]);
  });

  it(`nothing to pin when ${ALLOW_PRIVATE_URLS_ENV}=true`, async () => {
    assert.equal(await checkHostAllowed(new URL('http://pdf.example/a.pdf'), never, { [ALLOW_PRIVATE_URLS_ENV]: 'true' }), undefined);
  });
});

describe('3. downloadPdfUrl resolves each host once, and connects there', () => {
  const PDF_BODY = '%PDF-1.4\n% low-findings-6\n%%EOF\n';
  let server;
  let port;
  const seen = [];

  before(async () => {
    server = createServer((req, res) => {
      seen.push(req.url);
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end(PDF_BODY);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });
  after(() => new Promise(resolve => server.close(resolve)));
  beforeEach(() => {
    delete process.env[ALLOW_PRIVATE_URLS_ENV];
    seen.length = 0;
  });
  after(() => {
    if (savedEnv[ALLOW_PRIVATE_URLS_ENV] === undefined) {
      delete process.env[ALLOW_PRIVATE_URLS_ENV];
    } else {
      process.env[ALLOW_PRIVATE_URLS_ENV] = savedEnv[ALLOW_PRIVATE_URLS_ENV];
    }
  });

  /** A lookup that answers `address` for every name and counts its calls. */
  function counting(address) {
    const lookup = async () => { lookup.calls += 1; return [{ address, family: address.includes(':') ? 6 : 4 }]; };
    lookup.calls = 0;
    return lookup;
  }

  it('a name answering a loopback address is refused, and nothing is requested', async () => {
    const lookup = counting('127.0.0.1');
    const url = `http://pdf.invalid:${port}/report.pdf`;
    await assert.rejects(downloadPdfUrl(url, undefined, lookup), { message: `Could not fetch ${url}: ${ADDRESS_NOT_ALLOWED}` });
    assert.equal(lookup.calls, 1);
    assert.deepEqual(seen, []);
  });

  it('a name answering a public address is resolved once, and the connection goes to that address', async () => {
    // pdf.invalid can never resolve through the system: a connection that
    // looked the name up again would fail with ENOTFOUND. 192.0.2.1
    // (TEST-NET-1) passes the check and is not reachable, so the request
    // fails or times out connecting -- to the checked address.
    const lookup = counting('192.0.2.1');
    const url = 'http://pdf.invalid/report.pdf';
    const error = await downloadPdfUrl(url, { maxBytes: 1024, timeoutMs: 1500, maxRedirects: 0 }, lookup).then(() => null, e => e);
    assert.ok(error, 'the download cannot succeed');
    assert.equal(lookup.calls, 1, 'the injected lookup is consulted once for the one hop');
    assert.ok(error.message.startsWith(`Could not fetch ${url}: `), error.message);
    assert.doesNotMatch(error.message, /ENOTFOUND|EAI_AGAIN|getaddrinfo|could not be resolved|not allowed|fetch failed/);
  });

  it(`with ${ALLOW_PRIVATE_URLS_ENV}=true the system lookup runs and the download works`, async () => {
    process.env[ALLOW_PRIVATE_URLS_ENV] = 'true';
    const lookup = counting('192.0.2.1');
    const pdf = await downloadPdfUrl(`http://localhost:${port}/report.pdf`, undefined, lookup);
    try {
      assert.equal(lookup.calls, 0, 'nothing is checked, so nothing is pinned');
      assert.deepEqual(seen, ['/report.pdf']);
      assert.equal(pdf.bytes, PDF_BODY.length);
    } finally {
      await pdf.cleanup();
    }
  });
});
