/**
 * Which files the AI Studio MCP server will send to Google.
 *
 * That server is the only place in CGMB where a caller-supplied path becomes
 * bytes on someone else's machine, so it is where the boundary belongs. Being
 * able to read a file locally is not the same authorisation as uploading it.
 *
 * The check itself is a small pure function over paths, so it is exercised
 * directly rather than by driving the server: constructing the server needs an
 * API key, and the interesting cases are all about path resolution.
 *
 * The module resolves its roots at import time from process.cwd(), so a child
 * process is spawned per scenario with the cwd and CGMB_ALLOWED_ROOTS we want.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, '..', 'dist', 'mcp-servers', 'ai-studio-mcp-server.js');

// Not `cgmb-agy-*`: the workspace-isolation test scans tmpdir for that prefix.
const scratch = mkdtempSync(join(tmpdir(), 'cgmb-roots-'));
const workspace = join(scratch, 'workspace');
const outside = join(scratch, 'outside');

mkdirSync(workspace, { recursive: true });
mkdirSync(outside, { recursive: true });
writeFileSync(join(workspace, 'report.txt'), 'inside the workspace\n');
writeFileSync(join(outside, 'secret.txt'), 'outside the workspace\n');

/** A symlink inside the workspace pointing at a file outside it. */
let escapeLink = join(workspace, 'looks-innocent.txt');
let escapeLinkAvailable = true;
try {
  symlinkSync(join(outside, 'secret.txt'), escapeLink);
} catch {
  // Windows needs developer mode or elevation for symlinks.
  escapeLinkAvailable = false;
}

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/**
 * Run assertReadableRoot in a child with a chosen cwd and allowed roots.
 *
 * Returns { ok, resolved } or { ok: false, message }.
 */
function checkPath(filePath, { cwd = workspace, allowedRoots } = {}) {
  const script = `
    import { assertReadableRoot } from ${JSON.stringify(new URL(`file:///${SERVER.replace(/\\\\/g, '/')}`).href)};
    try {
      const resolved = assertReadableRoot(process.env.CGMB_TEST_PATH);
      console.log('OK ' + JSON.stringify({ ok: true, resolved }));
    } catch (error) {
      console.log('OK ' + JSON.stringify({ ok: false, message: String(error.message) }));
    }
  `;

  // Passed through the environment rather than argv: with `node -e` the
  // positional arguments land at different indices than a script file, which is
  // an easy way to test nothing at all.
  const env = { ...process.env, AI_STUDIO_API_KEY: 'test-key-not-used', CGMB_TEST_PATH: filePath };
  if (allowedRoots === undefined) {
    delete env.CGMB_ALLOWED_ROOTS;
  } else {
    env.CGMB_ALLOWED_ROOTS = allowedRoots;
  }

  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 30000,
  });

  const line = out.split('\n').find(l => l.startsWith('OK '));
  assert.ok(line, `child produced no verdict:\n${out}`);
  return JSON.parse(line.slice(3));
}

describe('AI Studio egress: allowed roots', () => {
  it('accepts a file inside the working directory', () => {
    const verdict = checkPath(join(workspace, 'report.txt'));
    assert.equal(verdict.ok, true, verdict.message);
  });

  it('refuses an absolute path outside every root', () => {
    const verdict = checkPath(join(outside, 'secret.txt'));

    assert.equal(verdict.ok, false, 'a file outside the workspace must not be uploaded');
    assert.match(verdict.message, /outside every allowed directory/);
    // The refusal has to say how to allow it, or it just looks broken.
    assert.match(verdict.message, /CGMB_ALLOWED_ROOTS/);
  });

  it('refuses a path that climbs out with ..', () => {
    const climbing = join(workspace, '..', 'outside', 'secret.txt');
    const verdict = checkPath(climbing);

    assert.equal(verdict.ok, false, '.. must not be a way out');
  });

  it('refuses a symlink inside the root that points outside it', { skip: !escapeLinkAvailable && 'symlinks unavailable' }, () => {
    // The reason the check resolves before comparing. A name-only check sees
    // looks-innocent.txt sitting in the workspace and lets it through.
    const verdict = checkPath(escapeLink);

    assert.equal(verdict.ok, false, 'a link out of the workspace must be refused');
    assert.match(verdict.message, /outside every allowed directory/);
  });

  it('accepts a directory named in CGMB_ALLOWED_ROOTS', () => {
    const verdict = checkPath(join(outside, 'secret.txt'), { allowedRoots: outside });

    assert.equal(verdict.ok, true, verdict.message);
  });

  it('returns the resolved path, so the caller reads what was checked', () => {
    const verdict = checkPath(join(workspace, '.', 'report.txt'));

    assert.equal(verdict.ok, true, verdict.message);
    assert.doesNotMatch(verdict.resolved, /[/\\]\.[/\\]/, 'the returned path must be resolved');
  });

  it('refuses a path that does not exist rather than assuming it is fine', () => {
    const verdict = checkPath(join(workspace, 'no-such-file.txt'));

    assert.equal(verdict.ok, false);
    assert.match(verdict.message, /Cannot resolve/);
  });
});
