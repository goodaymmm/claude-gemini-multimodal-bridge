import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  isVersionAtLeast,
  looksLikeAgyBinary,
  MIN_AGY_VERSION,
} from '../dist/utils/antigravityCli.js';
import { LayerTypeSchema, TargetLayerSchema, normalizeLayerName } from '../dist/core/types.js';
import { LayerManager } from '../dist/core/LayerManager.js';
import { AntigravityCLILayer, isInlinableTextFile } from '../dist/layers/AntigravityCLILayer.js';
import { buildSpawnTarget } from '../dist/utils/processUtils.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const isWindows = process.platform === 'win32';

/** Collect stdout from a child, with a hard deadline. */
function runChild(file, args, options = {}, stdinData) {
  return new Promise(resolve => {
    const child = spawn(file, args, {
      stdio: [stdinData === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
      ...options,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, options.deadlineMs ?? 8000);

    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });

    if (stdinData !== undefined) {
      child.stdin.on('error', () => {});
      child.stdin.end(stdinData);
    }

    child.on('close', code => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });
    child.on('error', error => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: null, timedOut, error });
    });
  });
}

describe('agy version gate', () => {
  it('accepts the minimum and rejects the release below it', () => {
    // Builds before 1.1.7 gate stdout on isatty(): they print nothing and exit
    // 0 on a non-TTY, turning every call into a silent wrong answer.
    assert.equal(MIN_AGY_VERSION, '1.1.7');
    assert.equal(isVersionAtLeast('1.1.7', MIN_AGY_VERSION), true, '1.1.7 must be accepted');
    assert.equal(isVersionAtLeast('1.1.6', MIN_AGY_VERSION), false, '1.1.6 must be rejected');
    assert.equal(isVersionAtLeast('1.0.9', MIN_AGY_VERSION), false);
    assert.equal(isVersionAtLeast('1.2.0', MIN_AGY_VERSION), true);
    assert.equal(isVersionAtLeast('2.0.0', MIN_AGY_VERSION), true);
    assert.equal(isVersionAtLeast('v1.1.7', MIN_AGY_VERSION), true, 'a v prefix must not break parsing');
  });
});

describe('binary identity guard', () => {
  it('refuses a stale GEMINI_CLI_PATH that still points at the retired CLI', () => {
    // Adopting the old binary would either trip the version guard or invoke the
    // wrong program, and would short-circuit the search for a real agy.
    assert.equal(looksLikeAgyBinary('/usr/local/bin/gemini'), false);
    assert.equal(looksLikeAgyBinary('C:\\Users\\x\\AppData\\Local\\gemini\\gemini.exe'), false);

    assert.equal(looksLikeAgyBinary('agy'), true);
    assert.equal(looksLikeAgyBinary('/home/u/.local/bin/agy'), true);
    assert.equal(looksLikeAgyBinary('C:\\Users\\x\\AppData\\Local\\agy\\bin\\agy.EXE'), true);
  });
});

describe('layer naming back-compat', () => {
  it('accepts both the canonical and deprecated names, and rejects unknown ones', () => {
    for (const schema of [LayerTypeSchema, TargetLayerSchema]) {
      assert.equal(schema.safeParse('antigravity').success, true);
      assert.equal(schema.safeParse('gemini').success, true, 'deprecated alias must keep working');
      assert.equal(schema.safeParse('not-a-layer').success, false);
    }
  });

  it('normalizes the deprecated name and leaves others alone', () => {
    assert.equal(normalizeLayerName('gemini'), 'antigravity');
    assert.equal(normalizeLayerName('antigravity'), 'antigravity');
    assert.equal(normalizeLayerName('claude'), 'claude');
    assert.equal(normalizeLayerName('adaptive'), 'adaptive');
  });

  it('keeps the pre-rename public getters on LayerManager', () => {
    // LayerManager is a public export; removing these broke compilation for
    // TypeScript consumers and threw TypeError for JavaScript ones.
    const lm = new LayerManager({
      claude: { timeout: 300000, max_tokens: 16384, temperature: 0.2 },
      gemini: { temperature: 0.2, max_tokens: 16384, timeout: 60000, model: 'gemini-2.5-flash', api_key: '' },
      aistudio: { temperature: 0.2, max_tokens: 16384, timeout: 180000, model: 'gemini-2.5-flash', api_key: '' },
    });

    assert.equal(typeof lm.getGeminiLayer, 'function');
    assert.equal(typeof lm.getGeminiLayerAsync, 'function');
    assert.equal(lm.getGeminiLayer(), lm.getAntigravityLayer(), 'must return the same instance');
  });
});

