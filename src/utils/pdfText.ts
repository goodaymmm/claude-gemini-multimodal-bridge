import { promises as fs } from 'fs';
import path from 'path';

/**
 * Local PDF text extraction, through pdf-parse 2.
 *
 * pdf-parse 1 was a function, `pdfParse(buffer, { max, version, pagerender })`,
 * reached through its internal `pdf-parse/lib/pdf-parse.js` path to avoid the
 * debug mode its index ran when it had no parent module. pdf-parse 2 is a class
 * over pdfjs-dist 5 (`new PDFParse({ data })`, then `getInfo()` / `getText()`),
 * with no page-render callback.
 *
 * The limits are the ones the README gives for PDFs (50 MB, 1,000 pages), so a
 * document that is out of range is refused here rather than half-read.
 *
 * {@link planPdf} is what the AI Studio MCP server calls for every local PDF:
 * it decides whether the model gets the extracted text or the uploaded file.
 */

/** Largest PDF accepted, matching the Gemini File API limit the README documents. */
export const PDF_MAX_BYTES = 50 * 1024 * 1024;

/** Most pages accepted, matching the Gemini File API limit the README documents. */
export const PDF_MAX_PAGES = 1000;

export interface PdfPageText {
  /** 1-based page number. */
  num: number;
  /** The page's text, trimmed. */
  text: string;
}

export interface PdfTextResult {
  /** The extracted text, pages separated by a blank line, trimmed. */
  text: string;
  /** Number of pages in the document. */
  numpages: number;
  /** The text of each page, in order. */
  pages: PdfPageText[];
  /** The document information dictionary (Title, Author, ...), if any. */
  info?: Record<string, unknown>;
  /** XMP metadata as pdf.js exposes it, if any. */
  metadata?: unknown;
}

/**
 * Extract the text of a PDF file.
 *
 * Throws when the file is larger than {@link PDF_MAX_BYTES}, has more than
 * {@link PDF_MAX_PAGES} pages, or cannot be parsed. Nothing is written to
 * stdout: pdf.js runs at its ERRORS verbosity, and its warnings go to stderr.
 */
export async function extractPdfText(filePath: string): Promise<PdfTextResult> {
  const stats = await fs.stat(filePath);
  if (stats.size > PDF_MAX_BYTES) {
    throw new Error(
      `PDF file too large: ${(stats.size / 1024 / 1024).toFixed(1)}MB (max ${PDF_MAX_BYTES / 1024 / 1024}MB)`
    );
  }

  // Imported here, not at the top: pdf-parse loads pdfjs-dist, which is large
  // and is only needed when a PDF actually has to be read locally.
  const { PDFParse } = await import('pdf-parse');

  const data = await fs.readFile(filePath);
  const parser = new PDFParse({ data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) });

  try {
    const info = await parser.getInfo();
    if (info.total > PDF_MAX_PAGES) {
      throw new Error(`PDF has too many pages: ${info.total} (max ${PDF_MAX_PAGES})`);
    }

    const result = await parser.getText({
      // pdf-parse 1 joined pages with a blank line and nothing else. Version 2
      // adds a "-- 1 of N --" marker after each page and a tab between widely
      // spaced items on one line unless these are switched off; a space keeps
      // words on the same line apart without inventing table columns.
      pageJoiner: '',
      cellSeparator: ' ',
    });

    const extracted: PdfTextResult = {
      text: result.text.trim(),
      numpages: result.total,
      pages: result.pages.map(page => ({ num: page.num, text: page.text.trim() })),
    };
    if (info.info) { extracted.info = info.info as Record<string, unknown>; }
    if (info.metadata) { extracted.metadata = info.metadata; }
    return extracted;
  } finally {
    await parser.destroy();
  }
}

// ===================================
// Text first, upload when it has to
// ===================================

/**
 * How a local PDF reaches the model.
 *
 * - `auto`: extract the text locally and send that when the PDF has a real text
 *   layer; upload the file through the Gemini File API when it does not (a
 *   scanned or image-only PDF), so Gemini can OCR it.
 * - `local`: always send the locally extracted text. A PDF with no text at all
 *   is refused rather than sent as nothing.
 * - `upload`: always upload the file, as every version from 1.1.0 to 1.2.3 did.
 */
export const PDF_MODES = ['auto', 'local', 'upload'] as const;
export type PdfMode = typeof PDF_MODES[number];

/** Environment variable that sets the mode when a request does not. */
export const PDF_MODE_ENV = 'CGMB_PDF_MODE';

/** Environment variable that overrides {@link PDF_TEXT_MIN_CHARS_PER_PAGE}. */
export const PDF_MIN_CHARS_ENV = 'CGMB_PDF_TEXT_MIN_CHARS';

/**
 * Characters of text (whitespace not counted) a page needs to count as a text
 * page. A scanned page has none, or a stray page number; a page of prose has
 * well over a thousand, a sparse slide around a hundred.
 */
