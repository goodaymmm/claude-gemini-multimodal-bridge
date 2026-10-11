/**
 * Local PDF text extraction (src/utils/pdfText.ts), through pdf-parse 2.
 *
 * pdf-parse 1 was a function; 2 is a class over pdfjs-dist 5 with a different
 * result shape, and the move between them is exactly the kind of change that
 * compiles and then returns nothing. There is no real PDF in the repository, so
 * the documents here are written by hand: the smallest valid PDF that carries a
 * text object, with an xref table whose offsets are computed rather than typed.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync, ftruncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { extractPdfText, PDF_MAX_BYTES, PDF_MAX_PAGES } from '../dist/utils/pdfText.js';

const PDF_TEXT = pathToFileURL(join(fileURLToPath(new URL('.', import.meta.url)), '..', 'dist', 'utils', 'pdfText.js')).href;

const scratch = mkdtempSync(join(tmpdir(), 'cgmb-pdf-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** A PDF with one page per entry of `pageTexts`, each drawing its string in Helvetica. */
function makePdf(pageTexts) {
  const objects = [];
  const add = body => { objects.push(body); return objects.length; };

  const catalog = add(null);
  const pages = add(null);
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids = [];
  for (const text of pageTexts) {
    const escaped = text.replace(/[\\()]/g, ch => `\\${ch}`);
    const stream = `BT /F1 24 Tf 72 720 Td (${escaped}) Tj ET`;
    const contents = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    kids.push(add(
      `<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 612 792] /Contents ${contents} 0 R ` +
      `/Resources << /Font << /F1 ${font} 0 R >> >> >>`
    ));
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pages} 0 R >>`;
  objects[pages - 1] = `<< /Type /Pages /Kids [${kids.map(k => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;

  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) { out += `${String(offset).padStart(10, '0')} 00000 n \n`; }
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

function writePdf(name, pageTexts) {
  const file = join(scratch, name);
  writeFileSync(file, makePdf(pageTexts));
  return file;
}

/**
 * Extract `file` in a child process and return its stdout and the text it got.
 *
 * A child, because the test runner's own worker talks to its parent over
 * stdout: anything captured in-process would include the runner's messages.
 */
function extractInChild(file) {
  const script = [
    `const { extractPdfText } = await import(${JSON.stringify(PDF_TEXT)});`,
    `const result = await extractPdfText(${JSON.stringify(file)});`,
    `process.stderr.write('RESULT ' + JSON.stringify(result.text) + '\\n');`,
  ].join('\n');
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8', windowsHide: true });
}

describe('extracting text from a PDF', () => {
  it('reads the text of a one-page PDF', async () => {
    const file = writePdf('one.pdf', ['Hello from CGMB']);

    const result = await extractPdfText(file);

    assert.equal(result.numpages, 1);
    assert.equal(result.text, 'Hello from CGMB');
  });

  it('reads every page, in order, without page markers', async () => {
    // pdf-parse 2 appends "-- 1 of 2 --" after each page unless told not to;
    // pdf-parse 1 did not, and nothing downstream expects it.
    const file = writePdf('two.pdf', ['First page', 'Second page']);

    const result = await extractPdfText(file);

    assert.equal(result.numpages, 2);
    assert.match(result.text, /First page\s+Second page/);
    assert.doesNotMatch(result.text, /-- \d+ of \d+ --/);
  });

  it('writes nothing to stdout, which is the MCP channel', async () => {
    const file = writePdf('quiet.pdf', ['Quiet please']);

    const run = extractInChild(file);

    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /RESULT "Quiet please"/);
    assert.equal(run.stdout, '', 'pdf.js output on stdout would corrupt the MCP stream');
  });

  it(`refuses a file over ${PDF_MAX_BYTES / 1024 / 1024} MB without reading it`, async () => {
    const file = join(scratch, 'huge.pdf');
    const fd = openSync(file, 'w');
    ftruncateSync(fd, PDF_MAX_BYTES + 1); // sparse: costs no disk
    closeSync(fd);

    await assert.rejects(extractPdfText(file), /too large/i);
  });

  it(`refuses a document of more than ${PDF_MAX_PAGES} pages`, async () => {
    const file = writePdf('long.pdf', Array.from({ length: PDF_MAX_PAGES + 1 }, (_, i) => `p${i + 1}`));

    await assert.rejects(extractPdfText(file), /too many pages/i);
  });

  it('rejects something that is not a PDF', async () => {
    const file = join(scratch, 'not.pdf');
    writeFileSync(file, 'this is plain text');

    await assert.rejects(extractPdfText(file));
  });
});