describe('subprocess stdin handling', () => {
  it('a child that drains stdin only completes when stdin is closed', async () => {
    // Regression: `agy models` reads stdin to EOF before emitting anything, and
    // execFile wires stdin to a pipe it never closes -- so the auth probe hung
    // until its own timeout on every call, while `agy --version` (which never
    // touches stdin) made detection look healthy.
    const fixture = join(HERE, 'fixtures', 'stdin-reader.mjs');

    const openPipe = await new Promise(resolve => {
      const child = spawn(process.execPath, [fixture], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let out = '';
      const timer = setTimeout(() => { child.kill('SIGTERM'); resolve({ out, timedOut: true }); }, 3000);
      child.stdout.on('data', d => { out += d; });
      child.on('close', () => { clearTimeout(timer); resolve({ out, timedOut: false }); });
    });
    assert.equal(openPipe.timedOut, true, 'leaving stdin open must hang (this is the bug)');
    assert.equal(openPipe.out.trim(), '');

    const closed = await runChild(process.execPath, [fixture], {}, '');
    assert.equal(closed.timedOut, false, 'closing stdin must let the child finish');
    assert.match(closed.stdout, /STDIN_CLOSED/);
  });
});

describe('windows .cmd argument handling', { skip: !isWindows && 'Windows-only behaviour' }, () => {
  const shimDir = join(tmpdir(), `cgmb-test-shim-${process.pid}`);
  const shim = join(shimDir, 'shim.cmd');

  after(() => rmSync(shimDir, { recursive: true, force: true }));

  it('does not execute shell metacharacters supplied as prompt text', async () => {
    // Regression: prompt text is caller-controlled and reaches the layer from
    // MCP input. Passing it in argv to a .cmd shim meant it became part of a
    // cmd.exe command line, and MSVCRT-style \" escaping does not protect it --
    // cmd.exe has no backslash-escape concept, so the quote closed early and
    // everything after an unquoted & ran as a command.
    rmSync(shimDir, { recursive: true, force: true });
    mkdirSync(shimDir, { recursive: true });
    writeFileSync(shim, '@echo off\r\necho SHIM-ARGS: %*\r\n', { encoding: 'utf8', flag: 'wx' });

    const quote = value => `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`;
    const payload = 'x" & echo INJECTED_MARKER & rem "';
    const comspec = process.env.ComSpec ?? 'cmd.exe';

    const viaCmd = async args => {
      const line = [shim, ...args].map(quote).join(' ');
      return runChild(comspec, ['/d', '/s', '/c', `"${line}"`], {
        windowsVerbatimArguments: true,
      });
    };

    // The vulnerable shape, asserted so the test fails if it ever stops being
    // vulnerable for an unrelated reason (which would invalidate the contrast).
    const inArgv = await viaCmd(['--print', payload]);
    assert.match(inArgv.stdout, /INJECTED_MARKER/, 'sanity: argv delivery is the unsafe shape');

    // The shipped shape: only static flags on the command line.
    const staticOnly = await viaCmd(['--print']);
    assert.doesNotMatch(staticOnly.stdout, /INJECTED_MARKER/, 'static argv must not inject');
    assert.match(staticOnly.stdout, /SHIM-ARGS: "--print"/);
  });
});

describe('windows .cmd launcher', { skip: !isWindows && 'Windows-only behaviour' }, () => {
  const dir = join(tmpdir(), `cgmb-test-launcher-${process.pid}`);
  const shim = join(dir, 'faketool.cmd');

  after(() => rmSync(dir, { recursive: true, force: true }));

  it('can invoke a .cmd shim that execFileSync alone cannot', async () => {
    // Regression: npm installs Claude Code as `claude.cmd` on Windows, and
    // execFileSync on a .cmd fails with EINVAL because CreateProcess cannot run
    // a batch file. An auth probe that called execFileSync directly therefore
    // reported an installed, signed-in Claude as unauthenticated and cached it,
    // disabling the whole layer.
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(shim, '@echo off\r\necho {"loggedIn":true}\r\n', { encoding: 'utf8', flag: 'wx' });

    // Sanity: the naive call really does fail, so the contrast stays meaningful.
    let naiveFailed = false;
    try {
      execFileSync(shim, ['auth', 'status'], { encoding: 'utf8', stdio: 'pipe', windowsHide: true });
    } catch (error) {
      naiveFailed = error.code === 'EINVAL';
    }
    assert.equal(naiveFailed, true, 'sanity: execFileSync on .cmd must fail with EINVAL');

    // The shared launcher must make it work.
    const target = buildSpawnTarget(shim, ['auth', 'status', '--json']);
    const output = execFileSync(target.file, target.args, {
      encoding: 'utf8',
      stdio: 'pipe',
      windowsHide: true,
      ...target.spawnOptions,
    });
    assert.equal(JSON.parse(output.trim()).loggedIn, true);
  });

  it('passes a real executable straight through, without a shell', () => {
    const target = buildSpawnTarget(process.execPath, ['--version']);
    assert.equal(target.file, process.execPath);
    assert.deepEqual(target.args, ['--version']);
    assert.equal(target.spawnOptions.windowsVerbatimArguments, undefined);
  });
});

describe('credential file guard', () => {
  const dir = join(tmpdir(), `cgmb-test-secrets-${process.pid}`);

  after(() => rmSync(dir, { recursive: true, force: true }));

  it('refuses to inline credential-looking files, and allows ordinary ones', () => {
    // extractPrompt inlines file contents into a prompt that is sent to
    // Antigravity's servers, so a mistaken path would exfiltrate credentials
    // while looking like a normal analysis request.
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });

    const layer = new AntigravityCLILayer();

    for (const name of ['.env', '.env.local', 'credentials.json', 'server.pem', 'id_rsa', '.npmrc']) {
      const p = join(dir, name);
      // Deliberately inert placeholder content - never a real secret.
      writeFileSync(p, 'PLACEHOLDER=not-a-real-secret\n', { encoding: 'utf8' });

      // Exercised through extractPrompt, the point of disclosure, so the test
      // stays hermetic: execute() would spawn a live agy auth probe.
      assert.throws(
        () => layer.extractPrompt({ prompt: 'summarise', files: [{ path: p, type: 'text' }] }, dir),
        /credential file pattern/,
        `${name} must be refused`
      );
    }

    // A normal document must still be readable; assert on the built prompt
    // rather than making a network call.
    const doc = join(dir, 'notes.txt');
    writeFileSync(doc, 'CGMB regression note.\n', { encoding: 'utf8' });
    const built = layer.extractPrompt({
      prompt: 'summarise',
      files: [{ path: doc, type: 'text' }],
    }, dir);
    assert.match(built, /CGMB regression note/);
    assert.match(built, /FILE: notes\.txt/);
  });
});

