/**
 * Stand-ins for the three layers, for tests that need to see which layer a
 * request reached.
 *
 * Every stand-in appends one JSON line per invocation to the same call log, so
 * the order of the lines is the order in which the layers were reached:
 *
 *   - `agy`    a node script behind a shell shim (ANTIGRAVITY_CLI_PATH). The
 *              layer gives it an allow-listed environment and an empty scratch
 *              cwd, so it is steered by files next to it, not by env vars.
 *   - `claude` the same shape (CLAUDE_CODE_PATH). It must live outside the
 *              server's cwd: resolveTrustedCommand refuses candidates there.
 *   - Gemini   an HTTP server for GOOGLE_GEMINI_BASE_URL, which the AI Studio
 *              MCP sub-server's @google/genai client honours. Unlike
 *              fake-gemini.mjs it also answers image generation and TTS with
 *              inline data, and can be told to fail.
 *
 * Probes (`--version`, `agy models`, `claude auth status`, the key check's
 * models.get) are logged with kind 'probe' so a test can tell "the layer was
 * checked" from "the layer was asked".
 *
 * The Gemini stand-in also serves files under /files/ (see `host`), standing in
 * for the web servers PDF URLs point at; those requests are logged with kind
 * 'fetch'.
 */
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

export const AGY_ANSWER = 'stub agy answer';
export const CLAUDE_ANSWER = 'stub claude answer';
export const GEMINI_ANSWER = 'stub gemini answer';

/** A 1x1 transparent PNG. */
export const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

