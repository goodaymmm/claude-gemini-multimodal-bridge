/**
 * The cgmb tool, as an MCP client sees it: its advertised input schema, what
 * the server does with a call shaped by that schema, and what the server
 * writes to its log while doing it.
 *
 * Drives the real `cgmb serve` over stdio with the layers replaced by the
 * recording stand-ins from tests/fixtures/routing-stubs.mjs (see
 * routing-matrix.test.mjs for the full harness). Nothing leaves the machine.
 *
 * 1. formattedData. The JSON schema advertised `geminiFormat: { prompt, args }`
 *    while the zod schema demanded `stdin`, so a call shaped exactly per the
 *    schema failed validation, fell back to the legacy request shape and lost
 *    its targetLayer without a word. The unused `aistudioFormat` was
 *    advertised too.
 * 2. Log hygiene. "Tool called" logged the whole arguments object, prompt
 *    included, to stderr and LOG_FILE -- signed-URL tokens and all.
 * 3. cgmb_get_layer_requirements advertised Imagen 3, Veo 2 and a 2024
 *    example; none of that is what the layers call.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { AI_MODELS, EnhancedCGMBRequestSchema, firstLineForLog, describeToolArgs, redactUrls } from '../dist/core/types.js';
import { AGY_ANSWER, CLAUDE_ANSWER, createCliStubs, readCalls, startRoutingGemini } from './fixtures/routing-stubs.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'dist', 'cli.js');
const SKIP = process.platform === 'win32' && 'the layer stand-ins are POSIX shims';
const FAKE_KEY = 'AIzaFakeKeyForTestsOnly000000000';
const SECRET_URL = 'https://example.com/secret?token=abc';
/** A prompt the router alone would not send to Claude (it goes to agy). */
const NEUTRAL = 'Give three tips for writing clear documentation';

// --- pure helpers ---------------------------------------------------------------

describe('log helpers', () => {
  it('redactUrls keeps scheme and host, drops path and query', () => {
    assert.equal(redactUrls(`see ${SECRET_URL} now`), 'see https://example.com/… now');
    assert.equal(redactUrls('no urls here'), 'no urls here');
  });

  it('firstLineForLog: first non-empty line, URLs cut, at most 200 characters', () => {
    assert.equal(firstLineForLog(`\n  Error: fetch ${SECRET_URL} failed\nat line 2`), 'Error: fetch https://example.com/… failed');
    const long = firstLineForLog('x'.repeat(500));
    assert.equal(long.length, 201, 'truncated to 200 plus an ellipsis');
    // Redaction before truncation: a URL straddling the cut cannot leak its query.
    assert.doesNotMatch(firstLineForLog(`${'y'.repeat(190)} ${SECRET_URL}`), /token/);
  });

  it('describeToolArgs reports shape, never text', () => {
    const d = describeToolArgs({ prompt: `read ${SECRET_URL}`, files: [{ path: '/a', type: 'pdf' }], targetLayer: 'claude' });
    assert.deepEqual(d.argKeys, ['prompt', 'files', 'targetLayer']);
    assert.equal(d.promptLength, `read ${SECRET_URL}`.length);
    assert.equal(d.fileCount, 1);
    assert.equal(d.targetLayer, 'claude');
    assert.deepEqual(d.urlHosts, ['example.com']);
    assert.doesNotMatch(JSON.stringify(d), /token|secret|read /);
  });
});

describe('formattedData zod schema', () => {
  it('accepts exactly the shape the JSON schema advertises, and keeps targetLayer', () => {
    const parsed = EnhancedCGMBRequestSchema.safeParse({
      prompt: 'p',
      targetLayer: 'claude',
      preformatted: true,
      formattedData: { geminiFormat: { prompt: 'q', args: ['--x'] } },
    });
    assert.equal(parsed.success, true, parsed.error?.message);
    assert.equal(parsed.data.targetLayer, 'claude');
    assert.equal(parsed.data.formattedData.geminiFormat.prompt, 'q');
  });

  it('still accepts the legacy stdin spelling and the deprecated aistudioFormat', () => {
    assert.equal(EnhancedCGMBRequestSchema.safeParse({
      prompt: 'p', formattedData: { geminiFormat: { stdin: 'q', args: [] } },
    }).success, true);
    assert.equal(EnhancedCGMBRequestSchema.safeParse({
      prompt: 'p', formattedData: { aistudioFormat: { apiData: {}, files: [] } },
    }).success, true);
  });
});