describe('translation sanitiser', () => {
  const layer = new AntigravityCLILayer();
  const clean = raw => layer.extractTranslation(raw, 'ORIGINAL');

  it('keeps leading digits that are part of the text', () => {
    // A greedy [\d.)\s]+ strip turned "3D render" into "D render" and dropped
    // the year from "2026 Tokyo skyline" -- generating a different image
    // rather than failing.
    assert.equal(clean('3D render of three cats'), '3D render of three cats');
    assert.equal(clean('2026 Tokyo skyline'), '2026 Tokyo skyline');
    assert.equal(clean('4K photo of a bridge'), '4K photo of a bridge');
  });

  it('still strips genuine list and heading markers', () => {
    assert.equal(clean('1. A cat on a sofa'), 'A cat on a sofa');
    assert.equal(clean('- A cat on a sofa'), 'A cat on a sofa');
    assert.equal(clean('> A cat on a sofa'), 'A cat on a sofa');
    assert.equal(clean('### A cat on a sofa'), 'A cat on a sofa');
  });

  it('does not accept a bare label or refusal as a single-line translation', () => {
    // Taking any single line verbatim let these through as successful
    // translations; the AI Studio layer then marked wasTranslated and sent them
    // to the image API, which generated a picture of the wrong thing and
    // reported success.
    assert.equal(clean('Option 1'), 'ORIGINAL');
    assert.equal(clean('Here are a few options:'), 'ORIGINAL');
    assert.equal(clean('I cannot help with that request'), 'ORIGINAL');

    // But a labelled answer keeps its payload.
    assert.equal(clean('Translation: A cat on a sofa'), 'A cat on a sofa');
  });

  it('keeps single-line prompts that mention a style', () => {
    // A vocabulary-based label heuristic rejected these as headings, so the
    // Japanese original was sent to the image API instead of the translation.
    assert.equal(clean('Anime style illustration of a cat'), 'Anime style illustration of a cat');
    assert.equal(clean('Cinematic shot of a mountain landscape'), 'Cinematic shot of a mountain landscape');
    assert.equal(clean('Photorealistic portrait of a dog'), 'Photorealistic portrait of a dog');
  });

  it('does not mistake a section label for the translation', () => {
    const reply = [
      'Here are a few options:',
      '',
      '### 1. Natural & Direct Translation (Best all-rounder)',
      '> **"A landscape of blue sky and white clouds"**',
    ].join('\n');
    assert.equal(clean(reply), 'A landscape of blue sky and white clouds');
  });

  it('caps runaway output and falls back when nothing is usable', () => {
    assert.ok(clean(`x${'y'.repeat(900)}`).length <= 400);
    assert.equal(clean('   '), 'ORIGINAL');
  });
});

