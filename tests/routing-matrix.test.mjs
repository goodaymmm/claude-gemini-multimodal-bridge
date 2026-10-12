/**
 * Routing matrix: which layer each kind of request actually reaches.
 *
 * CGMB's architecture is a router: a request goes to the Antigravity CLI
 * (`agy`, web search / current information), to Claude Code (reasoning), or to
 * the AI Studio MCP sub-server (Gemini API: images, audio, documents). This
 * file drives the real `cgmb serve` MCP server over stdio -- and, for the
 * commands that route on their own, the real CLI -- with all three layers
 * replaced by recording stand-ins (tests/fixtures/routing-stubs.mjs), and pins
 * the order in which the layers were reached for each case.
 *
 * Nothing leaves the machine: agy and claude are node scripts behind
 * ANTIGRAVITY_CLI_PATH / CLAUDE_CODE_PATH, and the AI Studio sub-server's
 * Gemini client is pointed at a local HTTP server by GOOGLE_GEMINI_BASE_URL.
 * Every probe and call lands in one log, in order.
 *
 * Cases marked `todo` assert what the README (or a tool description) promises
 * where the implementation does something else today. They are reported as
 * TODO rather than failures; the observed route of every case, todo or not,
 * can be written out with ROUTING_MATRIX_OUT=<file> to compare two builds.
 *
 * Hit tokens:
 *   antigravity        agy was run with a prompt (probes are not counted)
 *   claude             claude --print was run with a prompt
 *   aistudio:text      generateContent on a text/multimodal model
 *   aistudio:image     generateContent on AI_MODELS.IMAGE_GENERATION
 *   aistudio:tts       generateContent on AI_MODELS.AUDIO_GENERATION
 *   aistudio:upload    a File API upload (scanned PDF)
 *   <token>:failed     the stand-in was told to fail that call
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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

/** One log entry -> one hit token, or null for a probe. */
function token(entry) {
  if (entry.kind === 'probe') { return null; }
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
  let base, work, stubs, gemini, server, env;
  let stdoutLines = [];
  const files = {};

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

  // --- MCP client over stdio -------------------------------------------------
  const pending = new Map();
  let nextId = 1;
  let stderr = '';

  function rpc(method, params, ms = 60000) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out; server stderr tail:\n${stderr.slice(-2000)}`));
      }, ms);
      pending.set(id, message => { clearTimeout(timer); resolve(message); });
      server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  /** Call an MCP tool, optionally with a stand-in told to fail first. */
  async function mcp(id, tool, args, { fail } = {}) {
    resetFailures();
    if (fail === 'aistudio') { gemini.setFailing(true); } else if (fail) { stubs.setFailing(fail, true); }
    const mark = readCalls(stubs.logPath).length;
    try {
      const response = await rpc('tools/call', { name: tool, arguments: args });
      const text = response.result?.content?.map(part => part.text ?? '').join('\n') ?? '';
      return record(id, mark, {
        isError: response.result?.isError === true || response.error !== undefined,
        text,
      });
    } finally {
      resetFailures();
    }
  }

  /** Run one CLI command against the same stand-ins. */
  async function cli(id, args, { fail } = {}) {
    resetFailures();
    if (fail === 'aistudio') { gemini.setFailing(true); } else if (fail) { stubs.setFailing(fail, true); }
    const mark = readCalls(stubs.logPath).length;
    try {
      // Async spawn: the Gemini stand-in runs in this process and has to keep
      // answering while the CLI waits on it.
      const { code, output } = await new Promise(resolve => {
        const child = spawn(process.execPath, [CLI, ...args], { cwd: work, env });
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
    const childTmp = join(base, 'tmp');
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
    files.ts = put('util.ts', 'export const add = (a: number, b: number): number => a + b;\n');

    env = {
      ...process.env,
      AI_STUDIO_API_KEY: FAKE_KEY,
      GOOGLE_GEMINI_BASE_URL: gemini.baseUrl,
      ANTIGRAVITY_CLI_PATH: stubs.agyPath,
      CLAUDE_CODE_PATH: stubs.claudePath,
      // The search cache is in-memory and keyed by prompt. ENABLE_CACHING only
      // switches its metrics; a 1 ms TTL is what keeps it from answering a
      // request without reaching agy.
      ENABLE_CACHING: 'false',
      CACHE_TTL: '1',
      // Auth caches go under HOME. The agy layer's per-request workspaces go
      // under tmpdir(), named cgmb-agy-*, which antigravity-cli.test.mjs scans
      // for leftovers while this file runs in parallel -- keep ours elsewhere.
      HOME: base,
      USERPROFILE: base,
      TMPDIR: childTmp,
      TMP: childTmp,
      TEMP: childTmp,
    };
    for (const key of [
      'NODE_TEST_CONTEXT', 'LOG_LEVEL', 'LOG_FILE', 'CGMB_CLI_MODE', 'CGMB_DEBUG', 'CGMB_PDF_MODE',
      'GEMINI_API_KEY', 'GOOGLE_AI_STUDIO_API_KEY', 'GEMINI_CLI_PATH', 'ANTIGRAVITY_MODEL',
      'CGMB_ENV_PATH', 'CGMB_ALLOWED_ROOTS',
    ]) {
      delete env[key];
    }

    server = spawn(process.execPath, [CLI, 'serve'], { cwd: work, env });
    server.stderr.setEncoding('utf8');
    server.stderr.on('data', chunk => { stderr += chunk; });
    let buffer = '';
    server.stdout.setEncoding('utf8');
    server.stdout.on('data', chunk => {
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

    const init = await rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'routing-matrix', version: '1' },
    });
    assert.ok(init.result, `initialize failed: ${JSON.stringify(init.error)}`);
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  });

  after(async () => {
    if (process.env.ROUTING_MATRIX_OUT) {
      const rows = [...observed.values()]
        .map(({ id, hits, isError, exitCode }) => ({ id, hits, isError, ...(exitCode === undefined ? {} : { exitCode }) }))
        .sort((a, b) => a.id.localeCompare(b.id));
      writeFileSync(process.env.ROUTING_MATRIX_OUT, JSON.stringify(rows, null, 2) + '\n');
    }
    if (server) {
      server.stdin.end();
      const killer = setTimeout(() => server.kill('SIGKILL'), 5000);
      if (server.exitCode === null) { await new Promise(resolve => server.once('exit', resolve)); }
      clearTimeout(killer);
    }
    await gemini?.close();
    if (base) { rmSync(base, { recursive: true, force: true }); }
  });

  /** The prompt text the stand-in for `layer` received in this case. */
  const promptsTo = (result, layer) => result.entries.filter(e => e.layer === layer && e.kind !== 'probe').map(e => e.promptHead ?? '');

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

  // --- 3, 4, 11: reasoning and code without files ------------------------------

  // README: "Claude Code: Complex reasoning, code analysis". The code sends any
  // file-less prompt under 1,000 characters with no workflow/convert/"generate
  // image" wording down LayerManager.processMultimodal's fast path, which runs
  // agy ("Fast path for simple prompts", LayerManager.ts:794).
  it('03 short reasoning prompt takes the fast path to Antigravity', async () => {
    const r = await mcp('03-reasoning-short-en', 'cgmb', { prompt: 'Explain the difference between TCP and UDP' });
    assert.deepEqual(r.hits, ['antigravity']);
    assert.match(r.text, new RegExp(AGY_ANSWER));
  });

  it('11b Japanese reasoning prompt takes the same fast path to Antigravity', async () => {
    const r = await mcp('11b-reasoning-ja', 'cgmb', { prompt: 'TCPとUDPの違いを説明してください' });
    assert.deepEqual(r.hits, ['antigravity']);
  });

  // 1,000+ characters is not "simple", so the analysis workflow runs; a prompt
  // that long counts as complex reasoning and runs sequentially.
  it('03b long reasoning prompt runs the analysis workflow: Claude, AI Studio, Claude', async () => {
    const prompt = 'Explain step by step how congestion control interacts with flow control in TCP. '.repeat(14);
    assert.ok(prompt.length > 1000);
    const r = await mcp('03b-reasoning-long-en', 'cgmb', { prompt });
    assert.deepEqual(r.hits, ['claude', 'aistudio:text', 'claude']);
    assert.match(r.text, new RegExp(CLAUDE_ANSWER));
  });

  it('04 code-writing prompt reaches Claude', {
    todo: 'README routes code to Claude Code (and LayerManager.analyzeTask Priority 6 says so); ' +
      'the MCP path never calls analyzeTask and sends this prompt to agy via the fast path',
  }, async () => {
    const r = await mcp('04-code-en', 'cgmb', { prompt: 'Write a TypeScript function that reverses a string' });
    assert.deepEqual(r.hits, ['claude']);
  });

  // "creat"/"generat" in the prompt selects the generation workflow
  // (CGMBServer.ts:1340), whatever is being created.
  it('04c "create a function" reaches Claude', {
    todo: 'the word "create" selects the generation workflow: AI Studio, Claude, AI Studio',
  }, async () => {
    const r = await mcp('04c-code-create-en', 'cgmb', { prompt: 'Create a TypeScript function that reverses a string' });
    assert.deepEqual(r.hits, ['claude']);
  });

  // "convert"/"transform" selects the conversion workflow (CGMBServer.ts:1342),
  // which ends with an Antigravity quality check.
  it('04d "convert" runs the conversion workflow: Claude, AI Studio, Antigravity', async () => {
    const r = await mcp('04d-convert-en', 'cgmb', { prompt: 'Convert this JSON to YAML: {"a": 1, "b": [2, 3]}' });
    assert.deepEqual(r.hits, ['claude', 'aistudio:text', 'antigravity']);
  });

  // analyzeTask Priority 1 ("Code files - Route to AI Studio") and the
  // single-file fast path agree: a code file is file work, and only AI Studio
  // reads files.
  it('04b a code file goes to AI Studio, not Claude', async () => {
    const r = await mcp('04b-code-file', 'cgmb', { prompt: 'Review this code for bugs', files: [{ path: files.ts, type: 'text' }] });
    assert.deepEqual(r.hits, ['aistudio:text']);
  });

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

  it('08b README wording "generate an image of ..." reaches the image model once, directly', {
    todo: 'CGMBServer.ts:852 matches "generate image", not "generate an image" (README.md:191); ' +
      'the request runs the generation workflow instead: image, Claude, image again, and the reply is Claude\'s text',
  }, async () => {
    const r = await mcp('08b-image-readme-wording', 'cgmb', { prompt: 'Generate an image of a red bicycle' });
    assert.deepEqual(r.hits, ['aistudio:image']);
  });

  it('08c README "create audio saying ..." goes to the AI Studio TTS model', async () => {
    const r = await mcp('08c-tts-readme', 'cgmb', { prompt: "Create audio saying 'Welcome to our podcast'" });
    assert.deepEqual(r.hits, ['aistudio:tts']);
  });

  it('08d "read this aloud" reaches the AI Studio TTS model', {
    todo: 'no TTS keyword matches (CGMBServer.ts:853); the prompt takes the fast path to agy',
  }, async () => {
    const r = await mcp('08d-read-aloud', 'cgmb', { prompt: 'Read this aloud: Welcome to the show' });
    assert.deepEqual(r.hits, ['aistudio:tts']);
  });

  // A Japanese image prompt is translated by agy before it reaches the image
  // model (AIStudioLayer.generateImage -> AntigravityCLILayer.translateToEnglish).
  it('11d Japanese "画像生成" is translated by Antigravity, then generated by AI Studio', async () => {
    const r = await mcp('11d-image-ja-keyword', 'cgmb', { prompt: 'ねこの画像生成をお願いします' });
    assert.deepEqual(r.hits, ['antigravity', 'aistudio:image']);
  });

  it('11e README_JP image example reaches the AI Studio image model', {
    todo: 'README_JP.md:191 "CGMBで未来都市のイメージを生成してください" matches neither 画像生成 nor 画像を作成 ' +
      '(CGMBServer.ts:852) nor "generat"/"creat" (CGMBServer.ts:1340); it takes the fast path to agy and no image is made',
  }, async () => {
    const r = await mcp('11e-image-ja-readme', 'cgmb', { prompt: 'CGMBで未来都市のイメージを生成してください' });
    assert.ok(r.hits.includes('aistudio:image'), `hits: ${r.hits.join(', ')}`);
  });

  it('11f README_JP audio example goes to the AI Studio TTS model', async () => {
    const r = await mcp('11f-audio-ja-readme', 'cgmb', { prompt: 'CGMBで「ポッドキャストへようこそ」という音声を作成してください' });
    assert.deepEqual(r.hits, ['aistudio:tts']);
  });

  // --- 9: URLs ----------------------------------------------------------------

  it('09a a PDF URL goes to AI Studio', async () => {
    const r = await mcp('09a-pdf-url', 'cgmb', { prompt: 'Summarise https://example.com/files/x.pdf' });
    assert.deepEqual(r.hits, ['aistudio:text']);
    assert.equal(r.isError, false);
  });

  it('09a\' ...and the PDF behind the URL reaches Gemini', {
    todo: 'CGMBServer.ts:730 sends the URL as a document to analyze_documents, which skips any path that ' +
      'fs.existsSync() rejects (ai-studio-mcp-server.ts:889): Gemini gets only the prompt text, and the call succeeds',
  }, () => {
    const r = observed.get('09a-pdf-url');
    assert.match(promptsTo(r, 'aistudio')[0] ?? '', /fileData https:\/\/example\.com\/files\/x\.pdf/);
  });

  it('09b a web page URL goes to Antigravity', async () => {
    const r = await mcp('09b-web-url', 'cgmb', { prompt: 'Summarise https://example.com/article' });
    assert.deepEqual(r.hits, ['antigravity']);
    assert.match(promptsTo(r, 'antigravity')[0], /https:\/\/example\.com\/article/);
  });

  it('09c a web URL plus a local PNG still reads the PNG through AI Studio', {
    todo: 'URL routing runs first (CGMBServer.ts:696) and sends the request to agy with files: [], ' +
      'so the attached PNG is dropped without an error',
  }, async () => {
    const r = await mcp('09c-web-url-plus-png', 'cgmb', {
      prompt: 'Does this photo match https://example.com/article',
      files: [{ path: files.png, type: 'image' }],
    });
    assert.ok(r.hits.includes('aistudio:text'), `hits: ${r.hits.join(', ')}`);
  });

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

  it('12e cgmb_multimodal_process honours options.layer_priority', {
    todo: 'layer_priority is in the tool schema (CGMBServer.ts:343) but nothing in LayerManager reads it',
  }, async () => {
    const r = await mcp('12e-layer-priority-claude', 'cgmb_multimodal_process', {
      prompt: 'Describe this image',
      workflow: 'analysis',
      files: [{ path: files.png, type: 'image' }],
      options: { layer_priority: 'claude' },
    });
    assert.ok(r.hits.includes('claude'), `hits: ${r.hits.join(', ')}`);
  });

  // --- 13: failures --------------------------------------------------------------

  // The search auto-route calls the agy layer directly (CGMBServer.ts:828); there
  // is no fallback on that path, so the failure is the answer.
  it('13a agy failing on a search prompt: error, no other layer tried', async () => {
    const r = await mcp('13a-agy-fails-current', 'cgmb', { prompt: 'What is the latest news about Rust today?' }, { fail: 'antigravity' });
    assert.deepEqual(r.hits, ['antigravity:failed']);
    assert.equal(r.isError, true);
    assert.match(r.text, /Antigravity CLI failed/);
  });

  // The fast path catches its own failure and runs the full analysis workflow
  // ("Fast path failed, falling back to full workflow", LayerManager.ts:816).
  it('13b agy failing on a short prompt: fast path falls back to Claude, AI Studio, Claude', async () => {
    const r = await mcp('13b-agy-fails-short', 'cgmb', { prompt: 'Explain the difference between IPv4 and IPv6' }, { fail: 'antigravity' });
    assert.deepEqual(r.hits, ['antigravity:failed', 'claude', 'aistudio:text', 'claude']);
    assert.equal(r.isError, false);
  });

  // The single-file fast path falls back to the full workflow, whose AI Studio
  // step fails again. The workflow's antigravity fallback is never used for a
  // file-carrying step (LayerManager.ts:1425), and no layer is asked to answer
  // about the image in AI Studio's place: the result is an error.
  it('13c AI Studio failing on a PNG: retried once through the workflow, then an error; agy never asked', async () => {
    const r = await mcp('13c-aistudio-fails-png', 'cgmb', { prompt: 'Describe this image', files: [{ path: files.png, type: 'image' }] }, { fail: 'aistudio' });
    assert.deepEqual(r.hits, ['aistudio:text:failed', 'claude', 'aistudio:text:failed', 'claude']);
    assert.equal(r.isError, true);
  });

  it('13d Claude failing under an explicit targetLayer: error, no other layer tried', async () => {
    const r = await mcp('13d-claude-fails-target', 'cgmb', { prompt: NEUTRAL, targetLayer: 'claude' }, { fail: 'claude' });
    assert.deepEqual(r.hits, ['claude:failed']);
    assert.equal(r.isError, true);
  });

  it('the server wrote nothing but JSON-RPC to stdout, and no request missed the Gemini stand-in', () => {
    const strays = stdoutLines.filter(line => {
      if (line.trim() === '') { return false; }
      try { return JSON.parse(line).jsonrpc !== '2.0'; } catch { return true; }
    });
    assert.deepEqual(strays, []);
    const unrouted = readCalls(stubs.logPath).filter(e => e.kind === 'unrouted');
    assert.deepEqual(unrouted, []);
  });

  // --- CLI: the commands that route through LayerManager.analyzeTask -------------

  it('cli-1 `cgmb chat` goes to Antigravity', async () => {
    const r = await cli('cli-1-chat', ['chat', 'Explain the difference between TCP and UDP']);
    assert.deepEqual(r.hits, ['antigravity']);
    assert.equal(r.exitCode, 0);
  });

  it('cli-2 `cgmb analyze <png>` goes to AI Studio (analyzeTask Priority 2)', async () => {
    const r = await cli('cli-2-analyze-png', ['analyze', 'photo.png']);
    assert.deepEqual(r.hits, ['aistudio:text']);
    assert.equal(r.exitCode, 0);
  });

  it('cli-3 `cgmb analyze <ts>` goes to AI Studio (analyzeTask Priority 1)', async () => {
    const r = await cli('cli-3-analyze-code', ['analyze', 'util.ts']);
    assert.deepEqual(r.hits, ['aistudio:text']);
  });

  it('cli-4 `cgmb multimodal` with three files is one AI Studio call, not a workflow', async () => {
    const r = await cli('cli-4-multimodal-three', ['multimodal', 'photo.png', 'report.pdf', 'voice.wav']);
    assert.deepEqual(r.hits, ['aistudio:text']);
    assert.equal(r.exitCode, 0);
  });

  // getFallbackOrder drops every layer that cannot read files, so a file task
  // that fails on AI Studio stops there (LayerManager.ts:575).
  it('cli-5 `cgmb analyze <png>` with AI Studio failing: no fallback, exit 1', async () => {
    const r = await cli('cli-5-analyze-png-aistudio-fails', ['analyze', 'photo.png'], { fail: 'aistudio' });
    assert.deepEqual(r.hits, ['aistudio:text:failed']);
    assert.equal(r.exitCode, 1);
    assert.match(r.text, /no fallback layer can process files/);
  });

  it('cli-6 `cgmb analyze <png> --layer claude` is refused, as targetLayer claude is over MCP', {
    todo: 'CGMBServer.ts:667 refuses Claude for file work; the CLI --layer override has no such check, ' +
      'so Claude answers about an image it never received and the command reports success',
  }, async () => {
    const r = await cli('cli-6-analyze-png-layer-claude', ['analyze', 'photo.png', '--layer', 'claude']);
    assert.deepEqual(r.hits, []);
    assert.notEqual(r.exitCode, 0);
  });

  it('cli-7 `cgmb analyze <pdf-url>` reaches Gemini through AI Studio', {
    todo: 'the CLI sends PDF URLs to the multimodal_process tool, which stat()s the URL as a local path and fails ' +
      '(retried); the command then falls back to Claude, which answers without the document (cli.ts:1857)',
  }, async () => {
    const r = await cli('cli-7-analyze-pdf-url', ['analyze', 'https://example.com/files/x.pdf']);
    assert.deepEqual(r.hits, ['aistudio:text']);
  });
});
