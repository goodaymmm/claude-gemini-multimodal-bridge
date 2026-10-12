/**
 * Which addresses a PDF URL may be fetched from (src/utils/urlDownload.ts).
 *
 * A PDF URL can come from a prompt injection, so the download refuses private,
 * loopback, link-local and metadata addresses -- for the first URL and every
 * redirect target -- unless CGMB_ALLOW_PRIVATE_URLS=true, and refuses an https
 * to http redirect. Nothing here needs the network: a refused address is
 * refused before any request is made, host names are resolved through a stub,
 * and the one server is a local one on 127.0.0.1.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';

import {
  ADDRESS_NOT_ALLOWED,
  ALLOW_PRIVATE_URLS_ENV,
  checkHostAllowed,
  checkRedirect,
  downloadPdfUrl,
  isForbiddenAddress,
} from '../dist/utils/urlDownload.js';

const PDF_BODY = '%PDF-1.4\n% url-download test\n%%EOF\n';

/** The exact error every refused address gets. */
const refusedFor = url => `Could not fetch ${url}: ${ADDRESS_NOT_ALLOWED}`;

/** A lookup stub answering with fixed addresses. */
const resolvesTo = (...addresses) => async () => addresses.map(address => ({ address, family: address.includes(':') ? 6 : 4 }));

const OPTED_OUT = {};
const OPTED_IN = { [ALLOW_PRIVATE_URLS_ENV]: 'true' };

describe('isForbiddenAddress', () => {
  const forbidden = [
    // IPv4
    '0.0.0.0', '0.255.255.255',
    '10.0.0.1', '10.255.255.255',
    '100.64.0.1', '100.127.255.255',
    '127.0.0.1', '127.255.255.254',
    '169.254.0.1', '169.254.169.254',
    '172.16.0.1', '172.31.255.255',
    '192.168.0.1', '192.168.255.255',
    '224.0.0.1', '239.255.255.250',
    '240.0.0.1', '255.255.255.255',
    // IPv6
    '::', '::1', '[::1]',
    'fc00::1', 'fd12:3456:789a::1',
    'fe80::1', 'fe80::1%eth0', 'febf:ffff::1',
    'fec0::1',
    'ff02::1', 'ff0e::1',
    // IPv4 inside IPv6, judged as IPv4
    '::ffff:127.0.0.1', '::ffff:7f00:1', '[::ffff:7f00:1]',
    '::ffff:169.254.169.254', '::ffff:a9fe:a9fe',
    '::ffff:10.0.0.1', '::ffff:192.168.1.1',
    '::127.0.0.1', '64:ff9b::10.0.0.1', '64:ff9b::a9fe:a9fe',
    // Not an address at all: fail closed
    'example.com', '', '1.2.3', '1.2.3.256', ':::1',
  ];
  const allowed = [
    '8.8.8.8', '1.1.1.1', '93.184.216.34',
    '9.255.255.255', '11.0.0.0',
    '100.63.255.255', '100.128.0.0',
    '126.255.255.255', '128.0.0.0',
    '169.253.255.255', '169.255.0.0',
    '172.15.255.255', '172.32.0.0',
    '192.167.255.255', '192.169.0.0',
    '223.255.255.255',
    '2606:4700:4700::1111', '2001:4860:4860::8888', '2a00:1450:4001:80b::200e',
    '::ffff:8.8.8.8', '::ffff:808:808', '64:ff9b::808:808',
  ];
  for (const address of forbidden) {
    it(`refuses ${JSON.stringify(address)}`, () => assert.equal(isForbiddenAddress(address), true));
  }
  for (const address of allowed) {
    it(`allows ${address}`, () => assert.equal(isForbiddenAddress(address), false));
  }
});

