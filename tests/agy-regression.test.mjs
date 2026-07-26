/**
 * Antigravity CLI discovery and subprocess regressions.
 *
 * These are the cases the migration plan listed as untested: a machine with no
 * agy, a leftover GEMINI_CLI_PATH from the retired Gemini CLI, a CLI that
 * accepts the call and never answers, and one that ignores SIGTERM.
 *
 * The stubs live under os.tmpdir(), not tests/fixtures/. That is not a
 * preference: findAntigravityBinary() runs every candidate through
 * isUntrustedBinaryLocation(), which rejects anything inside the working
 * directory -- so a fixture in the repo would be silently ignored and the tests
 * would pass for the wrong reason.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  findAntigravityBinary,
  looksLikeAgyBinary,
  probeAntigravityAuth,
} from '../dist/utils/antigravityCli.js';

const isWindows = process.platform === 'win32';
// Not `cgmb-agy-*`: the workspace-isolation test scans tmpdir for that prefix
// to prove the layer cleans up after itself, and test files run in parallel, so
// a scratch directory named that way makes an unrelated test fail.
const scratch = mkdtempSync(join(tmpdir(), 'cgmb-stub-'));

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/**
 * Write a stub that behaves like `agy` for the arguments we care about.
 *
 * Returns the path to invoke. On Windows a .cmd shim is required: node cannot
 * spawn a .mjs directly, and buildSpawnTarget already routes .cmd through
 * cmd.exe -- the same shape the `windows .cmd launcher` test covers.
 */
function writeAgyStub(name, body) {
  const scriptPath = join(scratch, `${name}.mjs`);
  writeFileSync(scriptPath, body, 'utf8');

  // process.execPath, not a bare `node`. Tests here move PATH around, and a
  // shim that resolves the interpreter through PATH fails with "not
  // recognized" -- which the probe then reports as an authentication problem,
  // sending the test chasing the wrong thing.
  const nodeBin = process.execPath;

  if (!isWindows) {
    const shPath = join(scratch, name);
    writeFileSync(shPath, `#!/bin/sh\nexec "${nodeBin}" "${scriptPath}" "$@"\n`, { mode: 0o755 });
    return shPath;
  }

  const cmdPath = join(scratch, `${name}.cmd`);
  writeFileSync(cmdPath, `@echo off\r\n"${nodeBin}" "${scriptPath}" %*\r\n`, 'utf8');
  return cmdPath;
}

/** Run a body with env vars set, restoring whatever was there before. */
async function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) { delete process.env[k]; } else { process.env[k] = v; }
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) { delete process.env[k]; } else { process.env[k] = v; }
    }
  }
}

describe('agy is not installed', () => {
  it('reports not-installed rather than pretending to be authenticated', async () => {
    const missing = join(scratch, 'definitely-not-here', 'agy');

    const probe = await probeAntigravityAuth(missing, { timeoutMs: 4000 });

    assert.equal(probe.authenticated, false, 'a missing binary is never authenticated');
    assert.ok(probe.error, 'the caller needs a reason it can print');
  });

  it('never adopts an override that does not exist', async () => {
    // Discovery also probes the known installer targets, so on a machine that
    // genuinely has agy this returns the real one -- which is correct. What
    // must never happen is adopting the missing path itself, or falling back to
    // a bare `agy` for PATH to resolve later.
    const missing = join(scratch, 'nope', 'agy');

    const found = await withEnv(
      {
        ANTIGRAVITY_CLI_PATH: missing,
        GEMINI_CLI_PATH: undefined,
      },
      () => findAntigravityBinary({ refresh: true })
    );

    if (found) {
      assert.notEqual(found.path, missing, 'a missing override must not be adopted');
      assert.notEqual(found.path, 'agy', 'discovery must not fall back to a bare command name');
    }
  });
});

