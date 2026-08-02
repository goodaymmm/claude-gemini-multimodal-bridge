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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { after, afterEach, describe, it } from 'node:test';

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

/**
 * Narrowing the default list is only half a boundary. The locations that were
 * dropped -- an installation directory, a shared ~/.cgmb -- are still legitimate
 * places to keep a key; they just have to be asked for. CGMB_ENV_PATH is the
 * whole of that opt-in, so if it does not work the narrowing is a removal.
 *
 * It did not work for the obvious spelling. The loader appends '.env' to every
 * entry, so a variable pointing at a .env *file* was looked for at <file>/.env
 * and never found -- and nothing reports a search that found nothing. Measured
 * in the clean-environment run: the key was not loaded, the AI Studio layer
 * failed to authenticate, and the error named the missing key rather than the
 * path that was never read.
 */
describe('the opt-in that replaces what the default list dropped', () => {
  const saved = process.env.CGMB_ENV_PATH;
  afterEach(() => {
    if (saved === undefined) { delete process.env.CGMB_ENV_PATH; } else { process.env.CGMB_ENV_PATH = saved; }
  });

  /** A directory holding `files`, e.g. { '.env': 'A=1' }. */
  function envDir(name, files) {
    const dir = join(scratch, name);
    mkdirSync(dir, { recursive: true });
    for (const [file, body] of Object.entries(files)) {
      writeFileSync(join(dir, file), body, 'utf8');
    }
    return dir;
  }

  it('reads a .env named as a file', async () => {
    // How anyone would write it: the path of the file they want read.
    const dir = envDir('as-file', { '.env': 'CGMB_TEST_AS_FILE=from-file\n' });

    process.env.CGMB_ENV_PATH = join(dir, '.env');
    await new SmartEnvLoader().loadEnvironment({ forceReload: true });

    assert.equal(
      process.env.CGMB_TEST_AS_FILE, 'from-file',
      'naming the file itself must work -- silently reading nothing is the failure mode this replaces'
    );
  });

  it('reads a .env named as its directory', async () => {
    const dir = envDir('as-dir', { '.env': 'CGMB_TEST_AS_DIR=from-dir\n' });

    process.env.CGMB_ENV_PATH = dir;
    await new SmartEnvLoader().loadEnvironment({ forceReload: true });

    assert.equal(process.env.CGMB_TEST_AS_DIR, 'from-dir', 'the directory form must keep working');
  });

  it('reads the file it was given, not a sibling .env', async () => {
    // Guards the shortcut fix: taking dirname() of the named file and appending
    // '.env' makes the file form appear to work while reading a different file.
    // Here that would load the wrong key and report success.
    const dir = envDir('named-file', {
      'prod.env': 'CGMB_TEST_WHICH_FILE=named\n',
      '.env': 'CGMB_TEST_WHICH_FILE=sibling\n',
    });

    process.env.CGMB_ENV_PATH = join(dir, 'prod.env');
    await new SmartEnvLoader().loadEnvironment({ forceReload: true });

    assert.equal(
      process.env.CGMB_TEST_WHICH_FILE, 'named',
      'the named file must be the one that is read'
    );
  });
});