export const PDF_TEXT_MIN_CHARS_PER_PAGE = 100;

/**
 * Share of pages that must be text pages for `auto` to send text. Below it the
 * PDF is treated as scanned, or as partly scanned, and is uploaded: sending the
 * text of the readable pages would silently drop the others.
 */
export const PDF_TEXT_MIN_PAGE_SHARE = 0.8;

function isPdfMode(value: unknown): value is PdfMode {
  return typeof value === 'string' && (PDF_MODES as readonly string[]).includes(value);
}

/**
 * The mode a request runs in: the one it asked for, else CGMB_PDF_MODE, else
 * `auto`. An unknown value is an error, not a silent `auto`: a typo in
 * `upload` should not quietly change what is sent to Google.
 */
export function resolvePdfMode(requested?: unknown, env: NodeJS.ProcessEnv = process.env): PdfMode {
  if (requested !== undefined && requested !== null) {
    if (!isPdfMode(requested)) {
      throw new Error(`pdf_mode must be one of ${PDF_MODES.join(', ')} (got ${JSON.stringify(requested)})`);
    }
    return requested;
  }

  const fromEnv = env[PDF_MODE_ENV]?.trim();
  if (fromEnv) {
    if (!isPdfMode(fromEnv)) {
      throw new Error(`${PDF_MODE_ENV} must be one of ${PDF_MODES.join(', ')} (got ${JSON.stringify(fromEnv)})`);
    }
    return fromEnv;
  }

  return 'auto';
}

/** The per-page threshold: CGMB_PDF_TEXT_MIN_CHARS if set, else the default. */
export function resolveMinCharsPerPage(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[PDF_MIN_CHARS_ENV]?.trim();
  if (!raw) {
    return PDF_TEXT_MIN_CHARS_PER_PAGE;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${PDF_MIN_CHARS_ENV} must be a whole number of characters (got ${JSON.stringify(raw)})`);
  }
  return value;
}

/** Characters on a page, not counting whitespace. */
function visibleChars(text: string): number {
  return text.replace(/\s+/g, '').length;
}

/** What to do with one local PDF. */
export type PdfPlan =
  | {
      action: 'text';
      /** The text to send to the model, with a header and page markers. */
      text: string;
      numpages: number;
      /** Pages that met the threshold. */
      textPages: number;
      chars: number;
    }
  | {
      action: 'upload';
      /** Why the file is being uploaded rather than read locally. */
      reason: string;
      numpages?: number;
      textPages?: number;
      chars?: number;
    };

/** The extracted text as the model sees it: a header, then each page marked. */
export function formatPdfTextForModel(fileName: string, result: PdfTextResult): string {
  const header = `[PDF document: ${fileName}, ${result.numpages} page${result.numpages === 1 ? '' : 's'}, text extracted locally]`;
  const body = result.pages
    .map(page => `--- Page ${page.num} ---\n${page.text}`)
    .join('\n\n');
  return `${header}\n\n${body}`;
}

/**
 * Decide how one local PDF reaches the model, extracting its text if needed.
 *
 * Never uploads anything itself; the caller acts on the plan. Throws only in
 * `local` mode, when the text cannot be had: there is no fallback to fall to.
 */
export async function planPdf(
  filePath: string,
  mode: PdfMode,
  minCharsPerPage: number = PDF_TEXT_MIN_CHARS_PER_PAGE
): Promise<PdfPlan> {
  if (mode === 'upload') {
    return { action: 'upload', reason: 'pdf_mode is upload' };
  }

  const name = path.basename(filePath);

  let result: PdfTextResult;
  try {
    result = await extractPdfText(filePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (mode === 'local') {
      throw new Error(`Cannot read ${name} locally: ${message}`);
    }
    return { action: 'upload', reason: `local text extraction failed: ${message}` };
  }

  const chars = result.pages.reduce((sum, page) => sum + visibleChars(page.text), 0);
  const textPages = result.pages.filter(page => visibleChars(page.text) >= minCharsPerPage).length;
  const numpages = result.numpages;

  if (mode === 'local') {
    if (chars === 0) {
      throw new Error(
        `${name} has no extractable text, so it looks scanned. ` +
        'Use pdf_mode "auto" or "upload" to have Gemini OCR it.'
      );
    }
    return { action: 'text', text: formatPdfTextForModel(name, result), numpages, textPages, chars };
  }

  if (numpages > 0 && textPages / numpages >= PDF_TEXT_MIN_PAGE_SHARE) {
    return { action: 'text', text: formatPdfTextForModel(name, result), numpages, textPages, chars };
  }

  return {
    action: 'upload',
    reason: `only ${textPages} of ${numpages} page${numpages === 1 ? ' has' : 's have'} ` +
      `${minCharsPerPage}+ characters of text, so it looks scanned or image-only`,
    numpages,
    textPages,
    chars,
  };
}