describe('inlined file safety', () => {
  const dir = join(tmpdir(), `cgmb-test-inline-${process.pid}`);
  const layer = new AntigravityCLILayer();

  after(() => rmSync(dir, { recursive: true, force: true }));

  it('refuses binary document formats instead of reading them as text', () => {
    // LayerManager hands the original files to this layer when AI Studio
    // fails, so PDFs really do arrive. Reading one as UTF-8 yields mojibake
    // that the CLI answers as if it were a document.
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });

    const pdf = join(dir, 'report.pdf');
    writeFileSync(pdf, Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x00, 0x01]));

    assert.throws(
      () => layer.extractPrompt({ prompt: 'summarise', files: [{ path: pdf, type: 'pdf' }] }, dir),
      /cannot read report\.pdf/,
      'PDF must be refused, not silently mis-read'
    );
  });

  it('refuses files outside the workspace root, and allows files inside it', () => {
    // Root confinement is the primary control: a name denylist cannot enumerate
    // every credential file, and a caller-supplied absolute path could
    // otherwise reach anything readable on the machine.
    const inside = join(dir, 'inside.txt');
    writeFileSync(inside, 'workspace content\n');

    const outsideDir = join(tmpdir(), `cgmb-test-outside-${process.pid}`);
    rmSync(outsideDir, { recursive: true, force: true });
    mkdirSync(outsideDir, { recursive: true });
    const outside = join(outsideDir, 'elsewhere.txt');
    writeFileSync(outside, 'content outside the workspace\n');

    try {
      assert.throws(
        () => layer.extractPrompt({
          prompt: 'summarise',
          files: [{ path: outside, type: 'text' }],
        }, dir),
        /outside the workspace root/,
        'a path outside the root must be refused'
      );

      const built = layer.extractPrompt({
        prompt: 'summarise',
        files: [{ path: inside, type: 'text' }],
      }, dir);
      assert.match(built, /workspace content/);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('lets an explicit caller widen the root without weakening the default', () => {
    // The CLI passes the file's own directory because a path typed by the
    // operator is the authorisation. MCP callers omit it and get process.cwd(),
    // so untrusted input stays confined. Both behaviours must hold at once.
    const outsideDir = join(tmpdir(), `cgmb-test-widen-${process.pid}`);
    rmSync(outsideDir, { recursive: true, force: true });
    mkdirSync(outsideDir, { recursive: true });
    const file = join(outsideDir, 'explicit.txt');
    writeFileSync(file, 'explicitly requested content\n');

    try {
      // Widened by an explicit caller: allowed.
      const built = layer.extractPrompt({
        prompt: 'summarise',
        files: [{ path: file, type: 'text' }],
      }, outsideDir);
      assert.match(built, /explicitly requested content/);

      // Same file under a narrower root: still refused.
      assert.throws(
        () => layer.extractPrompt({
          prompt: 'summarise',
          files: [{ path: file, type: 'text' }],
        }, dir),
        /outside the workspace root/
      );
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('ignores a workspaceRoot supplied through the task', () => {
    // The root must come from a code-level argument, never from caller data.
    // Workflow steps spread arbitrary caller input into the task, so while the
    // root lived on the task an MCP caller could set it to a drive root and
    // read anything -- the control was bypassable by the threat it existed to
    // stop. Passing it on the task must now have no effect whatsoever.
    const outsideDir = join(tmpdir(), `cgmb-test-taskroot-${process.pid}`);
    rmSync(outsideDir, { recursive: true, force: true });
    mkdirSync(outsideDir, { recursive: true });
    const file = join(outsideDir, 'target.txt');
    writeFileSync(file, 'content the caller should not reach\n');

    try {
      assert.throws(
        () => layer.extractPrompt({
          prompt: 'summarise',
          workspaceRoot: outsideDir,       // attacker-controlled: must be ignored
          files: [{ path: file, type: 'text' }],
        }, dir),
        /outside the workspace root/,
        'a root on the task must not widen the trusted root'
      );
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('accepts ordinary source and extensionless files', () => {
    // A closed extension allowlist rejected .ts, .py, Dockerfile and LICENSE --
    // ordinary inputs for a developer tool.
    for (const name of ['module.ts', 'script.py', 'Dockerfile', 'LICENSE', '.gitignore', 'query.sql']) {
      const p = join(dir, name);
      writeFileSync(p, 'plain text content\n');
      const built = layer.extractPrompt({ prompt: 'review', files: [{ path: p, type: 'text' }] }, dir);
      assert.match(built, /plain text content/, `${name} must be inlinable`);
    }
  });

  it('fails loudly when the combined budget is exceeded', () => {
    // Previously the loop logged a warning and stopped, so later files never
    // reached the model while the caller still received a successful answer.
    const big = 'a'.repeat(90000);
    const files = [];
    for (let i = 0; i < 4; i++) {
      const p = join(dir, `bulk-${i}.txt`);
      writeFileSync(p, big);
      files.push({ path: p, type: 'text' });
    }

    assert.throws(
      () => layer.extractPrompt({ prompt: 'compare', files }, dir),
      /exceeds what one Antigravity CLI request can carry/,
      'exceeding the total budget must fail, not silently drop files'
    );
  });

  it('rejects binary content even when the caller claims it is text', () => {
    // FileReference.type comes from MCP input, so it cannot be trusted; the
    // decoded bytes are what matter.
    const disguised = join(dir, 'disguised.txt');
    writeFileSync(disguised, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0xff, 0xfe]));

    assert.throws(
      () => layer.extractPrompt({
        prompt: 'summarise',
        files: [{ path: disguised, type: 'text' }],
      }, dir),
      /is not text/,
      'binary content behind a .txt name must be refused'
    );
  });

  it('refuses a binary hidden behind a BOM, and decodes UTF-16 correctly', () => {
    // A BOM used to short-circuit the whole content check, so three prepended
    // bytes smuggled any binary through. And a UTF-16 BOM was accepted while
    // the body was still decoded as UTF-8, producing mojibake the model
    // answered as if it were prose.
    const bomBinary = join(dir, 'bom-binary.txt');
    writeFileSync(bomBinary, Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from([0x00, 0x01, 0x02, 0x03, 0x00, 0x04]),
    ]));
    assert.throws(
      () => layer.extractPrompt({ prompt: 'x', files: [{ path: bomBinary, type: 'text' }] }, dir),
      /not text/,
      'a BOM must not bypass the content check'
    );

    const utf16 = join(dir, 'utf16.txt');
    writeFileSync(utf16, Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('UTF16 CONTENT MARKER', 'utf16le'),
    ]));
    const built = layer.extractPrompt({ prompt: 'x', files: [{ path: utf16, type: 'text' }] }, dir);
    assert.match(built, /UTF16 CONTENT MARKER/, 'UTF-16 must be decoded, not mangled');
  });

  it('refuses binary hidden behind a UTF-16 BOM, and odd-length UTF-16', () => {
    // The magic-byte check ran against the original buffer, so a UTF-16 BOM
    // shifted every signature out of position and let PDF/ZIP bytes through as
    // mojibake. Odd-length input silently lost its final byte.
    const bomPdf = join(dir, 'utf16-pdf.txt');
    writeFileSync(bomPdf, Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]),
    ]));
    assert.throws(
      () => layer.extractPrompt({ prompt: 'x', files: [{ path: bomPdf, type: 'text' }] }, dir),
      /not text/,
      'a PDF behind a UTF-16 BOM must be refused'
    );

    const odd = join(dir, 'utf16-odd.txt');
    writeFileSync(odd, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from([0x41, 0x00, 0x42])]));
    assert.throws(
      () => layer.extractPrompt({ prompt: 'x', files: [{ path: odd, type: 'text' }] }, dir),
      /not text/,
      'odd-length UTF-16 must be refused rather than truncated'
    );
  });

  it('refuses a container signature shifted behind a UTF-16 prefix', () => {
    // Matching magic only at offset 0 was evadable: FF FE 41 00 decodes as a
    // valid UTF-16 'A' and pushes %PDF to offset 2, where nothing looked.
    const shifted = join(dir, 'shifted.txt');
    writeFileSync(shifted, Buffer.concat([
      Buffer.from([0xff, 0xfe, 0x41, 0x00]),
      Buffer.from('%PDF-1.4', 'ascii'),
    ]));
    assert.throws(
      () => layer.extractPrompt({ prompt: 'x', files: [{ path: shifted, type: 'text' }] }, dir),
      /not text/,
      'a shifted PDF signature must still be caught'
    );

    // Shifted well past any fixed window: a magic-offset search cannot catch
    // this, so the UTF-16 plausibility check has to.
    const farShifted = join(dir, 'far-shifted.txt');
    writeFileSync(farShifted, Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('AAAAAAAAAAAAAAAA', 'ascii'),
      Buffer.from('%PDF-1.4 stream endstream obj endobj xref trailer', 'ascii'),
    ]));
    assert.throws(
      () => layer.extractPrompt({ prompt: 'x', files: [{ path: farShifted, type: 'text' }] }, dir),
      /not text/,
      'ASCII data behind a UTF-16 BOM must be refused however far the signature is shifted'
    );

    // Genuine UTF-16 text must still be accepted.
    const realUtf16 = join(dir, 'real-utf16.txt');
    writeFileSync(realUtf16, Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('GENUINE UTF16 DOCUMENT TEXT', 'utf16le'),
    ]));
    const utf16Built = layer.extractPrompt(
      { prompt: 'x', files: [{ path: realUtf16, type: 'text' }] }, dir);
    assert.match(utf16Built, /GENUINE UTF16 DOCUMENT TEXT/);

    // Prose that merely mentions the signature further in must still pass.
    const prose = join(dir, 'about-pdf.md');
    writeFileSync(prose, 'This document explains how a PDF header such as %PDF-1.4 works.\n');
    const built = layer.extractPrompt({ prompt: 'x', files: [{ path: prose, type: 'text' }] }, dir);
    assert.match(built, /explains how a PDF header/);
  });

  it('accepts source files through the public processFiles filter', () => {
    // processFiles used to admit only type==='text' or .txt/.md, while
    // extractPrompt accepted anything decodable. The CLI sets type:'document',
    // so `cgmb gemini -f module.ts` failed before reaching the real check.
    for (const name of ['module.ts', 'data.json', 'Dockerfile']) {
      const p = join(dir, name);
      writeFileSync(p, 'source content\n');
      assert.equal(
        isInlinableTextFile({ path: p, type: 'document' }),
        true,
        `${name} must pass the shared admission test regardless of caller type`
      );
    }

    assert.equal(isInlinableTextFile({ path: join(dir, 'report.pdf'), type: 'text' }), false);
  });

  it('rejects an oversized file without reading it', () => {
    // The size check must happen before the read, or a large file stalls the
    // event loop and allocates twice its size before being rejected.
    const big = join(dir, 'huge.txt');
    writeFileSync(big, Buffer.alloc(500_000, 0x41));
    assert.throws(
      () => layer.extractPrompt({ prompt: 'x', files: [{ path: big, type: 'text' }] }, dir),
      /over the .* limit for a single inlined file/
    );
  });

  it('resolves symlinks before applying the credential check', () => {
    const secret = join(dir, '.env');
    const link = join(dir, 'notes.txt');
    writeFileSync(secret, 'PLACEHOLDER=not-a-real-secret\n');

    try {
      symlinkSync(secret, link);
    } catch (error) {
      // Unprivileged Windows accounts cannot create symlinks. Skip rather than
      // pass silently, so the gap is visible.
      if (error.code === 'EPERM' || error.code === 'ENOSYS') {
        return;
      }
      throw error;
    }

    assert.throws(
      () => layer.extractPrompt({ prompt: 'summarise', files: [{ path: link, type: 'text' }] }, dir),
      /credential file pattern/,
      'a link named notes.txt must not smuggle a credential file through'
    );
  });
});

describe('workspace isolation', () => {
  it('leaves no shared, predictably-named scratch directory behind', () => {
    // Regression: every run shared <tmp>/cgmb-agy-workspace and never cleaned
    // it, so files from one request could leak into the next, and the
    // predictable name invited pre-creation or symlink swaps on shared hosts.
    assert.equal(
      existsSync(join(tmpdir(), 'cgmb-agy-workspace')),
      false,
      'the fixed shared workspace must no longer be created'
    );

    // Any surviving per-run directories would mean cleanup regressed.
    const leftovers = readdirSync(tmpdir()).filter(name => /^cgmb-agy-/.test(name));
    assert.deepEqual(leftovers, [], `stale agy workspaces: ${leftovers.join(', ')}`);
  });
});
