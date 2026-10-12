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
 *
 * The URL can come from a prompt injection, so CGMB must not become a way to
 * reach what only this machine can: every host -- the first URL's and each
 * redirect target's -- is resolved and refused if any of its addresses is
 * private, loopback, link-local (cloud metadata at 169.254.169.254 among them),
 * CGNAT, multicast or reserved, or if it is `localhost`, and the connection goes
 * to an address that check approved, not to a second lookup's answer.
 * CGMB_ALLOW_PRIVATE_URLS=true lifts that check, for PDFs served on a local
 * network. A redirect from https
 * to http is refused whatever the setting; http to https is followed. A refused
 * address gets one message whatever the address was, so the error cannot be
 * used to map which internal hosts exist.
 */

import { promises as dns, type LookupAddress, type LookupOptions } from 'dns';
import { promises as fsPromises } from 'fs';
import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'http';
import { request as httpsRequest } from 'https';
import { isIP, type LookupFunction } from 'net';
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

/** Set to `true` to let PDF URLs reach private, loopback and link-local addresses. */
export const ALLOW_PRIVATE_URLS_ENV = 'CGMB_ALLOW_PRIVATE_URLS';

/** The reason given for every refused address; deliberately the same for all of them. */
export const ADDRESS_NOT_ALLOWED = 'the address is not allowed';

function privateUrlsAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ALLOW_PRIVATE_URLS_ENV]?.trim().toLowerCase() === 'true';
}

/** An IPv4 address as a 32-bit unsigned number, or undefined if it is not one. */
function ipv4ToNumber(ip: string): number | undefined {
  const parts = ip.split('.');
  if (parts.length !== 4 || !parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)) {
    return undefined;
  }
  return parts.reduce((n, part) => n * 256 + Number(part), 0);
}

/** [network, prefix length] pairs. */
const FORBIDDEN_V4: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8],       // "this network"
  ['10.0.0.0', 8],      // private
  ['100.64.0.0', 10],   // carrier-grade NAT
  ['127.0.0.0', 8],     // loopback
  ['169.254.0.0', 16],  // link-local, including 169.254.169.254 (cloud metadata)
  ['172.16.0.0', 12],   // private
  ['192.168.0.0', 16],  // private
  ['224.0.0.0', 4],     // multicast
  ['240.0.0.0', 4],     // reserved, including 255.255.255.255
];

function forbiddenV4(n: number): boolean {
  return FORBIDDEN_V4.some(([network, bits]) => {
    const base = ipv4ToNumber(network) ?? 0;
    const size = 2 ** (32 - bits);
    return n >= base && n < base + size;
  });
}

