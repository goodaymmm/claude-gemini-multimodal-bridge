import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
