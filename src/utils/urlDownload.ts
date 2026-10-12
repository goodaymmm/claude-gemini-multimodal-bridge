/**
 * Fetch a PDF named by URL into a temporary file, so it can be read like a
 * local one.
 *
 * The AI Studio server used to hand the URL to code that expected a path:
 * analyze_documents skipped it (`fs.existsSync(url)` is false) and asked
 * Gemini about the prompt alone, and multimodal_process passed it to the File
 * API upload, which stat()s its argument and failed. Either way no PDF reached
 * the model, and the first path still reported success.
 *
 * Bounded, because the URL comes from a request: http and https only, at most
 * three redirects (each one checked again), 30 seconds for the whole transfer,
 * 50 MB -- the File API's PDF limit -- checked against Content-Length and again
 * while reading. The body must be a PDF (it starts with `%PDF-`), whatever the
 * server claims: an HTML error page saved as `.pdf` would otherwise be uploaded
 * and "analysed", and a URL that answers with something other than a document
 * is not forwarded to Google.
 */

import { promises as fsPromises } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

export interface PdfDownloadLimits {
  maxBytes: number;
  timeoutMs: number;
  maxRedirects: number;
}

export const PDF_URL_LIMITS: PdfDownloadLimits = {
  maxBytes: 50 * 1024 * 1024,
  timeoutMs: 30_000,
  maxRedirects: 3,
};

export interface DownloadedPdf {
  /** The temporary file. */
  path: string;
  /** The URL the PDF was finally read from, after redirects. */
  finalUrl: string;
  bytes: number;
  /** Removes the file and its directory. Safe to call more than once. */
  cleanup(): Promise<void>;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function checkedUrl(raw: string, base?: URL): URL {
  let url: URL;
  try {
    url = base ? new URL(raw, base) : new URL(raw);
  } catch {
    throw new Error(`Not a valid URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Only http and https URLs are fetched, not ${url.protocol}`);
  }
  return url;
}

/** A file name for the upload's display name: the URL's last segment, made safe. */
function fileNameFor(url: URL): string {
  const last = decodeURIComponent(url.pathname.split('/').pop() ?? '').replace(/[^A-Za-z0-9._-]+/g, '_');
  const base = last.replace(/^[._]+/, '') || 'document';
  return base.toLowerCase().endsWith('.pdf') ? base : `${base}.pdf`;
}

/** True when the first KB holds the PDF header (the spec allows leading junk). */
function looksLikePdf(head: Buffer): boolean {
  return head.subarray(0, 1024).includes('%PDF-');
}

export async function downloadPdfUrl(
  rawUrl: string,
  limits: PdfDownloadLimits = PDF_URL_LIMITS
): Promise<DownloadedPdf> {
  let url = checkedUrl(rawUrl);
  const signal = AbortSignal.timeout(limits.timeoutMs);

  try {
    let response: Response | undefined;
    for (let redirects = 0; ; redirects++) {
      response = await fetch(url, { redirect: 'manual', signal });
      if (!REDIRECTS.has(response.status)) {
        break;
      }
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) {
        throw new Error(`HTTP ${response.status} without a Location header`);
      }
      if (redirects >= limits.maxRedirects) {
        throw new Error(`more than ${limits.maxRedirects} redirects`);
      }
      url = checkedUrl(location, url);
    }

    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
    }

    const declared = Number(response.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > limits.maxBytes) {
      await response.body?.cancel();
      throw new Error(`the PDF is ${(declared / 1024 / 1024).toFixed(1)} MB; the limit is ${limits.maxBytes / 1024 / 1024} MB`);
    }

    const chunks: Buffer[] = [];
    let received = 0;
    if (response.body) {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        received += value.byteLength;
        if (received > limits.maxBytes) {
          await reader.cancel();
          throw new Error(`the PDF is larger than the ${limits.maxBytes / 1024 / 1024} MB limit`);
        }
        chunks.push(Buffer.from(value));
      }
    }
    const body = Buffer.concat(chunks);

    if (!looksLikePdf(body)) {
      const type = response.headers.get('content-type') ?? 'no content type';
      throw new Error(`the response is not a PDF (${type}, ${body.length} bytes)`);
    }

    const dir = await fsPromises.mkdtemp(join(tmpdir(), 'cgmb-pdf-url-'));
    const path = join(dir, fileNameFor(url));
    await fsPromises.writeFile(path, body, { mode: 0o600 });

    return {
      path,
      finalUrl: url.href,
      bytes: body.length,
      cleanup: () => fsPromises.rm(dir, { recursive: true, force: true }),
    };
  } catch (error) {
    const reason = signal.aborted
      ? `no complete answer within ${limits.timeoutMs / 1000} s`
      : (error as Error).message;
    throw new Error(`Could not fetch ${rawUrl}: ${reason}`);
  }
}
