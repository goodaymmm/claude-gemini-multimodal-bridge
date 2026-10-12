/**
 * How far the environment loader is allowed to look for a .env.
 *
 * This is a credential and egress boundary, not a convenience.
 *
 * Up to 1.2.0 the default search list included the package's own installation
 * directory, the global npm directory, and ~/.cgmb unconditionally; since 1.2.1
 * they are read only when CGMB_ENV_PATH names them.
 *
 * There was also an ancestor walk, findProjectRoot(), with no ceiling at the
 * user's home. It never added a directory under Node 22 -- it loaded
 * package.json with a dynamic import that no longer works and swallowed the
 * failure -- and it was removed in 1.3.0, so the default list is now
 * CGMB_ENV_PATH, then the working directory, and nothing else.
 *
 * A .env picked up that way supplies AI_STUDIO_API_KEY -- another project's key,
 * billed to someone else -- and CGMB_ALLOWED_ROOTS, which decides which files
 * this process is willing to send to Google. Widening that silently is the
 * serious half.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { after, afterEach, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

/**
 * Loading a .env must not write to stdout.
 *
 * `cgmb serve` speaks JSON-RPC on stdout, so a single extra line there breaks
 * the MCP client. dotenv 17 began printing an "injected env (N) from .env" line
 * on every load unless asked to be quiet, and dotenv 18 also reads DEBUG,
 * QUIET, OVERRIDE and PATH from DOTENV_* variables in the environment -- its
 * debug log goes to console.log. The load runs in a child process so that its
 * stdout can be captured on its own, with those variables set against us.
 */
describe('loading a .env is silent on stdout', () => {
  const LOADER = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'utils', 'envLoader.js')).href;

  function loadInChild(dir, extraEnv) {
    const script = [
      `const { SmartEnvLoader, loadDotenvFile } = await import(${JSON.stringify(LOADER)});`,
      `process.env.CGMB_TEST_PRESET = 'from-shell';`,
      `await new SmartEnvLoader().loadEnvironment({ forceReload: true });`,
      `loadDotenvFile();`,
      `process.stderr.write('RESULT ' + JSON.stringify({ loaded: process.env.CGMB_TEST_QUIET, preset: process.env.CGMB_TEST_PRESET }) + '\\n');`,
    ].join('\n');
    return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: dir,
      env: { ...process.env, CGMB_ENV_PATH: join(dir, '.env'), LOG_LEVEL: 'error', ...extraEnv },
      encoding: 'utf8',
      windowsHide: true,
    });
  }

  for (const [label, extraEnv] of [
    ['with no DOTENV_* settings', {}],
    ['with DOTENV_* settings asking for output', {
      DOTENV_CONFIG_QUIET: 'false',
      DOTENV_QUIET: 'false',
      DOTENV_DEBUG: 'true',
      DOTENV_CONFIG_DEBUG: 'true',
      DOTENV_OVERRIDE: 'true',
    }],
  ]) {
    it(`writes nothing to stdout ${label}`, () => {
      const dir = join(scratch, `quiet-${Object.keys(extraEnv).length}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, '.env'), 'CGMB_TEST_QUIET=loaded\nCGMB_TEST_PRESET=from-file\n', 'utf8');

      const run = loadInChild(dir, extraEnv);

      assert.equal(run.status, 0, `the child failed:\n${run.stderr}`);
      assert.equal(run.stdout, '', 'stdout is the MCP channel; loading a .env must leave it empty');

      const line = run.stderr.split('\n').find(l => l.startsWith('RESULT '));
      assert.ok(line, `no result line:\n${run.stderr}`);
      const result = JSON.parse(line.slice('RESULT '.length));
      assert.equal(result.loaded, 'loaded', 'the .env must still be read');
      assert.equal(result.preset, 'from-shell', 'a value already in the environment must win over the .env');
    });
  }
});
