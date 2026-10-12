/**
 * Routing matrix: which layer each kind of request actually reaches.
 *
 * CGMB's architecture is a router. The README promises:
 *
 *   Antigravity CLI   web search, latest information
 *   AI Studio         images, audio, file processing (OCR, documents)
 *   Claude Code       complex reasoning, code analysis
 *
 * This file drives the real `cgmb serve` MCP server over stdio -- and, for the
 * commands that route on their own, the real CLI -- with all three layers
 * replaced by recording stand-ins (tests/fixtures/routing-stubs.mjs), and pins
 * the order in which the layers were reached for each case. The rule itself is
 * LayerManager.decideRoute(); every README usage example, in both languages,
 * is run through it below.
 *
 * Nothing leaves the machine: agy and claude are node scripts behind
 * ANTIGRAVITY_CLI_PATH / CLAUDE_CODE_PATH, the AI Studio sub-server's Gemini
 * client is pointed at a local HTTP server by GOOGLE_GEMINI_BASE_URL, and the
 * PDF URLs are served by that same local server. Every probe and call lands in
 * one log, in order.
 *
 * The observed route of every case can be written out with
 * ROUTING_MATRIX_OUT=<file> to compare two builds.
 *
 * Hit tokens:
 *   antigravity        agy was run with a prompt (probes are not counted)
 *   claude             claude --print was run with a prompt
 *   aistudio:text      generateContent on a text/multimodal model
 *   aistudio:image     generateContent on AI_MODELS.IMAGE_GENERATION
 *   aistudio:tts       generateContent on AI_MODELS.AUDIO_GENERATION
 *   aistudio:upload    a File API upload (scanned PDF, or a PDF from a URL)
 *   <token>:failed     the stand-in was told to fail that call
 * Downloads of a PDF URL are logged (kind 'fetch') but are not hits.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { AI_MODELS } from '../dist/core/types.js';
import { makePdf } from './fixtures/make-pdf.mjs';
import {
  AGY_ANSWER,
  CLAUDE_ANSWER,
  GEMINI_ANSWER,
  TINY_PNG,
  createCliStubs,
  readCalls,
  startRoutingGemini,
  tinyWav,
} from './fixtures/routing-stubs.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'dist', 'cli.js');

// The stand-ins are POSIX shell shims, and the routing is platform-neutral
// code; the Windows launcher paths are covered by claude-path and
// antigravity-cli. Not run on Windows rather than run unverified there.
const SKIP = process.platform === 'win32' && 'routing matrix stubs are POSIX shims';

// The key format check wants "AI..." and 20+ characters; the stand-in ignores it.
const FAKE_KEY = 'AIzaFakeKeyForTestsOnly000000000';

const PROSE = [
  'Quarterly revenue grew by twelve percent year on year,',
  'while operating costs stayed flat across every region.',
  'The board approved the expansion plan for next spring.',
].join('\n');

const CODE = 'export const add = (a: number, b: number): number => a + b;\n';

/** One log entry -> one hit token, or null for a probe or a download. */
function token(entry) {
  if (entry.kind === 'probe' || entry.kind === 'fetch') { return null; }
  const failed = entry.failed ? ':failed' : '';
  if (entry.layer !== 'aistudio') { return `${entry.layer}${failed}`; }
  if (entry.kind === 'upload') { return `aistudio:upload${failed}`; }
  if (entry.kind === 'unrouted') { return `aistudio:unrouted ${entry.method} ${entry.path}`; }
  const kind = entry.model === AI_MODELS.IMAGE_GENERATION ? 'image'
    : entry.model === AI_MODELS.AUDIO_GENERATION ? 'tts'
      : 'text';
  return `aistudio:${kind}${failed}`;
}