/** A valid 16-bit mono WAV holding `samples` silent samples at 24 kHz. */
export function tinyWav(samples = 2400) {
  const data = Buffer.alloc(samples * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24);
  header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const isWindows = process.platform === 'win32';

function writeShim(dir, name, scriptPath) {
  // process.execPath, not a bare `node`: the agy child gets an allow-listed
  // PATH, and a shim resolving the interpreter through it can miss.
  if (!isWindows) {
    const shPath = join(dir, name);
    writeFileSync(shPath, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`, { mode: 0o755 });
    return shPath;
  }
  const cmdPath = join(dir, `${name}.cmd`);
  writeFileSync(cmdPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`, 'utf8');
  return cmdPath;
}

/**
 * Body shared by both CLI stubs. `layer` names the log entries, `failFlag` is
 * the file whose existence makes a real call exit 1, and `probe(argv)` returns
 * the stdout for a probe or null for a real call.
 */
function cliStubSource({ layer, logPath, failFlag, answer, probes }) {
  return `
import { appendFileSync, existsSync } from 'node:fs';
const argv = process.argv.slice(2);
const log = entry => appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ layer: ${JSON.stringify(layer)}, at: Date.now(), argv, ...entry }) + '\\n');
const probes = ${probes};
const probeOut = probes(argv);
if (probeOut !== null) {
  log({ kind: 'probe' });
  process.stdout.write(probeOut + '\\n');
  process.exit(0);
}
const chunks = [];
process.stdin.on('data', c => chunks.push(c));
process.stdin.on('end', () => {
  const prompt = Buffer.concat(chunks).toString('utf8');
  const failed = existsSync(${JSON.stringify(failFlag)});
  log({ kind: 'call', failed, promptHead: prompt.slice(0, 300), promptLength: prompt.length });
  if (failed) {
    process.stderr.write(${JSON.stringify(`${layer} stub: forced failure`)} + '\\n');
    process.exit(1);
  }
  process.stdout.write(${JSON.stringify(answer)} + '\\n');
  process.exit(0);
});
`;
}

/**
 * Create the agy and claude stubs in `dir` (which must be outside the server's
 * cwd) and return their paths plus helpers over the shared call log.
 */
export function createCliStubs(dir) {
  const logPath = join(dir, 'calls.jsonl');
  writeFileSync(logPath, '');
  const agyFail = join(dir, 'agy.fail');
  const claudeFail = join(dir, 'claude.fail');

  const agyScript = join(dir, 'agy-stub.mjs');
  writeFileSync(agyScript, cliStubSource({
    layer: 'antigravity',
    logPath,
    failFlag: agyFail,
    answer: AGY_ANSWER,
    // `agy --version` must clear MIN_AGY_VERSION; `agy models` must list
    // something for the auth probe to call the session authenticated.
    probes: `a => a.includes('--version') ? '1.3.3' : a[0] === 'models' ? 'gemini-3.6-flash-low\\ngemini-3.6-flash-high' : null`,
  }));

  const claudeScript = join(dir, 'claude-stub.mjs');
  writeFileSync(claudeScript, cliStubSource({
    layer: 'claude',
    logPath,
    failFlag: claudeFail,
    answer: CLAUDE_ANSWER,
    // CLAUDE_STUB_SIGNED_OUT=1 in the environment of the process that probes
    // makes `claude auth status` report signed out: Claude Code installed but
    // not usable, which is how the layer reads "not available".
    probes: `a => a.includes('--version') ? '9.9.9 (Claude Code stub)' : a.includes('--help') ? 'Usage: claude [options]' : a[0] === 'auth' ? JSON.stringify({ loggedIn: process.env.CLAUDE_STUB_SIGNED_OUT !== '1' }) : null`,
  }));

  const flagFor = layer => ({ antigravity: agyFail, claude: claudeFail })[layer];

  return {
    logPath,
    agyPath: writeShim(dir, 'agy', agyScript),
    claudePath: writeShim(dir, 'claude', claudeScript),
    /** Make the stub for `layer` exit 1 on real calls (probes still succeed). */
    setFailing(layer, failing) {
      const flag = flagFor(layer);
      if (failing) { writeFileSync(flag, ''); } else if (existsSync(flag)) { rmSync(flag); }
    },
  };
}

/** Parse the call log. */
export function readCalls(logPath) {
  return readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

/**
 * A Gemini API stand-in that logs to the same call log.
 *
 * generateContent is answered by model: an `-image` model gets an inline PNG,
 * a `-tts` model inline 16-bit PCM, anything else GEMINI_ANSWER as text.
 */
export async function startRoutingGemini(logPath) {
  let failing = false;
  let uploads = 0;
  /** path -> { status, headers, body } served for GET /files/... */
  const hosted = new Map();

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      let body = null;
      try { body = JSON.parse(raw.toString('utf8')); } catch { /* upload bytes */ }
      const { port } = server.address();
      const url = req.url ?? '';
      const model = /\/models\/([^:?/]+)/.exec(url)?.[1] ?? null;
      const log = entry => appendFileSync(logPath, JSON.stringify({ layer: 'aistudio', at: Date.now(), method: req.method, path: url.split('?')[0], model, ...entry }) + '\n');
      const json = (status, payload, headers = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(payload));
      };
      const text = (body?.contents ?? []).flatMap(c => c.parts ?? []).map(p => p.text ?? (p.fileData ? `[fileData ${p.fileData.fileUri}]` : p.inlineData ? `[inlineData ${p.inlineData.mimeType}]` : '')).join(' | ');

      if (req.method === 'GET' && url.startsWith('/files/')) {
        const file = hosted.get(url.split('?')[0]);
        log({ kind: 'fetch', status: file?.status ?? 404 });
        if (!file) {
          res.writeHead(404, { 'content-type': 'text/plain' });
          return res.end('not found');
        }
        res.writeHead(file.status ?? 200, file.headers ?? {});
        // A file that announces more than it sends stays open: the client has
        // to give up on the header, not on a short body.
        if (file.hang) { res.write(file.body ?? ''); return undefined; }
        return res.end(file.body ?? '');
      }
      if (req.method === 'GET' && url.includes('/models/')) {
        log({ kind: 'probe' });
        return json(200, { name: `models/${model}`, displayName: model });
      }
      if (failing) {
        log({ kind: 'call', failed: true, promptHead: text.slice(0, 300) });
        return json(400, { error: { code: 400, message: 'routing stub: forced failure', status: 'INVALID_ARGUMENT' } });
      }
      if (req.method === 'POST' && url.startsWith('/upload/')) {
        uploads += 1;
        log({ kind: 'upload' });
        return json(200, {}, { 'x-goog-upload-url': `http://127.0.0.1:${port}/upload-session/${uploads}` });
      }
      if (req.method === 'POST' && url.startsWith('/upload-session/')) {
        const id = url.split('/').pop();
        return json(200, {
          file: { name: `files/stub-${id}`, uri: `https://generativelanguage.googleapis.com/v1beta/files/stub-${id}`, mimeType: 'application/pdf', state: 'ACTIVE' },
        }, { 'x-goog-upload-status': 'final' });
      }
      if (req.method === 'POST' && url.includes(':generateContent')) {
        log({ kind: 'call', promptHead: text.slice(0, 300) });
        let parts = [{ text: GEMINI_ANSWER }];
        if (model && /-image/.test(model)) {
          parts = [{ text: 'here is the image' }, { inlineData: { mimeType: 'image/png', data: TINY_PNG.toString('base64') } }];
        } else if (model && /-tts/.test(model)) {
          parts = [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: Buffer.alloc(4800).toString('base64') } }];
        }
        return json(200, { candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }] });
      }
      log({ kind: 'unrouted' });
      return json(404, { error: { code: 404, message: `routing stub: no route for ${req.method} ${url}`, status: 'NOT_FOUND' } });
    });
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    setFailing(value) { failing = value; },
    /** Serve `response` ({ status, headers, body, hang }) at GET `path` (must start with /files/). */
    host(path, response) { hosted.set(path, response); },
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}
