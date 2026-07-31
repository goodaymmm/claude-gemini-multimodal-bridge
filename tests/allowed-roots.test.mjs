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
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
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

describe('a directory link out of the root, on every platform', () => {
  // The file-symlink case above skips where symlinks need elevation, which is
  // Windows -- so the one case covering escape-by-link was absent exactly where
  // reparse points are most common. A junction is a directory link Windows
  // creates without elevation, and node makes one when asked for type
  // 'junction'; elsewhere that argument is ignored and an ordinary symlink
  // results. So this runs everywhere.

  const linkedDir = join(workspace, 'linked-dir');
  let available = true;
  try {
    symlinkSync(outside, linkedDir, 'junction');
  } catch {
    available = false;
  }

  it('refuses a file reached through a linked directory', {
    skip: !available && 'neither junctions nor directory symlinks can be created here',
  }, () => {
    const verdict = checkPath(join(linkedDir, 'secret.txt'));

    assert.equal(verdict.ok, false, 'the bytes are outside the root however the path spells it');
    assert.match(verdict.message, /outside every allowed directory/);
  });

  it('still accepts a real file beside the link', {
    skip: !available && 'neither junctions nor directory symlinks can be created here',
  }, () => {
    // The refusal must be about where the file is, not about a link existing.
    const verdict = checkPath(join(workspace, 'report.txt'));

    assert.equal(verdict.ok, true, verdict.message);
  });
});

describe('what the registered MCP entry decides about egress', () => {
  // The suite could not see this: every case above fixes the child's cwd, and
  // that cwd becomes the allowed root. But the entry written into Claude Code's
  // config pins neither a cwd nor CGMB_ALLOWED_ROOTS, so the root is whatever
  // directory the host happened to launch from. Started from a home directory,
  // the whole of it becomes uploadable.
  //
  // These cases record that contract rather than change it -- the behaviour is
  // deliberate as far as the documentation goes ("only reads from the directory
  // it was started in"), but it should be visible here rather than discovered.

  it('pins no working directory and no allowed roots', async () => {
    const { MCPConfigManager } = await import('../dist/utils/mcpConfigManager.js');
    const entry = new MCPConfigManager().generateCGMBConfig();

    assert.equal(entry.cwd, undefined, 'nothing fixes where the server starts');
    assert.equal(
      entry.env?.CGMB_ALLOWED_ROOTS, undefined,
      'and nothing fixes which directories it may upload from'
    );
    assert.ok(Array.isArray(entry.args) && entry.args.includes('serve'), 'it does launch the server');
  });

  it('therefore takes its egress boundary from wherever it was started', () => {
    // Demonstrated, not assumed: the same file is refused from one cwd and
    // accepted from a broader one, with no configuration difference.
    const broad = scratch; // stands in for a home directory containing both trees

    assert.equal(
      checkPath(join(outside, 'secret.txt')).ok, false,
      'refused when started inside the workspace'
    );
    assert.equal(
      checkPath(join(outside, 'secret.txt'), { cwd: broad }).ok, true,
      'accepted when started one level up -- the boundary is the launch directory'
    );
  });
});