describe('checkHostAllowed', () => {
  const never = async () => { throw new Error('a literal address or a refused name must not be resolved'); };

  it('refuses literal private addresses without a DNS lookup', async () => {
    for (const url of [
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.1/a.pdf',
      'http://127.0.0.1:8080/a.pdf',
      'http://[::1]/a.pdf',
      'http://[::ffff:127.0.0.1]/a.pdf',
      'http://[::ffff:169.254.169.254]/a.pdf',
      'http://[fe80::1]/a.pdf',
      'http://2130706433/a.pdf', // 127.0.0.1 as one decimal number
      'http://0x7f.1/a.pdf',     // 127.0.0.1, abbreviated hex
    ]) {
      await assert.rejects(checkHostAllowed(new URL(url), never, OPTED_OUT), { message: ADDRESS_NOT_ALLOWED }, url);
    }
  });

  it('refuses localhost and *.localhost by name', async () => {
    for (const url of ['http://localhost/a.pdf', 'http://LOCALHOST:3000/a.pdf', 'http://localhost./a.pdf', 'https://pdfs.localhost/a.pdf']) {
      await assert.rejects(checkHostAllowed(new URL(url), never, OPTED_OUT), { message: ADDRESS_NOT_ALLOWED }, url);
    }
  });

  it('refuses a public-looking name that resolves to a private address', async () => {
    const url = new URL('https://pdfs.example.com/report.pdf');
    await assert.rejects(checkHostAllowed(url, resolvesTo('10.1.2.3'), OPTED_OUT), { message: ADDRESS_NOT_ALLOWED });
    await assert.rejects(checkHostAllowed(url, resolvesTo('169.254.169.254'), OPTED_OUT), { message: ADDRESS_NOT_ALLOWED });
    await assert.rejects(checkHostAllowed(url, resolvesTo('::ffff:127.0.0.1'), OPTED_OUT), { message: ADDRESS_NOT_ALLOWED });
    // One forbidden address among public ones is enough.
    await assert.rejects(checkHostAllowed(url, resolvesTo('93.184.216.34', '2606:2800:220:1::1', '127.0.0.1'), OPTED_OUT), { message: ADDRESS_NOT_ALLOWED });
  });

  it('allows a name whose addresses are all public, and a public literal', async () => {
    await checkHostAllowed(new URL('https://pdfs.example.com/report.pdf'), resolvesTo('93.184.216.34', '2606:2800:220:1::1'), OPTED_OUT);
    await checkHostAllowed(new URL('http://8.8.8.8/report.pdf'), never, OPTED_OUT);
    await checkHostAllowed(new URL('http://[2606:4700:4700::1111]/report.pdf'), never, OPTED_OUT);
  });

  it('refuses a name that resolves to nothing, or cannot be resolved', async () => {
    const url = new URL('https://pdfs.example.com/report.pdf');
    await assert.rejects(checkHostAllowed(url, resolvesTo(), OPTED_OUT), { message: ADDRESS_NOT_ALLOWED });
    await assert.rejects(checkHostAllowed(url, async () => { throw new Error('getaddrinfo ENOTFOUND'); }, OPTED_OUT), { message: 'the host name could not be resolved' });
  });

  it(`allows everything when ${ALLOW_PRIVATE_URLS_ENV}=true, and only then`, async () => {
    const urls = ['http://127.0.0.1/a.pdf', 'http://localhost/a.pdf', 'http://169.254.169.254/', 'http://[::1]/a.pdf'];
    for (const url of urls) {
      await checkHostAllowed(new URL(url), never, OPTED_IN);
      await checkHostAllowed(new URL(url), never, { [ALLOW_PRIVATE_URLS_ENV]: ' TRUE ' });
    }
    await checkHostAllowed(new URL('https://pdfs.example.com/a.pdf'), resolvesTo('10.0.0.1'), OPTED_IN);
    for (const value of ['1', 'yes', 'false', '']) {
      await assert.rejects(checkHostAllowed(new URL(urls[0]), never, { [ALLOW_PRIVATE_URLS_ENV]: value }), { message: ADDRESS_NOT_ALLOWED }, value);
    }
  });
});

describe('checkRedirect', () => {
  it('refuses https -> http', () => {
    assert.throws(() => checkRedirect(new URL('https://a.example/x.pdf'), new URL('http://a.example/x.pdf')), /from https to http/);
  });
  it('follows http -> https, https -> https and http -> http', () => {
    checkRedirect(new URL('http://a.example/x.pdf'), new URL('https://a.example/x.pdf'));
    checkRedirect(new URL('https://a.example/x.pdf'), new URL('https://b.example/y.pdf'));
    checkRedirect(new URL('http://a.example/x.pdf'), new URL('http://b.example/y.pdf'));
  });
});

