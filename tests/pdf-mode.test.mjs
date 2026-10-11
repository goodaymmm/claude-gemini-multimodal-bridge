/**
 * Local PDF text, reachable: how a PDF gets from a CGMB entry point to Gemini.
 *
 * From 1.1.0 every PDF was uploaded to the Gemini File API. Local extraction
 * stayed in the tree -- DocumentAnalysis, which nothing ever imported, and a
 * private extractPDFText() in the AI Studio MCP server that nothing called --
 * so the feature existed and no user could reach it. Now the MCP server, the
 * one place PDFs leave for Google, reads each local PDF first: a PDF with a text
 * layer goes to the model as text, and a scanned one is uploaded so Gemini can
 * OCR it. pdf_mode (or CGMB_PDF_MODE) overrides the choice.
 *
 * The end-to-end cases run the real CLI and the real MCP servers against a fake
 * Gemini endpoint (GOOGLE_GEMINI_BASE_URL, which @google/genai honours), so no
 * key and no network are needed and every request that would have gone to
 * Google is on record.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  PDF_TEXT_MIN_CHARS_PER_PAGE,
  planPdf,
  resolveMinCharsPerPage,
  resolvePdfMode,
} from '../dist/utils/pdfText.js';
import { CGMBServer } from '../dist/core/CGMBServer.js';
import { AIStudioLayer } from '../dist/layers/AIStudioLayer.js';
import { FAKE_ANSWER, startFakeGemini } from './fixtures/fake-gemini.mjs';
import { makePdf } from './fixtures/make-pdf.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const AI_STUDIO_SERVER = join(ROOT, 'dist', 'mcp-servers', 'ai-studio-mcp-server.js');
const CGMB_SERVER = join(ROOT, 'dist', 'index.js');
const CLI = join(ROOT, 'dist', 'cli.js');

// The key format check wants "AI..." and 20+ characters; the fake ignores it.
const FAKE_KEY = 'AIzaFakeKeyForTestsOnly000000000';

const scratch = mkdtempSync(join(tmpdir(), 'cgmb-pdf-mode-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** About 150 characters of text over three lines: a page of real text, in miniature. */
const PROSE = [
  'Quarterly revenue grew by twelve percent year on year,',
  'while operating costs stayed flat across every region.',
  'The board approved the expansion plan for next spring.',
].join('\n');

function writePdf(name, pages) {
  const file = join(scratch, name);
  writeFileSync(file, makePdf(pages));
  return file;
}

const TEXT_PDF = writePdf('report.pdf', [PROSE, PROSE, PROSE]);
const SCANNED_PDF = writePdf('scan.pdf', [null, null]);
const MIXED_PDF = writePdf('mixed.pdf', [PROSE, null, null]);
const SPARSE_PDF = writePdf('slide.pdf', ['Q3 results']);
const NOT_A_PDF = join(scratch, 'broken.pdf');
writeFileSync(NOT_A_PDF, 'this is not a PDF');

/** An environment for a child: the fake endpoint, a fake key, and nothing that changes logging. */
function childEnv(fake, extra = {}) {
  const env = {
    ...process.env,
    AI_STUDIO_API_KEY: FAKE_KEY,
    GEMINI_API_KEY: FAKE_KEY,
    GOOGLE_AI_STUDIO_API_KEY: FAKE_KEY,
    GOOGLE_GEMINI_BASE_URL: fake.baseUrl,
    // Auth caches and agy lookups go under HOME; keep them out of the user's.
    HOME: scratch,
    USERPROFILE: scratch,
    ...extra,
  };
  for (const name of ['NODE_TEST_CONTEXT', 'LOG_LEVEL', 'CGMB_CLI_MODE', 'CGMB_DEBUG', 'LOG_FILE', 'CGMB_PDF_MODE', 'CGMB_PDF_TEXT_MIN_CHARS']) {
    if (!(name in extra)) { delete env[name]; }
  }
  return env;
}

/** The parts of a generateContent request body, flattened. */
function partsOf(body) {
  return (body?.contents ?? []).flatMap(content => content.parts ?? []);
}

