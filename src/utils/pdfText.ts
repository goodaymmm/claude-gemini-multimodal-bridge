import { promises as fs } from 'fs';

/**
 * Local PDF text extraction, through pdf-parse 2.
 *
 * pdf-parse 1 was a function, `pdfParse(buffer, { max, version, pagerender })`,
 * reached through its internal `pdf-parse/lib/pdf-parse.js` path to avoid the
 * debug mode its index ran when it had no parent module. pdf-parse 2 is a class
 * over pdfjs-dist 5 (`new PDFParse({ data })`, then `getInfo()` / `getText()`),
 * with no page-render callback, so both callers now share this one function
 * instead of carrying their own copies of the call.
 *
 * The limits are the ones the README gives for PDFs (50 MB, 1,000 pages), so a
 * document that is out of range is refused here rather than half-read.
 */

/** Largest PDF accepted, matching the Gemini File API limit the README documents. */
export const PDF_MAX_BYTES = 50 * 1024 * 1024;

/** Most pages accepted, matching the Gemini File API limit the README documents. */
export const PDF_MAX_PAGES = 1000;

export interface PdfTextResult {
  /** The extracted text, pages separated by a blank line, trimmed. */
  text: string;
  /** Number of pages in the document. */
  numpages: number;
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

    const extracted: PdfTextResult = { text: result.text.trim(), numpages: result.total };
    if (info.info) { extracted.info = info.info as Record<string, unknown>; }
    if (info.metadata) { extracted.metadata = info.metadata; }
    return extracted;
  } finally {
    await parser.destroy();
  }
}