describe('downloadPdfUrl', () => {
  let server;
  let base;
  /** Paths the local server was asked for. */
  const seen = [];
  /** Run when the server answers a request, before the client sees the answer. */
  let onRequest = () => {};

  before(async () => {
    server = createServer((req, res) => {
      seen.push(req.url);
      onRequest(req.url);
      if (req.url === '/report.pdf') {
        res.writeHead(200, { 'content-type': 'application/pdf' });
        return res.end(PDF_BODY);
      }
      if (req.url === '/moved.pdf') {
        res.writeHead(302, { location: '/report.pdf' });
        return res.end();
      }
      if (req.url === '/to-metadata.pdf') {
        res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
        return res.end();
      }
      if (req.url === '/page.pdf') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end('<html>not a pdf</html>');
      }
      res.writeHead(404, 'Nothing Here At All', { 'content-type': 'text/plain' });
      return res.end('not found');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => new Promise(resolve => server.close(resolve)));

  beforeEach(() => {
    delete process.env[ALLOW_PRIVATE_URLS_ENV];
    seen.length = 0;
    onRequest = () => {};
  });

  it('refuses a loopback server without the opt-in, before any request', async () => {
    const url = `${base}/report.pdf`;
    await assert.rejects(downloadPdfUrl(url), { message: refusedFor(url) });
    assert.deepEqual(seen, []);
  });

  it('reads from a loopback server with the opt-in, and cleans up', async () => {
    process.env[ALLOW_PRIVATE_URLS_ENV] = 'true';
    const pdf = await downloadPdfUrl(`${base}/moved.pdf`);
    try {
      assert.equal(readFileSync(pdf.path, 'utf8'), PDF_BODY);
      assert.equal(pdf.finalUrl, `${base}/report.pdf`);
      assert.deepEqual(seen, ['/moved.pdf', '/report.pdf']);
    } finally {
      await pdf.cleanup();
    }
    assert.equal(existsSync(pdf.path), false);
  });

  it('refuses metadata, private, localhost and IPv4-mapped literals with one message', async () => {
    const urls = [
      'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
      'http://10.0.0.1/report.pdf',
      'http://192.168.1.1:8443/report.pdf',
      'http://localhost/report.pdf',
      'http://[::1]/report.pdf',
      'http://[::ffff:127.0.0.1]/report.pdf',
      'http://[::ffff:a9fe:a9fe]/report.pdf',
    ];
    const reasons = new Set();
    for (const url of urls) {
      const error = await downloadPdfUrl(url).then(() => null, e => e);
      assert.ok(error, url);
      assert.equal(error.message, refusedFor(url));
      reasons.add(error.message.slice(`Could not fetch ${url}`.length));
    }
    assert.deepEqual([...reasons], [`: ${ADDRESS_NOT_ALLOWED}`]);
  });

  it('refuses a redirect to a private address', async () => {
    // The first hop is allowed only by the opt-in, which the server withdraws
    // as it answers -- so the redirect target is checked with it off, which is
    // what a public server redirecting inwards looks like.
    process.env[ALLOW_PRIVATE_URLS_ENV] = 'true';
    onRequest = () => { delete process.env[ALLOW_PRIVATE_URLS_ENV]; };
    const url = `${base}/to-metadata.pdf`;
    await assert.rejects(downloadPdfUrl(url), { message: refusedFor(url) });
    assert.deepEqual(seen, ['/to-metadata.pdf']);
  });

  it('refuses a same-server redirect once loopback is no longer allowed', async () => {
    process.env[ALLOW_PRIVATE_URLS_ENV] = 'true';
    onRequest = () => { delete process.env[ALLOW_PRIVATE_URLS_ENV]; };
    const url = `${base}/moved.pdf`;
    await assert.rejects(downloadPdfUrl(url), { message: refusedFor(url) });
    assert.deepEqual(seen, ['/moved.pdf']);
  });

  it('keeps the HTTP status but not the status text, content type or size', async () => {
    process.env[ALLOW_PRIVATE_URLS_ENV] = 'true';
    await assert.rejects(downloadPdfUrl(`${base}/missing.pdf`), { message: `Could not fetch ${base}/missing.pdf: HTTP 404` });
    await assert.rejects(downloadPdfUrl(`${base}/page.pdf`), { message: `Could not fetch ${base}/page.pdf: the response is not a PDF` });
  });

  it('still refuses schemes other than http and https', async () => {
    process.env[ALLOW_PRIVATE_URLS_ENV] = 'true';
    await assert.rejects(downloadPdfUrl('file:///etc/passwd'), /Only http and https URLs are fetched/);
  });
});
