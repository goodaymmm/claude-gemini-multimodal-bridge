/**
 * How far the environment loader is allowed to look for a .env.
 *
 * This is a credential and egress boundary, not a convenience.
 *
 * The default search list includes the package's own installation directory,
 * the global npm directory, and ~/.cgmb unconditionally.
 *
 * The ancestor walk in findProjectRoot() also has no ceiling at the user's
 * home -- but it could not be made to bite: planting a package.json named
 * claude-gemini-multimodal-bridge at an ancestor returns null on both Windows
 * and POSIX under Node 22, because the walk loads it with a dynamic import that
 * no longer works and swallows the failure. That is a separate defect (the
 * detection is dead), not a boundary that leaks, so it is not asserted here.
 *
 * A .env picked up that way supplies AI_STUDIO_API_KEY -- another project's key,
 * billed to someone else -- and CGMB_ALLOWED_ROOTS, which decides which files
 * this process is willing to send to Google. Widening that silently is the
 * serious half.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { after, describe, it } from 'node:test';

import { SmartEnvLoader } from '../dist/utils/envLoader.js';

const scratch = mkdtempSync(join(tmpdir(), 'cgmb-envb-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** Is `child` inside `parent`? */
function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && rel !== child;
}

describe('where a .env may be read from', () => {
  it('does not read an installation directory by default', async () => {
    // Measured on WSL, the default list contained
    // ~/.nvm/versions/node/v22/lib/node_modules/claude-gemini-multimodal-bridge
    // and ~/.cgmb. Neither is the user's project. A key left in an installation
    // directory is therefore picked up by every run of every project -- and so
    // is CGMB_ALLOWED_ROOTS, which decides what this process is willing to send
    // to Google. Widening that silently is the serious half.
    const paths = await new SmartEnvLoader().getDefaultSearchPaths();

    const suspicious = paths.filter(p => /node_modules|\.cgmb$/.test(p));

    assert.deepEqual(
      suspicious, [],
      `installation directories must be opt-in, not default:\n${suspicious.join('\n')}`
    );
  });

  it('still looks where the user actually is', async () => {
    // The boundary has to stay usable: the working directory is the whole point.
    // A loader that reads nothing would be safe and useless.
    const paths = await new SmartEnvLoader().getDefaultSearchPaths();

    assert.ok(paths.includes(process.cwd()), 'the working directory must still be searched');
  });

  it('proposes nothing at or above the user home', async () => {
    const paths = await new SmartEnvLoader().getDefaultSearchPaths();
    const home = homedir();

    const offenders = paths.filter(p => p === home || p === dirname(home) || isInside(p, home));

    assert.deepEqual(
      offenders, [],
      `these sit at or above the home directory:\n${offenders.join('\n')}`
    );
  });
});