describe('routing matrix', { skip: SKIP }, () => {
  const observed = new Map();
  let base, work, stubs, gemini, env, childTmp;
  let main;
  const files = {};
  const urls = {};

  /** Record a case: the hit tokens since `mark`, plus what the caller saw. */
  function record(id, mark, outcome) {
    const entries = readCalls(stubs.logPath).slice(mark);
    const hits = entries.map(token).filter(Boolean);
    const result = { id, hits, ...outcome, entries };
    observed.set(id, result);
    return result;
  }

  function resetFailures() {
    stubs.setFailing('antigravity', false);
    stubs.setFailing('claude', false);
    gemini.setFailing(false);
  }

  function setFailures(fail) {
    for (const layer of [fail ?? []].flat()) {
      if (layer === 'aistudio') { gemini.setFailing(true); } else { stubs.setFailing(layer, true); }
    }
  }

  // --- MCP client over stdio -------------------------------------------------

  /** Start `cgmb serve` with `extraEnv` and speak JSON-RPC to it. */
  async function startServer(extraEnv = {}) {
    const pending = new Map();
    const stdoutLines = [];
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
        stdoutLines.push(line);
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
      clientInfo: { name: 'routing-matrix', version: '1' },
    });
    assert.ok(init.result, `initialize failed: ${JSON.stringify(init.error)}`);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

    return {
      rpc,
      stdoutLines,
      stderr: () => stderr,
      async stop() {
        child.stdin.end();
        const killer = setTimeout(() => child.kill('SIGKILL'), 5000);
        if (child.exitCode === null) { await new Promise(resolve => child.once('exit', resolve)); }
        clearTimeout(killer);
      },
    };
  }

  /** Call an MCP tool, optionally with stand-ins told to fail first. */
  async function mcp(id, tool, args, { fail, server = main } = {}) {
    resetFailures();
    setFailures(fail);
    const mark = readCalls(stubs.logPath).length;
    try {
      const response = await server.rpc('tools/call', { name: tool, arguments: args });
      const text = response.result?.content?.map(part => part.text ?? '').join('\n') ?? '';
      return record(id, mark, {
        isError: response.result?.isError === true || response.error !== undefined,
        text: text || JSON.stringify(response.error ?? ''),
      });
    } finally {
      resetFailures();
    }
  }

  /** Run one CLI command against the same stand-ins. */
  async function cli(id, args, { fail, extraEnv = {} } = {}) {
    resetFailures();
    setFailures(fail);
    const mark = readCalls(stubs.logPath).length;
    try {
      // Async spawn: the Gemini stand-in runs in this process and has to keep
      // answering while the CLI waits on it.
      const { code, output } = await new Promise(resolve => {
        const child = spawn(process.execPath, [CLI, ...args], { cwd: work, env: { ...env, ...extraEnv } });
        let output = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', chunk => { output += chunk; });
        child.stderr.on('data', chunk => { output += chunk; });
        child.on('close', exitCode => resolve({ code: exitCode, output }));
      });
      return record(id, mark, { isError: code !== 0, exitCode: code, text: output });
    } finally {
      resetFailures();
    }
  }

  before(async () => {
    // realpath: macOS hands out /var/... for /private/var/..., and both the
    // trusted-binary check and the AI Studio workspace confinement compare
    // resolved paths.
    base = realpathSync(mkdtempSync(join(tmpdir(), 'cgmb-routing-')));
    work = join(base, 'work');
    const stubDir = join(base, 'stubs');
    childTmp = join(base, 'tmp');
    for (const dir of [work, stubDir, childTmp]) { mkdirSync(dir); }

    // Outside `work`: resolveTrustedCommand and findAntigravityBinary refuse
    // binaries inside the server's cwd.
    stubs = createCliStubs(stubDir);
    gemini = await startRoutingGemini(stubs.logPath);

    const put = (name, bytes) => { const path = join(work, name); writeFileSync(path, bytes); return path; };
    files.png = put('photo.png', TINY_PNG);
    files.pdf = put('report.pdf', makePdf([PROSE, PROSE]));
    files.scan = put('scan.pdf', makePdf([null, null]));
    files.wav = put('voice.wav', tinyWav());
    files.ts = put('util.ts', CODE);

    // The web servers PDF URLs point at, served by the same local stand-in.
    const pdfBody = makePdf([PROSE, PROSE]);
    const pdf = { status: 200, headers: { 'content-type': 'application/pdf' }, body: pdfBody };
    gemini.host('/files/report.pdf', pdf);
    gemini.host('/files/moved.pdf', { status: 302, headers: { location: '/files/report.pdf' } });
    gemini.host('/files/loop.pdf', { status: 302, headers: { location: '/files/loop.pdf' } });
    gemini.host('/files/page.pdf', { status: 200, headers: { 'content-type': 'text/html' }, body: '<html>Not found</html>' });
    gemini.host('/files/huge.pdf', {
      status: 200,
      headers: { 'content-type': 'application/pdf', 'content-length': String(60 * 1024 * 1024) },
      body: '%PDF-1.4\n',
      hang: true,
    });
    urls.pdf = `${gemini.baseUrl}/files/report.pdf`;

    env = {
      ...process.env,
      AI_STUDIO_API_KEY: FAKE_KEY,
      GOOGLE_GEMINI_BASE_URL: gemini.baseUrl,
      ANTIGRAVITY_CLI_PATH: stubs.agyPath,
      CLAUDE_CODE_PATH: stubs.claudePath,
      // The search cache is in-memory and keyed by prompt. ENABLE_CACHING=false
      // turns it off, so no request is answered without reaching agy;
      // CACHE_TTL (seconds) is kept at 1 as a second guard.
      ENABLE_CACHING: 'false',
      CACHE_TTL: '1',
      // Auth caches go under HOME. The agy layer's per-request workspaces go
      // under tmpdir(), named cgmb-agy-*, which antigravity-cli.test.mjs scans
      // for leftovers while this file runs in parallel -- keep ours elsewhere.
      // Downloaded PDFs go there too, which is how their removal is checked.
      HOME: base,
      USERPROFILE: base,
      TMPDIR: childTmp,
      TMP: childTmp,
      TEMP: childTmp,
      // The PDF URLs below are served from 127.0.0.1, which the download
      // refuses unless private addresses are allowed.
      CGMB_ALLOW_PRIVATE_URLS: 'true',
    };
    for (const key of [
      'NODE_TEST_CONTEXT', 'LOG_LEVEL', 'LOG_FILE', 'CGMB_CLI_MODE', 'CGMB_DEBUG', 'CGMB_PDF_MODE',
      'GEMINI_API_KEY', 'GOOGLE_AI_STUDIO_API_KEY', 'GEMINI_CLI_PATH', 'ANTIGRAVITY_MODEL',
      'CGMB_ENV_PATH', 'CGMB_ALLOWED_ROOTS', 'CLAUDE_STUB_SIGNED_OUT',
    ]) {
      delete env[key];
    }

    main = await startServer();
  });

  after(async () => {
    if (process.env.ROUTING_MATRIX_OUT) {
      const rows = [...observed.values()]
        .map(({ id, hits, isError, exitCode }) => ({ id, hits, isError, ...(exitCode === undefined ? {} : { exitCode }) }))
        .sort((a, b) => a.id.localeCompare(b.id));
      writeFileSync(process.env.ROUTING_MATRIX_OUT, JSON.stringify(rows, null, 2) + '\n');
    }
    await main?.stop();
    await gemini?.close();
    if (base) { rmSync(base, { recursive: true, force: true }); }
  });

  /** The prompt text the stand-in for `layer` received in this case. */
  const promptsTo = (result, layer) => result.entries.filter(e => e.layer === layer && e.kind === 'call').map(e => e.promptHead ?? '');
  /** The /files/ paths fetched in this case. */
  const fetched = result => result.entries.filter(e => e.kind === 'fetch').map(e => e.path);
  const hitsOf = r => `hits: ${r.hits.join(', ')}\n${r.text.slice(0, 600)}`;

  // --- 1, 2, 11: current information and search -> Antigravity ----------------

  it('01 current-information prompt goes to Antigravity (search auto-routing)', async () => {
    const r = await mcp('01-current-en', 'cgmb', { prompt: 'What is the latest news about TypeScript today?' });
    assert.deepEqual(r.hits, ['antigravity']);
    assert.equal(r.isError, false);
    assert.match(r.text, new RegExp(AGY_ANSWER));
  });

  it('02 explicit "search the web" goes to Antigravity', async () => {
    const r = await mcp('02-search-en', 'cgmb', { prompt: 'Search the web for TypeScript 6 release notes' });
    assert.deepEqual(r.hits, ['antigravity']);
    assert.match(promptsTo(r, 'antigravity')[0], /TypeScript 6 release notes/);
  });

  it('11a Japanese current-information prompt goes to Antigravity, text intact', async () => {
    const r = await mcp('11a-current-ja', 'cgmb', { prompt: '今日の最新のAIニュースを教えてください' });
    assert.deepEqual(r.hits, ['antigravity']);
    assert.match(promptsTo(r, 'antigravity')[0], /最新のAIニュース/);
  });

  // A short question with no reasoning, code, search or generation signal stays
  // on the Antigravity CLI (LayerManager.decideRoute, rule 7).
  it('03c a plain factual question goes to Antigravity', async () => {
    const r = await mcp('03c-plain-en', 'cgmb', { prompt: 'Who wrote Pride and Prejudice?' });
    assert.deepEqual(r.hits, ['antigravity']);
  });

  // --- 3, 4, 11: reasoning and code -> Claude Code -------------------------------

  // README: "Claude Code: Complex reasoning, code analysis".
  it('03 a reasoning prompt reaches Claude', async () => {
    const r = await mcp('03-reasoning-short-en', 'cgmb', { prompt: 'Explain the difference between TCP and UDP' });
    assert.deepEqual(r.hits, ['claude']);
    assert.match(r.text, new RegExp(CLAUDE_ANSWER));
  });

  it('11b a Japanese reasoning prompt reaches Claude', async () => {
    const r = await mcp('11b-reasoning-ja', 'cgmb', { prompt: 'TCPとUDPの違いを説明してください' });
    assert.deepEqual(r.hits, ['claude']);
    assert.match(promptsTo(r, 'claude')[0], /TCPとUDPの違い/);
  });

  // Length does not turn a reasoning question into a three-step workflow: it
  // is answered by Claude alone.
  it('03b a long reasoning prompt reaches Claude, once', async () => {
    const prompt = 'Explain step by step how congestion control interacts with flow control in TCP. '.repeat(14);
    assert.ok(prompt.length > 1000);
    const r = await mcp('03b-reasoning-long-en', 'cgmb', { prompt });
    assert.deepEqual(r.hits, ['claude']);
  });

  // A long prompt with no signal still runs the analysis workflow.
  it('03d a long prompt with no signal runs the analysis workflow: Claude, AI Studio, Claude', async () => {
    const prompt = 'Here are my notes from the meeting. '.repeat(30);
    assert.ok(prompt.length > 1000);
    const r = await mcp('03d-long-no-signal', 'cgmb', { prompt });
    assert.deepEqual(r.hits, ['claude', 'aistudio:text', 'claude']);
  });

  it('04 a code-writing prompt reaches Claude', async () => {
    const r = await mcp('04-code-en', 'cgmb', { prompt: 'Write a TypeScript function that reverses a string' });
    assert.deepEqual(r.hits, ['claude']);
  });

  // "create" used to select the generation workflow whatever was being created.
  it('04c "create a function" reaches Claude', async () => {
    const r = await mcp('04c-code-create-en', 'cgmb', { prompt: 'Create a TypeScript function that reverses a string' });
    assert.deepEqual(r.hits, ['claude']);
  });

  // "convert"/"transform" with no code or reasoning wording selects the
  // conversion workflow, which ends with an Antigravity quality check.
  it('04d "convert" runs the conversion workflow: Claude, AI Studio, Antigravity', async () => {
    const r = await mcp('04d-convert-en', 'cgmb', { prompt: 'Convert this JSON to YAML: {"a": 1, "b": [2, 3]}' });
    assert.deepEqual(r.hits, ['claude', 'aistudio:text', 'antigravity']);
  });

  // Code analysis is Claude's (README). Claude Code runs in CGMB's package
  // directory and may not read the user's files, so the file travels inline.
  it('04b a code file reaches Claude, with its contents in the prompt', async () => {
    const r = await mcp('04b-code-file', 'cgmb', { prompt: 'Review this code for bugs', files: [{ path: files.ts, type: 'text' }] });
    assert.deepEqual(r.hits, ['claude']);
    const sent = promptsTo(r, 'claude')[0];
    assert.match(sent, /Review this code for bugs/);
    assert.ok(r.entries.some(e => e.layer === 'claude' && e.promptLength > 'Review this code for bugs'.length + CODE.length));
  });

  for (const [id, prompt, expected] of [
    ['04e-code-ja', 'この関数のバグを修正してください: function f(a) { return a + 1 }', ['claude']],
    ['04f-compare-en', 'Compare REST and GraphQL for a mobile backend', ['claude']],
    ['04g-why-en', 'Why is the sky blue?', ['claude']],
    // "search" in a code question is a topic, not an instruction.
    ['04h-binary-search', 'Implement binary search in Python', ['claude']],
    ['04i-design-ja', 'マイクロサービスの設計の考え方を説明して', ['claude']],
    ['04l-debug', 'Debug this: TypeError: x is undefined', ['claude']],
    ['04m-find-bug', 'Find the bug in this function: function f(a) { return a +* 1 }', ['claude']],
    ['04n-language-ja', 'Pythonでフィボナッチ数列を書いて', ['claude']],
    ['04j-latest-beats-explain', 'Explain the latest changes in the EU AI Act this year', ['antigravity']],
    ['04k-research-ja', '量子コンピュータについて調べてください', ['antigravity']],
  ]) {
    it(`${id.slice(0, 3)} "${prompt.slice(0, 40)}" goes to ${expected.join(', ')}`, async () => {
      const r = await mcp(id, 'cgmb', { prompt });
      assert.deepEqual(r.hits, expected, hitsOf(r));
    });
  }

  // --- 5, 6, 7, 11: local files -> AI Studio ------------------------------------

  it('05 a PNG goes to AI Studio (single-file fast path)', async () => {
    const r = await mcp('05-png', 'cgmb', { prompt: 'Describe this image', files: [{ path: files.png, type: 'image' }] });
    assert.deepEqual(r.hits, ['aistudio:text']);
    assert.match(r.text, new RegExp(GEMINI_ANSWER));
  });

  it('05b a PNG path written in the prompt is picked up and goes to AI Studio', async () => {
    const r = await mcp('05b-png-in-prompt', 'cgmb', { prompt: `Describe the picture at ${files.png}` });
    assert.deepEqual(r.hits, ['aistudio:text']);
  });

  it('11c Japanese prompt with a PNG goes to AI Studio', async () => {
    const r = await mcp('11c-png-ja', 'cgmb', { prompt: 'この画像を説明してください', files: [{ path: files.png, type: 'image' }] });
    assert.deepEqual(r.hits, ['aistudio:text']);
  });

  it('06a a PDF with a text layer goes to AI Studio as text, not uploaded', async () => {
    const r = await mcp('06a-pdf-text', 'cgmb', { prompt: 'Summarise this report', files: [{ path: files.pdf, type: 'pdf' }] });
    assert.deepEqual(r.hits, ['aistudio:text']);
    assert.match(promptsTo(r, 'aistudio')[0], /Quarterly revenue grew/);
  });

  it('06b a scanned PDF goes to AI Studio and is uploaded', async () => {
    const r = await mcp('06b-pdf-scanned', 'cgmb', { prompt: 'Summarise this report', files: [{ path: files.scan, type: 'pdf' }] });
    assert.deepEqual(r.hits, ['aistudio:upload', 'aistudio:text']);
  });

  it('07 a WAV file goes to AI Studio', async () => {
    const r = await mcp('07-wav', 'cgmb', { prompt: 'Transcribe this recording', files: [{ path: files.wav, type: 'audio' }] });
    assert.deepEqual(r.hits, ['aistudio:text']);
  });

  // --- 8, 11: generation -> AI Studio ---------------------------------------------

  it('08a "generate image of ..." goes straight to the AI Studio image model', async () => {
    const r = await mcp('08a-image-keyword', 'cgmb', { prompt: 'Generate image of a red bicycle' });
    assert.deepEqual(r.hits, ['aistudio:image']);
    assert.equal(r.isError, false);
  });

  it('08b README wording "generate an image of ..." reaches the image model once, and returns the file', async () => {
    const r = await mcp('08b-image-readme-wording', 'cgmb', { prompt: 'Generate an image of a red bicycle' });
    assert.deepEqual(r.hits, ['aistudio:image']);
    assert.match(r.text, /Image generated: .*output[\\/]images[\\/]/);
  });

  it('08c README "create audio saying ..." goes to the AI Studio TTS model', async () => {
    const r = await mcp('08c-tts-readme', 'cgmb', { prompt: "Create audio saying 'Welcome to our podcast'" });
    assert.deepEqual(r.hits, ['aistudio:tts']);
  });

  it('08d "read this aloud" reaches the AI Studio TTS model', async () => {
    const r = await mcp('08d-read-aloud', 'cgmb', { prompt: 'Read this aloud: Welcome to the show' });
    assert.deepEqual(r.hits, ['aistudio:tts']);
  });

  for (const [id, prompt, expected] of [
    ['08e-draw-picture', 'Draw me a picture of a lighthouse at dusk', ['aistudio:image']],
    ['08f-logo', 'Create a logo for a small coffee shop', ['aistudio:image']],
    ['08g-render-illustration', 'Render an illustration of a fox in the snow', ['aistudio:image']],
    ['08h-tts', 'Text to speech: good morning, everyone', ['aistudio:tts']],
    ['08i-voice-narration', 'Make a voice narration of this sentence: the river was calm', ['aistudio:tts']],
    // Japanese image prompts are translated by agy before the image model.
    ['08j-image-ja', '夕焼けの海の画像を作成してください', ['antigravity', 'aistudio:image']],
    ['08k-illustration-ja', '桜の絵を描いて', ['antigravity', 'aistudio:image']],
    ['08l-read-aloud-ja', 'この文章を読み上げて: おはようございます', ['aistudio:tts']],
    // Not pictures, not sound.
    ['08m-docker-image', 'Create a docker image for a small web app', ['antigravity']],
    ['08n-drawbacks', 'What are the drawbacks of microservices?', ['antigravity']],
    ['08o-code-renders-image', 'Write a React component that renders an image gallery', ['claude']],
    ['08p-voice-assistant', 'Write a Python script for a voice assistant', ['claude']],
  ]) {
    it(`${id.slice(0, 3)} "${prompt.slice(0, 40)}" goes to ${expected.join(', ')}`, async () => {
      const r = await mcp(id, 'cgmb', { prompt });
      assert.deepEqual(r.hits, expected, hitsOf(r));
    });
  }

  // A Japanese image prompt is translated by agy before it reaches the image
  // model (AIStudioLayer.generateImage -> AntigravityCLILayer.translateToEnglish).
  it('11d Japanese "画像生成" is translated by Antigravity, then generated by AI Studio', async () => {
    const r = await mcp('11d-image-ja-keyword', 'cgmb', { prompt: 'ねこの画像生成をお願いします' });
    assert.deepEqual(r.hits, ['antigravity', 'aistudio:image']);
  });

  it('11e README_JP image example reaches the AI Studio image model', async () => {
    const r = await mcp('11e-image-ja-readme', 'cgmb', { prompt: 'CGMBで未来都市のイメージを生成してください' });
    assert.deepEqual(r.hits, ['antigravity', 'aistudio:image'], hitsOf(r));
  });

  it('11f README_JP audio example goes to the AI Studio TTS model', async () => {
    const r = await mcp('11f-audio-ja-readme', 'cgmb', { prompt: 'CGMBで「ポッドキャストへようこそ」という音声を作成してください' });
    assert.deepEqual(r.hits, ['aistudio:tts']);
  });

  // --- 9: URLs ----------------------------------------------------------------

  it('09a a PDF URL is downloaded, uploaded and read by Gemini through AI Studio', async () => {
    const r = await mcp('09a-pdf-url', 'cgmb', { prompt: `Summarise ${urls.pdf}` });
    assert.deepEqual(r.hits, ['aistudio:upload', 'aistudio:text'], hitsOf(r));
    assert.equal(r.isError, false);
    assert.deepEqual(fetched(r), ['/files/report.pdf']);
    // README: "PDF URLs are always uploaded" -- the uploaded file, not the URL text.
    assert.match(promptsTo(r, 'aistudio')[0], /\[fileData https:\/\/generativelanguage\.googleapis\.com\/v1beta\/files\/stub-\d+\]/);
  });

  it('09a\' ...and the downloaded file is removed afterwards', () => {
    const left = readdirSync(childTmp).filter(name => name.startsWith('cgmb-pdf-url-'));
    assert.deepEqual(left, []);
  });

  it('09d a PDF URL behind one redirect is followed', async () => {
    const r = await mcp('09d-pdf-url-redirect', 'cgmb', { prompt: `Summarise ${gemini.baseUrl}/files/moved.pdf` });
    assert.deepEqual(r.hits, ['aistudio:upload', 'aistudio:text'], hitsOf(r));
    assert.deepEqual(fetched(r), ['/files/moved.pdf', '/files/report.pdf']);
  });

  // A PDF URL that cannot be fetched is an error naming the layer and the URL;
  // no other layer is asked to answer about a document nobody could read.
  for (const [id, path, reason] of [
    ['09e-pdf-url-404', '/files/missing.pdf', /HTTP 404/],
    ['09f-pdf-url-not-pdf', '/files/page.pdf', /not a PDF/],
    ['09g-pdf-url-redirect-loop', '/files/loop.pdf', /more than 3 redirects/],
    ['09h-pdf-url-too-large', '/files/huge.pdf', /limit is 50 MB/],
  ]) {
    it(`${id.slice(0, 3)} ${path}: an error naming AI Studio, no layer answers`, async () => {
      const r = await mcp(id, 'cgmb', { prompt: `Summarise ${gemini.baseUrl}${path}` });
      assert.deepEqual(r.hits, [], hitsOf(r));
      assert.equal(r.isError, true);
      assert.match(r.text, /The aistudio layer could not read/);
      assert.match(r.text, reason);
    });
  }

  it('09i an image URL is refused by name, not answered without the image', async () => {
    const r = await mcp('09i-image-url', 'cgmb', { prompt: `Describe ${gemini.baseUrl}/files/pic.png` });
    assert.deepEqual(r.hits, []);
    assert.equal(r.isError, true);
    assert.match(r.text, /Only PDF URLs are fetched/);
  });

  it('09b a web page URL goes to Antigravity', async () => {
    const r = await mcp('09b-web-url', 'cgmb', { prompt: 'Summarise https://example.com/article' });
    assert.deepEqual(r.hits, ['antigravity']);
    assert.match(promptsTo(r, 'antigravity')[0], /https:\/\/example\.com\/article/);
  });

  // The files used to be dropped: URL routing ran first and gave agy files: [].
  it('09c a web URL plus a local PNG: the page through Antigravity, the PNG through AI Studio, both answers returned', async () => {
    const r = await mcp('09c-web-url-plus-png', 'cgmb', {
      prompt: 'Does this photo match https://example.com/article',
      files: [{ path: files.png, type: 'image' }],
    });
    assert.deepEqual(r.hits, ['antigravity', 'aistudio:text'], hitsOf(r));
    assert.equal(r.isError, false);
    assert.match(r.text, new RegExp(`From the web page \\(Antigravity CLI\\):\\n${AGY_ANSWER}`));
    assert.match(r.text, new RegExp(`From the attached file \\(AI Studio\\):\\n${GEMINI_ANSWER}`));
  });

  it('09j a web URL plus a PNG with AI Studio failing: an error naming AI Studio, not the page alone', async () => {
    const r = await mcp('09j-web-url-plus-png-aistudio-fails', 'cgmb', {
      prompt: 'Does this photo match https://example.com/article',
      files: [{ path: files.png, type: 'image' }],
    }, { fail: 'aistudio' });
    assert.equal(r.hits[0], 'antigravity');
    assert.ok(r.hits.slice(1).every(hit => hit === 'aistudio:text:failed'), hitsOf(r));
    assert.equal(r.isError, true);
    assert.match(r.text, /The aistudio layer could not read the attached files/);
  });

  // --- README usage examples, both languages ------------------------------------

  // Every example under "Usage Examples" must route where its heading says. The
  // two file examples are sent as Claude Code sends them: with the file.
  for (const [id, prompt, extra, expected] of [
    ['readme-en-image', 'CGMB generate an image of a futuristic city', {}, ['aistudio:image']],
    ['readme-en-document', p => `CGMB analyze the document at ${p.pdf}`, {}, ['aistudio:text']],
    ['readme-en-url', (_, u) => `CGMB analyze ${u.pdf}`, {}, ['aistudio:upload', 'aistudio:text']],
    ['readme-en-search', 'CGMB search for the latest AI news', {}, ['antigravity']],
    ['readme-en-audio', "CGMB create audio saying 'Welcome to our podcast'", {}, ['aistudio:tts']],
    ['readme-en-ocr', 'CGMB analyze this scanned PDF document with OCR', { scan: true }, ['aistudio:upload', 'aistudio:text']],
    ['readme-ja-image', 'CGMBで未来都市のイメージを生成してください', {}, ['antigravity', 'aistudio:image']],
    ['readme-ja-document', p => `CGMBで${p.pdf}にあるこの文書を分析してください`, {}, ['aistudio:text']],
    // The URL is followed directly by Japanese; it must still read as a PDF URL.
    ['readme-ja-url', (_, u) => `CGMBで${u.pdf}を分析してください`, {}, ['aistudio:upload', 'aistudio:text']],
    ['readme-ja-search', 'CGMBで最新のAI情報を検索してください', {}, ['antigravity']],
    ['readme-ja-audio', 'CGMBで「ポッドキャストへようこそ」という音声を作成してください', {}, ['aistudio:tts']],
    ['readme-ja-ocr', 'CGMBでこのスキャンされたPDF文書をOCRで解析してください', { scan: true }, ['aistudio:upload', 'aistudio:text']],
  ]) {
    it(`README example ${id} goes to ${expected.join(', ')}`, async () => {
      const text = typeof prompt === 'function' ? prompt(files, urls) : prompt;
      const args = { prompt: text, ...(extra.scan ? { files: [{ path: files.scan, type: 'pdf' }] } : {}) };
      const r = await mcp(id, 'cgmb', args);
      assert.deepEqual(r.hits, expected, hitsOf(r));
      assert.equal(r.isError, false);
    });
  }

  // --- 10: explicit targetLayer --------------------------------------------------

  const NEUTRAL = 'Give three tips for writing clear documentation';
  for (const [target, expected] of [
    ['claude', ['claude']],
    ['antigravity', ['antigravity']],
    ['gemini', ['antigravity']],
    ['aistudio', ['aistudio:text']],
  ]) {
    it(`10 targetLayer "${target}" on a neutral prompt goes to ${expected[0].split(':')[0]}`, async () => {
      const r = await mcp(`10-target-${target}`, 'cgmb', { prompt: NEUTRAL, targetLayer: target });
      assert.deepEqual(r.hits, expected);
      assert.equal(r.isError, false);
    });
  }

  it('10b targetLayer "claude" with a source file: Claude reads it inline', async () => {
    const r = await mcp('10b-target-claude-code-file', 'cgmb', {
      prompt: 'Review this code', files: [{ path: files.ts, type: 'text' }], targetLayer: 'claude',
    });
    assert.deepEqual(r.hits, ['claude']);
    assert.ok(r.entries.some(e => e.layer === 'claude' && e.promptLength > CODE.length));
  });

  it('10c targetLayer "claude" with a PNG is refused before any layer runs', async () => {
    const r = await mcp('10c-target-claude-png', 'cgmb', {
      prompt: 'Describe this', files: [{ path: files.png, type: 'image' }], targetLayer: 'claude',
    });
    assert.deepEqual(r.hits, []);
    assert.equal(r.isError, true);
    assert.match(r.text, /cannot read files/);
  });

  // --- 12: several files and the specialised tools -----------------------------

  it('12a three files through cgmb run the analysis workflow: Claude, AI Studio, Claude', async () => {
    const r = await mcp('12a-three-files', 'cgmb', {
      prompt: 'Compare these files',
      files: [{ path: files.png, type: 'image' }, { path: files.pdf, type: 'pdf' }, { path: files.wav, type: 'audio' }],
    });
    assert.deepEqual(r.hits, ['claude', 'aistudio:text', 'claude']);
  });

  it('12b cgmb_multimodal_process with three files runs the same workflow', async () => {
    const r = await mcp('12b-multimodal-tool-three-files', 'cgmb_multimodal_process', {
      prompt: 'Compare these files',
      workflow: 'analysis',
      files: [{ path: files.png, type: 'image' }, { path: files.pdf, type: 'pdf' }, { path: files.wav, type: 'audio' }],
    });
    assert.deepEqual(r.hits, ['claude', 'aistudio:text', 'claude']);
  });

  it('12f cgmb_multimodal_process routes a text-only reasoning prompt by the same rule', async () => {
    const r = await mcp('12f-multimodal-tool-reasoning', 'cgmb_multimodal_process', {
      prompt: 'Explain the difference between TCP and UDP', workflow: 'analysis', files: [],
    });
    assert.deepEqual(r.hits, ['claude']);
    assert.match(r.text, new RegExp(CLAUDE_ANSWER));
  });

  it('12c cgmb_document_analysis runs Claude, AI Studio, Claude', async () => {
    const r = await mcp('12c-document-analysis-tool', 'cgmb_document_analysis', { documents: [files.pdf], analysis_type: 'summary' });
    assert.deepEqual(r.hits, ['claude', 'aistudio:text', 'claude']);
  });

  it('12d cgmb_workflow_orchestration runs each step on the layer it names, in order', async () => {
    const r = await mcp('12d-workflow-tool', 'cgmb_workflow_orchestration', {
      execution_mode: 'sequential',
      input_data: {},
      workflow_definition: {
        steps: [
          { id: 'a', layer: 'antigravity', action: 'search', input: { prompt: 'latest TypeScript release' } },
          { id: 'b', layer: 'aistudio', action: 'document_analysis', input: { documents: [files.pdf], instructions: 'Summarise' }, dependsOn: ['a'] },
          { id: 'c', layer: 'claude', action: 'synthesize_response', input: { prompt: 'Combine the findings' }, dependsOn: ['b'] },
        ],
      },
    });
    assert.deepEqual(r.hits, ['antigravity', 'aistudio:text', 'claude']);
    assert.equal(r.isError, false);
  });

  // layer_priority was in the schema and read by nothing; the README never
  // mentioned it. It is no longer advertised, and still accepted (ignored), so
  // a caller that sends it is not refused.
  it('12e options.layer_priority is no longer advertised, and sending it changes nothing', async () => {
    const list = await main.rpc('tools/list', {});
    const tool = list.result.tools.find(t => t.name === 'cgmb_multimodal_process');
    assert.equal(tool.inputSchema.properties.options.properties.layer_priority, undefined);
    assert.doesNotMatch(tool.description, /layer_priority/);

    const r = await mcp('12e-layer-priority-claude', 'cgmb_multimodal_process', {
      prompt: 'Describe this image',
      workflow: 'analysis',
      files: [{ path: files.png, type: 'image' }],
      options: { layer_priority: 'claude' },
    });
    assert.deepEqual(r.hits, ['aistudio:text']);
    assert.equal(r.isError, false);
  });

  it('12g cgmb_get_layer_requirements names all three layers', async () => {
    const list = await main.rpc('tools/list', {});
    const tool = list.result.tools.find(t => t.name === 'cgmb_get_layer_requirements');
    assert.match(tool.description, /antigravity .*claude .*aistudio/s);
  });

  // --- 13: failures --------------------------------------------------------------

  // The search route falls back the way the CLI does (getFallbackOrder): agy,
  // then AI Studio, then Claude. The answer says it came from a fallback.
  it('13a agy failing on a search prompt: AI Studio answers, and says so', async () => {
    const r = await mcp('13a-agy-fails-current', 'cgmb', { prompt: 'What is the latest news about Rust today?' }, { fail: 'antigravity' });
    assert.deepEqual(r.hits, ['antigravity:failed', 'aistudio:text']);
    assert.equal(r.isError, false);
    assert.match(r.text, /The antigravity layer could not answer .*this answer comes from the aistudio layer instead/s);
    assert.match(r.text, new RegExp(GEMINI_ANSWER));
  });

  it('13b agy failing on a plain question: the same fallback, AI Studio answers', async () => {
    const r = await mcp('13b-agy-fails-short', 'cgmb', { prompt: 'Who painted the Mona Lisa?' }, { fail: 'antigravity' });
    assert.deepEqual(r.hits, ['antigravity:failed', 'aistudio:text']);
    assert.equal(r.isError, false);
  });

  it('13e every layer failing on a search prompt: one error naming each layer', async () => {
    const r = await mcp('13e-all-fail-search', 'cgmb', { prompt: 'What is the latest news about Go today?' },
      { fail: ['antigravity', 'aistudio', 'claude'] });
    assert.deepEqual(r.hits, ['antigravity:failed', 'aistudio:text:failed', 'claude:failed']);
    assert.equal(r.isError, true);
    assert.match(r.text, /The antigravity layer failed .*aistudio: .*claude: /s);
  });

  it('13f Claude failing on a reasoning prompt: Antigravity answers, and says so', async () => {
    const r = await mcp('13f-claude-fails-reasoning', 'cgmb', { prompt: 'Explain the difference between IPv4 and IPv6' }, { fail: 'claude' });
    assert.deepEqual(r.hits, ['claude:failed', 'antigravity']);
    assert.equal(r.isError, false);
    assert.match(r.text, /The claude layer could not answer/);
  });

  // Generation does not fall back: no other layer can make an image.
  it('13g AI Studio failing on image generation: an error, no other layer asked', async () => {
    const r = await mcp('13g-aistudio-fails-image', 'cgmb', { prompt: 'Generate an image of a red bicycle' }, { fail: 'aistudio' });
    assert.ok(r.hits.length > 0 && r.hits.every(hit => hit === 'aistudio:image:failed'), hitsOf(r));
    assert.equal(r.isError, true);
  });

  // The single-file fast path falls back to the full workflow, whose AI Studio
  // step fails again. The workflow's antigravity fallback is never used for a
  // file-carrying step (LayerManager.tryFallbackStrategy), and no layer is
  // asked to answer about the image in AI Studio's place: the result is an error.
  it('13c AI Studio failing on a PNG: retried once through the workflow, then an error; agy never asked', async () => {
    const r = await mcp('13c-aistudio-fails-png', 'cgmb', { prompt: 'Describe this image', files: [{ path: files.png, type: 'image' }] }, { fail: 'aistudio' });
    assert.deepEqual(r.hits, ['aistudio:text:failed', 'claude', 'aistudio:text:failed', 'claude']);
    assert.equal(r.isError, true);
  });

  it('13h Claude failing on a code file: AI Studio reads the file instead', async () => {
    const r = await mcp('13h-claude-fails-code-file', 'cgmb', { prompt: 'Review this code for bugs', files: [{ path: files.ts, type: 'text' }] }, { fail: 'claude' });
    assert.deepEqual(r.hits, ['claude:failed', 'aistudio:text']);
    assert.equal(r.isError, false);
  });

  it('13d Claude failing under an explicit targetLayer: error, no other layer tried', async () => {
    const r = await mcp('13d-claude-fails-target', 'cgmb', { prompt: NEUTRAL, targetLayer: 'claude' }, { fail: 'claude' });
    assert.deepEqual(r.hits, ['claude:failed']);
    assert.equal(r.isError, true);
  });

  // --- 14: Claude Code not available ------------------------------------------------

  it('14a Claude Code signed out: a reasoning prompt goes to Antigravity, with an info line on stderr', async () => {
    const server = await startServer({ CLAUDE_STUB_SIGNED_OUT: '1' });
    try {
      const r = await mcp('14a-claude-unavailable-reasoning', 'cgmb', { prompt: 'Explain the difference between TCP and UDP' }, { server });
      assert.deepEqual(r.hits, ['antigravity']);
      assert.equal(r.isError, false);
      assert.match(r.text, /The claude layer could not answer \(Claude Code is not available/);
      assert.match(server.stderr(), /Claude Code is not available; answering with the Antigravity CLI instead/);
      assert.deepEqual(server.stdoutLines.filter(line => line.trim() !== '' && !line.startsWith('{"')), []);
    } finally {
      await server.stop();
    }
  });

  it('the server wrote nothing but JSON-RPC to stdout, and no request missed the Gemini stand-in', () => {
    const strays = main.stdoutLines.filter(line => {
      if (line.trim() === '') { return false; }
      try { return JSON.parse(line).jsonrpc !== '2.0'; } catch { return true; }
    });
    assert.deepEqual(strays, []);
    const unrouted = readCalls(stubs.logPath).filter(e => e.kind === 'unrouted');
    assert.deepEqual(unrouted, []);
  });

  // --- CLI: the commands that route through LayerManager ---------------------------

  it('cli-1 `cgmb chat` goes to Antigravity', async () => {
    const r = await cli('cli-1-chat', ['chat', 'Explain the difference between TCP and UDP']);
    assert.deepEqual(r.hits, ['antigravity']);
    assert.equal(r.exitCode, 0);
  });

  it('cli-2 `cgmb analyze <png>` goes to AI Studio', async () => {
    const r = await cli('cli-2-analyze-png', ['analyze', 'photo.png']);
    assert.deepEqual(r.hits, ['aistudio:text']);
    assert.equal(r.exitCode, 0);
  });

  // The same rule as the MCP tool: a source file is code analysis.
  it('cli-3 `cgmb analyze <ts>` goes to Claude, with the file inline', async () => {
    const r = await cli('cli-3-analyze-code', ['analyze', 'util.ts']);
    assert.deepEqual(r.hits, ['claude'], hitsOf(r));
    assert.equal(r.exitCode, 0);
    assert.ok(r.entries.some(e => e.layer === 'claude' && e.promptLength > CODE.length));
  });

  it('cli-4 `cgmb multimodal` with three files is one AI Studio call, not a workflow', async () => {
    const r = await cli('cli-4-multimodal-three', ['multimodal', 'photo.png', 'report.pdf', 'voice.wav']);
    assert.deepEqual(r.hits, ['aistudio:text']);
    assert.equal(r.exitCode, 0);
  });

  // getFallbackOrder drops every layer that cannot read files, so a file task
  // that fails on AI Studio stops there.
  it('cli-5 `cgmb analyze <png>` with AI Studio failing: no fallback, exit 1', async () => {
    const r = await cli('cli-5-analyze-png-aistudio-fails', ['analyze', 'photo.png'], { fail: 'aistudio' });
    assert.deepEqual(r.hits, ['aistudio:text:failed']);
    assert.equal(r.exitCode, 1);
    assert.match(r.text, /no fallback layer can process files/);
  });

  it('cli-6 `cgmb analyze <png> --layer claude` is refused, as targetLayer claude is over MCP', async () => {
    const r = await cli('cli-6-analyze-png-layer-claude', ['analyze', 'photo.png', '--layer', 'claude']);
    assert.deepEqual(r.hits, []);
    assert.notEqual(r.exitCode, 0);
    assert.match(r.text, /The Claude layer cannot read files/);
  });

  it('cli-6b `cgmb analyze <png> --layer gemini` is refused too', async () => {
    const r = await cli('cli-6b-analyze-png-layer-gemini', ['analyze', 'photo.png', '--layer', 'gemini']);
    assert.deepEqual(r.hits, []);
    assert.notEqual(r.exitCode, 0);
    assert.match(r.text, /The antigravity layer cannot read files/);
  });

  it('cli-6c `cgmb analyze <ts> --layer claude` reads the source file inline', async () => {
    const r = await cli('cli-6c-analyze-code-layer-claude', ['analyze', 'util.ts', '--layer', 'claude']);
    assert.deepEqual(r.hits, ['claude']);
    assert.equal(r.exitCode, 0);
  });

  it('cli-7 `cgmb analyze <pdf-url>` downloads the PDF and reads it through AI Studio', async () => {
    const r = await cli('cli-7-analyze-pdf-url', ['analyze', urls.pdf]);
    assert.deepEqual(r.hits, ['aistudio:upload', 'aistudio:text'], hitsOf(r));
    assert.equal(r.exitCode, 0);
    assert.deepEqual(fetched(r), ['/files/report.pdf']);
  });

  it('cli-7b `cgmb analyze <bad pdf-url>`: exit 1 naming AI Studio, no Claude fallback', async () => {
    const r = await cli('cli-7b-analyze-pdf-url-404', ['analyze', `${gemini.baseUrl}/files/missing.pdf`]);
    assert.deepEqual(r.hits, []);
    assert.equal(r.exitCode, 1);
    assert.match(r.text, /The aistudio layer could not read/);
  });

  it('cli-8 `cgmb analyze <pdf-url> <png>` reads both, not just the URL', async () => {
    const r = await cli('cli-8-analyze-pdf-url-plus-png', ['analyze', urls.pdf, 'photo.png']);
    assert.deepEqual(r.hits, ['aistudio:upload', 'aistudio:text', 'aistudio:text'], hitsOf(r));
    assert.equal(r.exitCode, 0);
  });

  it('cli-9 `cgmb analyze <ts>` with Claude Code signed out: AI Studio reads the file', async () => {
    const r = await cli('cli-9-analyze-code-claude-unavailable', ['analyze', 'util.ts'], { extraEnv: { CLAUDE_STUB_SIGNED_OUT: '1' } });
    assert.deepEqual(r.hits, ['aistudio:text'], hitsOf(r));
    assert.equal(r.exitCode, 0);
  });

  it('cli-10 `cgmb process --help` no longer offers --strategy', async () => {
    const r = await cli('cli-10-process-help', ['process', '--help']);
    assert.deepEqual(r.hits, []);
    assert.equal(r.exitCode, 0);
    assert.match(r.text, /--workflow/);
    assert.doesNotMatch(r.text, /--strategy/);
  });
});