// --- through the real server ------------------------------------------------------

describe('cgmb over MCP', { skip: SKIP }, () => {
  let base, work, stubs, gemini, env, server, logFile;

  /** Start `cgmb serve` and speak JSON-RPC to it (as in routing-matrix). */
  async function startServer(extraEnv = {}) {
    const pending = new Map();
    let nextId = 1;
    let stderr = '';
    const child = spawn(process.execPath, [CLI, 'serve'], { cwd: work, env: { ...env, ...extraEnv } });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        pending.get(message.id)?.(message);
        pending.delete(message.id);
      }
    });

    const rpc = (method, params, ms = 60000) => new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out; server stderr tail:\n${stderr.slice(-2000)}`));
      }, ms);
      pending.set(id, message => { clearTimeout(timer); resolve(message); });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });

    const init = await rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'mcp-schema-cgmb', version: '1' },
    });
    assert.ok(init.result, `initialize failed: ${JSON.stringify(init.error)}`);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

    return {
      rpc,
      stderr: () => stderr,
      async stop() {
        child.stdin.end();
        const killer = setTimeout(() => child.kill('SIGKILL'), 5000);
        if (child.exitCode === null) { await new Promise(resolve => child.once('exit', resolve)); }
        clearTimeout(killer);
      },
    };
  }

  /** Call the cgmb tool; returns the layers reached (probes excluded) and the reply. */
  async function call(args, { on = server, tool = 'cgmb' } = {}) {
    const mark = readCalls(stubs.logPath).length;
    const response = await on.rpc('tools/call', { name: tool, arguments: args });
    const entries = readCalls(stubs.logPath).slice(mark).filter(e => e.kind !== 'probe' && e.kind !== 'fetch');
    return {
      hits: entries.map(e => e.layer),
      prompts: entries.map(e => e.promptHead ?? ''),
      isError: response.result?.isError === true || response.error !== undefined,
      text: response.result?.content?.map(part => part.text ?? '').join('\n') ?? JSON.stringify(response.error ?? ''),
    };
  }

  before(async () => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'cgmb-schema-')));
    work = join(base, 'work');
    const stubDir = join(base, 'stubs');
    const childTmp = join(base, 'tmp');
    for (const dir of [work, stubDir, childTmp]) { mkdirSync(dir); }
    logFile = join(base, 'cgmb.log');

    stubs = createCliStubs(stubDir);
    gemini = await startRoutingGemini(stubs.logPath);

    env = {
      ...process.env,
      AI_STUDIO_API_KEY: FAKE_KEY,
      GOOGLE_GEMINI_BASE_URL: gemini.baseUrl,
      ANTIGRAVITY_CLI_PATH: stubs.agyPath,
      CLAUDE_CODE_PATH: stubs.claudePath,
      ENABLE_CACHING: 'false',
      CACHE_TTL: '1',
      HOME: base,
      USERPROFILE: base,
      TMPDIR: childTmp,
      TMP: childTmp,
      TEMP: childTmp,
    };
    for (const key of [
      'NODE_TEST_CONTEXT', 'LOG_LEVEL', 'LOG_FILE', 'CGMB_CLI_MODE', 'CGMB_DEBUG', 'CGMB_PDF_MODE',
      'GEMINI_API_KEY', 'GOOGLE_AI_STUDIO_API_KEY', 'GEMINI_CLI_PATH', 'ANTIGRAVITY_MODEL',
      'CGMB_ENV_PATH', 'CGMB_ALLOWED_ROOTS', 'CLAUDE_STUB_SIGNED_OUT',
    ]) {
      delete env[key];
    }

    server = await startServer({ LOG_FILE: logFile });
  });

  after(async () => {
    await server?.stop();
    await gemini?.close();
    if (base) { rmSync(base, { recursive: true, force: true }); }
  });

  // --- the advertised schema -------------------------------------------------------

  it('advertises geminiFormat as { prompt, args } and no aistudioFormat', async () => {
    const list = await server.rpc('tools/list', {});
    const tool = list.result.tools.find(t => t.name === 'cgmb');
    const formatted = tool.inputSchema.properties.formattedData;

    assert.deepEqual(Object.keys(formatted.properties), ['geminiFormat']);
    assert.deepEqual(Object.keys(formatted.properties.geminiFormat.properties).sort(), ['args', 'prompt']);
  });

  // --- a call shaped by that schema ----------------------------------------------------

  it('a schema-shaped geminiFormat call with targetLayer "claude" reaches Claude', async () => {
    const r = await call({
      prompt: NEUTRAL,
      targetLayer: 'claude',
      preformatted: true,
      formattedData: { geminiFormat: { prompt: 'unused here', args: [] } },
    });

    assert.equal(r.isError, false, r.text);
    assert.deepEqual(r.hits, ['claude'], 'targetLayer must not be dropped');
    assert.match(r.text, new RegExp(CLAUDE_ANSWER));
  });

  it('a schema-shaped geminiFormat call for antigravity sends geminiFormat.prompt to agy', async () => {
    const r = await call({
      prompt: 'CGMB outer prompt',
      targetLayer: 'antigravity',
      preformatted: true,
      formattedData: { geminiFormat: { prompt: 'preformatted search for zebra facts' } },
    });

    assert.equal(r.isError, false, r.text);
    assert.deepEqual(r.hits, ['antigravity']);
    assert.match(r.prompts[0], /preformatted search for zebra facts/);
    assert.match(r.text, new RegExp(AGY_ANSWER));
  });

  it('still accepts the legacy stdin spelling', async () => {
    const r = await call({
      prompt: 'CGMB outer prompt',
      targetLayer: 'gemini',
      preformatted: true,
      formattedData: { geminiFormat: { stdin: 'legacy stdin about giraffes', args: [] } },
    });

    assert.equal(r.isError, false, r.text);
    assert.deepEqual(r.hits, ['antigravity']);
    assert.match(r.prompts[0], /legacy stdin about giraffes/);
  });

  it('still accepts the deprecated aistudioFormat, and honours targetLayer', async () => {
    const r = await call({
      prompt: NEUTRAL,
      targetLayer: 'claude',
      preformatted: true,
      formattedData: { aistudioFormat: { apiData: { prompt: 'x' }, files: [] } },
    });

    assert.equal(r.isError, false, r.text);
    assert.deepEqual(r.hits, ['claude']);
  });

  it('refuses a request whose targetLayer is invalid instead of dropping it', async () => {
    // Previously parsed as the legacy shape: the field vanished and the router
    // picked a layer, with no sign anything had been overridden.
    const r = await call({ prompt: 'CGMB hello', targetLayer: 'gpt' });

    assert.equal(r.isError, true, r.text);
    assert.deepEqual(r.hits, [], 'no layer may run');
    assert.match(r.text, /targetLayer/);
  });

  // --- the log -----------------------------------------------------------------------

  it('logs a URL in a prompt by host only, on stderr and in LOG_FILE', async () => {
    const r = await call({ prompt: `CGMB explain what this link is for: ${SECRET_URL}`, targetLayer: 'claude' });
    assert.equal(r.isError, false, r.text);

    const stderr = server.stderr();
    assert.match(stderr, /example\.com/, 'the host is what the log keeps');
    assert.doesNotMatch(stderr, /token=abc/, 'the query string must not be logged');
    assert.doesNotMatch(stderr, /explain what this link is for/, 'the prompt text must not be logged');

    assert.ok(existsSync(logFile), 'LOG_FILE must have been written');
    const file = readFileSync(logFile, 'utf8');
    assert.match(file, /example\.com/);
    assert.doesNotMatch(file, /token=abc/);
  });

  it('keeps the token out of the log at debug level too', async () => {
    const debugServer = await startServer({ CGMB_DEBUG: 'true' });
    try {
      const r = await call({ prompt: `CGMB explain this link: ${SECRET_URL}`, targetLayer: 'claude' }, { on: debugServer });
      assert.equal(r.isError, false, r.text);
      assert.match(debugServer.stderr(), /example\.com/);
      assert.doesNotMatch(debugServer.stderr(), /token=abc/);
    } finally {
      await debugServer.stop();
    }
  });

  // --- cgmb_get_layer_requirements --------------------------------------------------

  it('cgmb_get_layer_requirements names the models the layers really call', async () => {
    const r = await call({}, { tool: 'cgmb_get_layer_requirements' });
    assert.equal(r.isError, false, r.text);

    assert.doesNotMatch(r.text, /Imagen|Veo|2024/, 'nothing the layers do not call');
    for (const model of [AI_MODELS.IMAGE_GENERATION, AI_MODELS.AUDIO_GENERATION, AI_MODELS.MULTIMODAL_ANALYSIS]) {
      assert.ok(r.text.includes(model), `${model} must be named`);
    }
    assert.match(r.text, /Video generation is not implemented/);
  });
});