/**
 * An MCP client over a child's stdio. Keeps every stdout line so a test can
 * check that nothing but JSON-RPC was ever written there.
 */
class McpChild {
  constructor(script, env) {
    this.lines = [];
    this.stderr = '';
    this.pending = new Map();
    this.nextId = 1;
    this.child = spawn(process.execPath, [script], { cwd: scratch, env, windowsHide: true });
    this.exited = new Promise(resolve => this.child.on('exit', resolve));

    let buffered = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => {
      buffered += chunk;
      let brk;
      while ((brk = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, brk);
        buffered = buffered.slice(brk + 1);
        this.lines.push(line);
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
      clientInfo: { name: 'pdf-mode-test', version: '1' },
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

  /** Every stdout line, checked to be a JSON-RPC 2.0 frame. */
  assertStdoutIsJsonRpc() {
    const strays = this.lines.filter(line => {
      if (line.trim() === '') { return false; }
      try { return JSON.parse(line).jsonrpc !== '2.0'; } catch { return true; }
    });
    assert.deepEqual(strays, [], 'stdout is the MCP channel; anything else on it corrupts the stream');
  }
}

/** Run the CLI to completion. */
function cgmb(args, env) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: scratch, env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
    child.on('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

// ===================================
// The rule
// ===================================

describe('deciding how a PDF reaches the model', () => {
  it('sends the text of a PDF that has a text layer, page by page', async () => {
    const plan = await planPdf(TEXT_PDF, 'auto');

    assert.equal(plan.action, 'text');
    assert.equal(plan.numpages, 3);
    assert.equal(plan.textPages, 3);
    assert.match(plan.text, /^\[PDF document: report\.pdf, 3 pages, text extracted locally\]/);
    assert.match(plan.text, /--- Page 1 ---\nQuarterly revenue grew/);
    assert.match(plan.text, /--- Page 3 ---/);
  });

  it('uploads a PDF with no text, so Gemini can OCR it', async () => {
    const plan = await planPdf(SCANNED_PDF, 'auto');

    assert.equal(plan.action, 'upload');
    assert.equal(plan.chars, 0);
    assert.match(plan.reason, /0 of 2 pages/);
  });

  it('uploads a partly scanned PDF rather than send only its readable pages', async () => {
    const plan = await planPdf(MIXED_PDF, 'auto');

    assert.equal(plan.action, 'upload');
    assert.match(plan.reason, /1 of 3 pages/);
  });

  it(`counts a page as text from ${PDF_TEXT_MIN_CHARS_PER_PAGE} characters, and that is adjustable`, async () => {
    assert.equal((await planPdf(SPARSE_PDF, 'auto')).action, 'upload');
    assert.equal((await planPdf(SPARSE_PDF, 'auto', 5)).action, 'text');
    assert.equal(resolveMinCharsPerPage({}), PDF_TEXT_MIN_CHARS_PER_PAGE);
    assert.equal(resolveMinCharsPerPage({ CGMB_PDF_TEXT_MIN_CHARS: '5' }), 5);
    assert.throws(() => resolveMinCharsPerPage({ CGMB_PDF_TEXT_MIN_CHARS: 'lots' }), /whole number/);
  });

  it('falls back to upload when the file cannot be read locally', async () => {
    const plan = await planPdf(NOT_A_PDF, 'auto');

    assert.equal(plan.action, 'upload');
    assert.match(plan.reason, /local text extraction failed/);
  });

  it('in local mode, sends whatever text there is and refuses a PDF with none', async () => {
    assert.equal((await planPdf(SPARSE_PDF, 'local')).action, 'text');
    await assert.rejects(planPdf(SCANNED_PDF, 'local'), /no extractable text/);
    await assert.rejects(planPdf(NOT_A_PDF, 'local'), /Cannot read broken\.pdf locally/);
  });

  it('in upload mode, does not open the file at all', async () => {
    // Not a PDF: reading it would fail, so an upload plan proves it was not read.
    const plan = await planPdf(NOT_A_PDF, 'upload');

    assert.deepEqual(plan, { action: 'upload', reason: 'pdf_mode is upload' });
  });

  it('takes the mode from the request, then CGMB_PDF_MODE, then auto, and rejects anything else', () => {
    assert.equal(resolvePdfMode(undefined, {}), 'auto');
    assert.equal(resolvePdfMode(undefined, { CGMB_PDF_MODE: 'upload' }), 'upload');
    assert.equal(resolvePdfMode('local', { CGMB_PDF_MODE: 'upload' }), 'local');
    assert.throws(() => resolvePdfMode('ocr', {}), /pdf_mode must be one of auto, local, upload/);
    assert.throws(() => resolvePdfMode(undefined, { CGMB_PDF_MODE: 'Upload' }), /CGMB_PDF_MODE must be one of/);
  });
});

// ===================================
// The AI Studio MCP server, where PDFs leave for Google
// ===================================

describe('the AI Studio MCP server', () => {
  let fake;
  let server;

  before(async () => {
    fake = await startFakeGemini();
    server = await new McpChild(AI_STUDIO_SERVER, childEnv(fake, { CGMB_ALLOWED_ROOTS: scratch })).start();
  });

  after(async () => {
    await server?.close();
    await fake?.close();
  });

  it('answers a text PDF from its local text, without touching the File API', async () => {
    fake.reset();

    const response = await server.call('analyze_documents', { documents: [TEXT_PDF], instructions: 'Summarise' });

    assert.equal(response.error, undefined, JSON.stringify(response.error));
    assert.equal(response.result.content[0].text, FAKE_ANSWER);
    assert.equal(fake.uploadStarts().length, 0, 'a text PDF must not be uploaded');

    const [request] = fake.generateCalls();
    const parts = partsOf(request);
    assert.ok(parts.some(part => /text extracted locally/.test(part.text ?? '') && /Quarterly revenue grew/.test(part.text)));
    assert.ok(!parts.some(part => part.fileData), 'no file reference when the text was sent');

    assert.deepEqual(response.result.metadata.pdfs.map(p => [p.file, p.sent_as, p.mode]), [['report.pdf', 'text', 'auto']]);
  });

  it('uploads a scanned PDF, and says so on stderr at info level', async () => {
    fake.reset();

    const response = await server.call('analyze_documents', { documents: [SCANNED_PDF], instructions: 'Summarise' });

    assert.equal(response.error, undefined, JSON.stringify(response.error));
    assert.equal(fake.uploadStarts().length, 1, 'a scanned PDF must be uploaded');

    const [request] = fake.generateCalls();
    assert.ok(
      partsOf(request).some(part => part.fileData?.mimeType === 'application/pdf' && /\/files\/fake-/.test(part.fileData.fileUri)),
      'the request must refer to the uploaded file'
    );

    const [handling] = response.result.metadata.pdfs;
    assert.equal(handling.sent_as, 'upload');
    assert.match(handling.reason, /0 of 2 pages/);
    assert.match(server.stderr, /info.*PDF scan\.pdf: uploading to the Gemini File API/);
  });

  it('honours pdf_mode on multimodal_process', async () => {
    fake.reset();

    const response = await server.call('multimodal_process', {
      files: [{ path: TEXT_PDF, type: 'pdf' }],
      instructions: 'Summarise',
      pdf_mode: 'upload',
    });

    assert.equal(response.error, undefined, JSON.stringify(response.error));
    assert.equal(fake.uploadStarts().length, 1, 'pdf_mode upload must upload even a text PDF');
    assert.equal(response.result.metadata.pdfs[0].sent_as, 'upload');
  });

  it('refuses local mode for a PDF with no text, before anything is sent', async () => {
    fake.reset();

    const response = await server.call('multimodal_process', {
      files: [{ path: SCANNED_PDF, type: 'pdf' }],
      instructions: 'Summarise',
      pdf_mode: 'local',
    });

    assert.ok(response.error, 'a scanned PDF in local mode must fail, not be answered from nothing');
    assert.match(response.error.message, /no extractable text/);
    assert.equal(fake.requests.length, 0);
  });

  it('rejects an unknown pdf_mode as invalid params, on both tools', async () => {
    fake.reset();

    const documents = await server.call('analyze_documents', {
      documents: [TEXT_PDF],
      instructions: 'Summarise',
      pdf_mode: 'ocr',
    });
    const multimodal = await server.call('multimodal_process', {
      files: [{ path: TEXT_PDF, type: 'pdf' }],
      instructions: 'Summarise',
      pdf_mode: 'ocr',
    });

    for (const response of [documents, multimodal]) {
      assert.equal(response.error?.code, -32602, JSON.stringify(response.error));
      assert.match(response.error.message, /pdf_mode must be one of auto, local, upload/);
    }
    assert.equal(fake.requests.length, 0);
  });

  it('lists pdf_mode on both tools that read PDFs', async () => {
    const response = await server.request('tools/list', {});
    const tools = Object.fromEntries(response.result.tools.map(tool => [tool.name, tool.inputSchema]));

    for (const name of ['analyze_documents', 'multimodal_process']) {
      assert.deepEqual(tools[name].properties.pdf_mode.enum, ['auto', 'local', 'upload'], name);
      assert.ok(!tools[name].required.includes('pdf_mode'), `${name}: pdf_mode must stay optional`);
    }
  });

  it('wrote nothing to stdout but JSON-RPC', () => {
    server.assertStdoutIsJsonRpc();
  });
});

describe('CGMB_PDF_MODE', () => {
  it('sets the mode for requests that do not name one', async () => {
    const fake = await startFakeGemini();
    const server = await new McpChild(
      AI_STUDIO_SERVER,
      childEnv(fake, { CGMB_ALLOWED_ROOTS: scratch, CGMB_PDF_MODE: 'upload' })
    ).start();

    try {
      const response = await server.call('analyze_documents', { documents: [TEXT_PDF], instructions: 'Summarise' });

      assert.equal(response.error, undefined, JSON.stringify(response.error));
      assert.equal(fake.uploadStarts().length, 1);
      assert.equal(response.result.metadata.pdfs[0].mode, 'upload');
      server.assertStdoutIsJsonRpc();
    } finally {
      await server.close();
      await fake.close();
    }
  });
});

// ===================================
// The entry points users reach
// ===================================

describe('cgmb analyze', () => {
  let fake;

  before(async () => { fake = await startFakeGemini(); });
  after(async () => { await fake?.close(); });

  it('reads a text PDF locally', async () => {
    fake.reset();

    const run = await cgmb(['analyze', TEXT_PDF], childEnv(fake));

    assert.equal(run.status, 0, run.stderr.slice(-2000));
    assert.match(run.stdout, new RegExp(FAKE_ANSWER));
    assert.match(run.stdout, /PDF report\.pdf: read locally, sent as text \(3 pages\)/);
    assert.equal(fake.uploadStarts().length, 0);
    assert.ok(partsOf(fake.generateCalls()[0]).some(part => /Quarterly revenue grew/.test(part.text ?? '')));
  });

  it('uploads a scanned PDF', async () => {
    fake.reset();

    const run = await cgmb(['analyze', SCANNED_PDF], childEnv(fake));

    assert.equal(run.status, 0, run.stderr.slice(-2000));
    assert.match(run.stdout, /PDF scan\.pdf: uploaded to the Gemini File API/);
    assert.equal(fake.uploadStarts().length, 1);
  });

  it('uploads a text PDF when told to with --pdf-mode upload', async () => {
    fake.reset();

    const run = await cgmb(['analyze', TEXT_PDF, '--pdf-mode', 'upload'], childEnv(fake));

    assert.equal(run.status, 0, run.stderr.slice(-2000));
    assert.match(run.stdout, /PDF report\.pdf: uploaded to the Gemini File API \(pdf_mode is upload\)/);
    assert.equal(fake.uploadStarts().length, 1);
  });

  it('refuses an unknown --pdf-mode before calling anything', async () => {
    fake.reset();

    const run = await cgmb(['analyze', TEXT_PDF, '--pdf-mode', 'ocr'], childEnv(fake));

    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /Allowed choices are auto, local, upload/);
    assert.equal(fake.requests.length, 0);
  });
});

describe('the cgmb MCP tool', () => {
  it('carries options.pdf_mode through to the AI Studio server', async () => {
    const fake = await startFakeGemini();
    const server = await new McpChild(CGMB_SERVER, childEnv(fake)).start();

    try {
      const response = await server.call('cgmb', {
        prompt: 'CGMB summarise this report',
        files: [{ path: TEXT_PDF, type: 'pdf' }],
        options: { pdf_mode: 'upload' },
      });

      assert.equal(response.error, undefined, JSON.stringify(response.error));
      assert.match(response.result.content[0].text, new RegExp(FAKE_ANSWER));
      assert.equal(fake.uploadStarts().length, 1, 'options.pdf_mode upload must reach the server that uploads');

      fake.reset();
      const local = await server.call('cgmb', {
        prompt: 'CGMB summarise this report',
        files: [{ path: TEXT_PDF, type: 'pdf' }],
      });

      assert.equal(local.error, undefined, JSON.stringify(local.error));
      assert.equal(fake.uploadStarts().length, 0, 'by default a text PDF is read locally');
      assert.ok(partsOf(fake.generateCalls()[0]).some(part => /Quarterly revenue grew/.test(part.text ?? '')));

      server.assertStdoutIsJsonRpc();
    } finally {
      await server.close();
      await fake.close();
    }
  });

  it('carries options.pdf_mode on cgmb_document_analysis to the AI Studio step', async () => {
    // In-process with stubbed layers: this workflow also runs Claude, which is
    // not something a test can start.
    const server = new CGMBServer();
    const calls = [];
    const manager = server.layerManager;
    for (const [name, field] of [['aistudio', 'aiStudioLayer'], ['claude', 'claudeLayer'], ['antigravity', 'antigravityLayer']]) {
      const stub = {
        initialize: async () => {},
        isAvailable: async () => true,
        execute: async task => {
          calls.push({ layer: name, task });
          return { success: true, data: `stub:${name}`, metadata: { layer: name, duration: 0 } };
        },
      };
      manager[field] = stub;
      manager[`${field}Promise`] = Promise.resolve(stub);
      manager.layerInitialized[name] = true;
    }

    await server.handleDocumentAnalysis({ documents: [TEXT_PDF], analysis_type: 'summary', options: { pdf_mode: 'local' } });
    await assert.rejects(
      server.handleDocumentAnalysis({ documents: [TEXT_PDF], analysis_type: 'summary', options: { pdf_mode: 'ocr' } })
    );

    const aiStudioTasks = calls.filter(call => call.layer === 'aistudio').map(call => call.task);
    assert.equal(aiStudioTasks.length, 1);
    assert.equal(aiStudioTasks[0].pdf_mode, 'local');
  });
});

describe('the AI Studio layer', () => {
  /** A real layer whose MCP calls are recorded instead of sent. */
  function recordingLayer() {
    const layer = new AIStudioLayer();
    const sent = [];
    layer.isInitialized = true;
    layer.executeMCPCommand = async (command, params) => { sent.push({ command, params }); return { analysis: 'ok', content: 'ok' }; };
    layer.executeMCPCommandOptimized = layer.executeMCPCommand;
    return { layer, sent };
  }

  it('passes pdf_mode on to the server from every action that sends PDFs', async () => {
    const { layer, sent } = recordingLayer();

    await layer.execute({ prompt: 'p', files: [{ path: TEXT_PDF, type: 'pdf' }], options: { pdf_mode: 'local' } });
    await layer.execute({ action: 'process_documents', documents: [TEXT_PDF], instructions: 'p', pdf_mode: 'upload' });
    await layer.execute({ type: 'multimodal_processing', prompt: 'p', files: [{ path: TEXT_PDF, type: 'document' }], options: { pdf_mode: 'auto' } });

    assert.deepEqual(sent.map(s => [s.command, s.params.pdf_mode]), [
      ['multimodal_process', 'local'],
      ['analyze_documents', 'upload'],
      ['multimodal_process', 'auto'],
    ]);
  });

  it('sends no pdf_mode when none was asked for, so the server default applies', async () => {
    const { layer, sent } = recordingLayer();

    await layer.execute({ prompt: 'p', files: [{ path: TEXT_PDF, type: 'pdf' }] });

    assert.equal('pdf_mode' in sent[0].params, false);
  });
});