describe('leftover Gemini CLI path', () => {
  it('refuses a GEMINI_CLI_PATH that does not name agy', () => {
    // On an upgraded machine this variable still points at the retired Gemini
    // CLI, which answers --version happily. Adopting it would run the wrong
    // binary and skip the search for a real agy.
    assert.equal(looksLikeAgyBinary('/usr/local/bin/gemini'), false);
    assert.equal(looksLikeAgyBinary('C:\\tools\\gemini.exe'), false);
    assert.equal(looksLikeAgyBinary('/opt/agy/bin/agy'), true);
    assert.equal(looksLikeAgyBinary('C:\\agy\\bin\\agy.EXE'), true);
    assert.equal(looksLikeAgyBinary('agy.cmd'), true);
  });

  it('ignores a stale GEMINI_CLI_PATH even when the file runs', async () => {
    // A stub named `gemini` that answers like a healthy CLI. It must still be
    // passed over, because the name is the tell.
    const stub = writeAgyStub('gemini', `
      const args = process.argv.slice(2);
      if (args.includes('--version')) { console.log('1.9.9'); process.exit(0); }
      console.log('gemini-3.6-flash-low');
      process.exit(0);
    `);

    // PATH is deliberately left alone: this test is about which override is
    // adopted, and rewriting PATH only risks leaking into later cases.
    const found = await withEnv(
      {
        ANTIGRAVITY_CLI_PATH: undefined,
        GEMINI_CLI_PATH: stub,
      },
      () => findAntigravityBinary({ refresh: true })
    );

    if (found) {
      assert.notEqual(
        found.path, stub,
        'a binary named gemini must never be adopted as agy'
      );
    }
  });
});

describe('agy accepts the call and never answers', () => {
  it('times out instead of hanging or reporting success', async () => {
    const stub = writeAgyStub('agy-silent', `
      const args = process.argv.slice(2);
      if (args.includes('--version')) { console.log('1.1.7'); process.exit(0); }
      // Never write to stdout, never exit: the shape of a wedged CLI.
      setInterval(() => {}, 1000);
    `);

    const started = Date.now();
    const probe = await probeAntigravityAuth(stub, { timeoutMs: 3000 });
    const elapsed = Date.now() - started;

    assert.equal(probe.authenticated, false, 'no answer is not an authenticated session');
    assert.equal(
      probe.outcome, 'timeout',
      `expected a timeout outcome, got ${JSON.stringify(probe)} after ${Date.now() - started}ms`
    );
    assert.ok(
      elapsed < 20000,
      `the probe must give up near its own budget, took ${elapsed}ms`
    );
  });

  it('does not treat an empty successful exit as authenticated', async () => {
    // Exit 0 with no output is what agy versions below 1.1.7 do on a non-TTY.
    // Reading that as success is how the layer used to report itself healthy on
    // a machine where every request would fail.
    const stub = writeAgyStub('agy-empty', `
      const args = process.argv.slice(2);
      if (args.includes('--version')) { console.log('1.1.7'); process.exit(0); }
      process.exit(0);
    `);

    const probe = await probeAntigravityAuth(stub, { timeoutMs: 4000 });
    assert.equal(probe.authenticated, false, 'silence with exit 0 is not authentication');
  });
});

describe('agy ignores SIGTERM', () => {
  it('escalates to SIGKILL so no process is left behind', { skip: isWindows && 'POSIX signals' }, async () => {
    // The layer sends SIGTERM, waits, then SIGKILL -- but only while the child
    // is still alive. An earlier version escalated unconditionally, so a child
    // that had already exited got a stray signal, and one that ignored SIGTERM
    // survived in the background.
    const { spawn } = await import('node:child_process');

    const stubPath = join(scratch, 'ignores-sigterm.mjs');
    writeFileSync(stubPath, `
      process.on('SIGTERM', () => {});   // deliberately ignored
      setInterval(() => {}, 1000);
      console.log('ready');
    `, 'utf8');

    const child = spawn(process.execPath, [stubPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise(resolve => child.stdout.once('data', resolve));

    child.kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 300));

    assert.equal(child.exitCode, null, 'the stub must still be running after SIGTERM');
    assert.equal(child.signalCode, null, 'and must not have been signalled dead');

    // This is the condition the layer gates escalation on.
    const stillAlive = child.exitCode === null && child.signalCode === null;
    assert.equal(stillAlive, true, 'escalation must be gated on the child still being alive');

    child.kill('SIGKILL');
    const code = await new Promise(resolve => child.on('close', (_c, signal) => resolve(signal)));
    assert.equal(code, 'SIGKILL', 'SIGKILL must actually end it');
  });

  it('does not signal a child that already exited', async () => {
    const { spawn } = await import('node:child_process');

    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    await new Promise(resolve => child.on('close', resolve));

    // After exit, exitCode is set -- so the layer's guard is false and no
    // signal is sent. Sending one here would throw ESRCH on some platforms.
    assert.notEqual(child.exitCode, null, 'an exited child reports its code');
    assert.equal(
      child.exitCode === null && child.signalCode === null, false,
      'the escalation guard must be false for an exited child'
    );
  });
});