/** An IPv6 address as eight 16-bit groups, or undefined if it is not one. */
function ipv6Groups(ip: string): number[] | undefined {
  let text = ip;
  // An embedded dotted IPv4 tail (::ffff:1.2.3.4) becomes two hex groups.
  const tail = /:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (tail) {
    const v4 = ipv4ToNumber(tail[1] ?? '');
    if (v4 === undefined) {
      return undefined;
    }
    text = `${text.slice(0, tail.index)}:${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) {
    return undefined;
  }
  const parse = (half: string | undefined): number[] | undefined => {
    if (!half) {
      return [];
    }
    const groups = half.split(':');
    return groups.every(g => /^[0-9a-f]{1,4}$/i.test(g)) ? groups.map(g => parseInt(g, 16)) : undefined;
  };
  const head = parse(halves[0]);
  const rest = parse(halves[1]);
  if (!head || !rest) {
    return undefined;
  }
  if (halves.length === 1) {
    return head.length === 8 ? head : undefined;
  }
  const missing = 8 - head.length - rest.length;
  return missing >= 1 ? [...head, ...new Array<number>(missing).fill(0), ...rest] : undefined;
}

/**
 * True when a PDF URL must not be fetched from this address: private,
 * loopback, link-local, CGNAT, multicast or reserved IPv4; the IPv6
 * unspecified and loopback addresses, unique-local fc00::/7, link-local
 * fe80::/10, site-local fec0::/10 and multicast ff00::/8; and IPv6 forms that
 * carry an IPv4 address -- mapped (::ffff:0:0/96), compatible (::/96) and the
 * NAT64 prefix 64:ff9b::/96 -- judged by that IPv4 address. Anything that is
 * not an IP address is refused too.
 */
export function isForbiddenAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const family = isIP(ip);
  if (family === 4) {
    const n = ipv4ToNumber(ip);
    return n === undefined || forbiddenV4(n);
  }
  if (family !== 6) {
    return true;
  }
  const g = ipv6Groups(ip);
  if (!g) {
    return true;
  }
  const embeddedV4 = (): number => ((g[6] ?? 0) * 0x10000) + (g[7] ?? 0);
  const zeroUpTo = (end: number): boolean => g.slice(0, end).every(x => x === 0);
  if (zeroUpTo(5) && (g[5] === 0xffff || g[5] === 0)) {
    // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible; also :: and ::1,
    // which embed 0.0.0.0 and 0.0.0.1).
    return forbiddenV4(embeddedV4());
  }
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(x => x === 0)) {
    return forbiddenV4(embeddedV4());
  }
  const first = g[0] ?? 0;
  return (first & 0xfe00) === 0xfc00   // fc00::/7 unique local
    || (first & 0xffc0) === 0xfe80     // fe80::/10 link-local
    || (first & 0xffc0) === 0xfec0     // fec0::/10 site-local (deprecated)
    || (first & 0xff00) === 0xff00;    // ff00::/8 multicast
}

export type HostLookup = (hostname: string) => Promise<ReadonlyArray<{ address: string }>>;

/** An address checkHostAllowed() approved, in the form a connection is pinned to. */
export interface CheckedAddress {
  address: string;
  family: 4 | 6;
}

const systemLookup: HostLookup = hostname => dns.lookup(hostname, { all: true, verbatim: true });

/** `address` with the family its own form says it has; undefined if it is not an IP address. */
function checkedAddress(address: string): CheckedAddress | undefined {
  const family = isIP(address);
  return family === 4 || family === 6 ? { address, family } : undefined;
}

/**
 * Refuses a URL whose host is, or resolves to, an address isForbiddenAddress()
 * rejects, unless CGMB_ALLOW_PRIVATE_URLS=true. A literal IP is judged as
 * written; a name is resolved and refused if ANY of its addresses is
 * forbidden.
 *
 * Returns the addresses it approved, and downloadPdfUrl() connects to those
 * (pinnedLookup) rather than resolving the name a second time: with fetch(),
 * a DNS server that answered differently the second time (DNS rebinding)
 * could send the connection to an address this never saw. Undefined when
 * CGMB_ALLOW_PRIVATE_URLS=true, where there is nothing to pin and the system
 * lookup runs as usual.
 */
export async function checkHostAllowed(
  url: URL,
  lookup: HostLookup = systemLookup,
  env: NodeJS.ProcessEnv = process.env
): Promise<ReadonlyArray<CheckedAddress> | undefined> {
  if (privateUrlsAllowed(env)) {
    return undefined;
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new Error(ADDRESS_NOT_ALLOWED);
  }
  const literal = checkedAddress(host);
  if (literal) {
    if (isForbiddenAddress(host)) {
      throw new Error(ADDRESS_NOT_ALLOWED);
    }
    return [literal];
  }
  let addresses: ReadonlyArray<{ address: string }>;
  try {
    addresses = await lookup(host);
  } catch {
    throw new Error('the host name could not be resolved');
  }
  if (addresses.length === 0 || addresses.some(({ address }) => isForbiddenAddress(address))) {
    throw new Error(ADDRESS_NOT_ALLOWED);
  }
  // Every address passed isForbiddenAddress(), which refuses anything that is
  // not an IP address, so each one has a family.
  return addresses.flatMap(({ address }) => checkedAddress(address) ?? []);
}

/**
 * A `lookup` for http(s).request() that answers with `addresses` and never
 * asks DNS: the connection goes to what checkHostAllowed() approved. Honours
 * both forms Node calls it in -- `all: true` (the array, which the default
 * autoSelectFamily uses) and the single-address callback -- and a requested
 * family. TLS is unaffected: only the lookup is replaced, so the certificate
 * is still checked against the URL's host name.
 */
export function pinnedLookup(addresses: ReadonlyArray<CheckedAddress>): LookupFunction {
  return (hostname: string, options: LookupOptions, callback: (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void): void => {
    const wanted = options?.family === 4 || options?.family === 'IPv4' ? 4
      : options?.family === 6 || options?.family === 'IPv6' ? 6
        : undefined;
    const matching = addresses.filter(({ family }) => wanted === undefined || family === wanted);
    const first = matching[0];
    if (!first) {
      const error: NodeJS.ErrnoException = new Error(`no checked address for ${hostname}`);
      error.code = 'ENOTFOUND';
      process.nextTick(callback, error, '', undefined);
      return;
    }
    if (options?.all) {
      process.nextTick(callback, null, matching.map(({ address, family }) => ({ address, family })));
      return;
    }
    process.nextTick(callback, null, first.address, first.family);
  };
}

/** Refuses a redirect from https to http; every other http(s) hop is fine. */
export function checkRedirect(from: URL, to: URL): void {
  if (from.protocol === 'https:' && to.protocol === 'http:') {
    throw new Error('a redirect from https to http is not followed');
  }
}

/** Settles with `promise`, or rejects as soon as `signal` aborts. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => { signal.removeEventListener('abort', onAbort); resolve(value); },
      error => { signal.removeEventListener('abort', onAbort); reject(error); }
    );
  });
}

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

/**
 * One GET of `url`, answered with the response head; the body is left to the
 * caller. Redirects are not followed (http.request never does), the request
 * is aborted with `signal`, and `addresses`, when there are any, are the only
 * place it connects to. No agent: nothing is pooled, so a kept-alive socket
 * cannot carry one download's connection into the next.
 */
function get(
  url: URL,
  addresses: ReadonlyArray<CheckedAddress> | undefined,
  signal: AbortSignal
): { request: ReturnType<typeof httpRequest>; response: Promise<IncomingMessage> } {
  const options: RequestOptions = {
    method: 'GET',
    signal,
    agent: false,
    ...(addresses ? { lookup: pinnedLookup(addresses) } : {}),
  };
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const request = send(url, options);
  const response = new Promise<IncomingMessage>((resolve, reject) => {
    request.once('response', resolve);
    // Stays attached for the request's life: an error after the head (a reset,
    // the timeout, the size cap destroying it) must not be an unhandled event.
    request.on('error', reject);
  });
  request.end();
  return { request, response };
}

export async function downloadPdfUrl(
  rawUrl: string,
  limits: PdfDownloadLimits = PDF_URL_LIMITS,
  lookup: HostLookup = systemLookup
): Promise<DownloadedPdf> {
  let url = checkedUrl(rawUrl);
  const signal = AbortSignal.timeout(limits.timeoutMs);

  try {
    let request: ReturnType<typeof httpRequest>;
    let response: IncomingMessage;
    for (let redirects = 0; ; redirects++) {
      const addresses = await untilAborted(checkHostAllowed(url, lookup), signal);
      const sent = get(url, addresses, signal);
      request = sent.request;
      response = await sent.response;
      const status = response.statusCode ?? 0;
      if (!REDIRECTS.has(status)) {
        break;
      }
      const location = response.headers.location;
      response.destroy();
      if (!location) {
        throw new Error(`HTTP ${status} without a Location header`);
      }
      if (redirects >= limits.maxRedirects) {
        throw new Error(`more than ${limits.maxRedirects} redirects`);
      }
      const next = checkedUrl(location, url);
      checkRedirect(url, next);
      url = next;
    }

    const status = response.statusCode ?? 0;
    if (status < 200 || status > 299) {
      response.destroy();
      throw new Error(`HTTP ${status}`);
    }

    const declared = Number(response.headers['content-length'] ?? '');
    if (Number.isFinite(declared) && declared > limits.maxBytes) {
      response.destroy();
      throw new Error(`the PDF is ${(declared / 1024 / 1024).toFixed(1)} MB; the limit is ${limits.maxBytes / 1024 / 1024} MB`);
    }

    const chunks: Buffer[] = [];
    let received = 0;
    for await (const chunk of response) {
      const value = chunk as Buffer;
      received += value.byteLength;
      if (received > limits.maxBytes) {
        request.destroy();
        throw new Error(`the PDF is larger than the ${limits.maxBytes / 1024 / 1024} MB limit`);
      }
      chunks.push(value);
    }
    const body = Buffer.concat(chunks);

    if (!looksLikePdf(body)) {
      throw new Error('the response is not a PDF');
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
