/**
 * Which install npm is performing, and where the .env belongs.
 *
 * postinstall used process.cwd(), which during `npm install -g` is the
 * directory npm is installing into -- measured against the published 1.2.0, the
 * template landed inside the installed package while the next steps said "Edit
 * .env file". The first fix read npm_config_global and INIT_CWD, and review
 * caught two ways that is still wrong, both confirmed with a probe package:
 *
 *   `npm i --location=global` installs globally but leaves npm_config_global
 *   unset, setting npm_config_location=global instead.
 *
 *   INIT_CWD is where npm was invoked. Run `npm i <pkg>` from a subdirectory
 *   and it is <proj>/subdir, while the project root -- npm_config_local_prefix
 *   -- is <proj>.
 *
 * The earlier test could not have caught either, because it set INIT_CWD to the
 * directory it wanted and then asserted the code used it. So these tests take
 * the environment from real npm installs of a fixture package, and feed what
 * npm actually produced into the detection under test.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));

const {
  isGlobalInstall,
  localInstallRoot,
  needsBuildStep,
  setupEnvironment,
} = require(join(HERE, '..', 'scripts', 'postinstall.cjs'));

// Not `cgmb-agy-*`: the workspace-isolation test scans tmpdir for that prefix.
const scratch = mkdtempSync(join(tmpdir(), 'cgmb-install-kind-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** npm is a .cmd shim on Windows and cannot be spawned without a shell. */
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function npm(args, cwd) {
  return execFileSync(NPM, args, {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 180000,
    windowsHide: true,
    shell: process.platform === 'win32',
  });
}

/** The environment npm handed the fixture's postinstall, as npm produced it. */
function envFrom(output) {
  const line = output.split('\n').find(l => l.includes('CGMB_PROBE'));
  assert.ok(line, `the fixture must have run its postinstall:\n${output.slice(0, 400)}`);
  return JSON.parse(line.slice(line.indexOf('CGMB_PROBE') + 'CGMB_PROBE '.length));
}

/** Filled in by the real installs below; null when npm is unavailable. */
const observed = { globalFlag: null, globalLocation: null, localFromSubdir: null };
let tarball;
let project;

before(() => {
  try {
    npm(['--version']);
  } catch {
    return; // leaves observed.* null; the cases below skip
  }

  const fixture = join(HERE, 'fixtures', 'install-kind-probe');
  const packDir = mkdtempSync(join(scratch, 'pack-'));
  const packed = npm(['pack', fixture, '--pack-destination', packDir]).trim().split('\n').pop();
  tarball = join(packDir, packed.trim());

  // A. the documented spelling
  observed.globalFlag = envFrom(
    npm(['install', '-g', '--foreground-scripts', '--prefix', mkdtempSync(join(scratch, 'gA-')), tarball])
  );

  // B. the spelling that slipped through
  observed.globalLocation = envFrom(
    npm(['install', '--location=global', '--foreground-scripts', '--prefix', mkdtempSync(join(scratch, 'gB-')), tarball])
  );

  // C. a local install run from a subdirectory of the project
  project = mkdtempSync(join(scratch, 'proj-'));
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'host', version: '1.0.0' }), 'utf8');
  const subdir = join(project, 'subdir');
  mkdirSync(subdir);
  observed.localFromSubdir = envFrom(npm(['install', '--foreground-scripts', tarball], subdir));
});

describe('recognising the kind of install, against real npm', () => {
  it('treats both spellings of a global install as global', (t) => {
    if (!observed.globalFlag) { return t.skip('npm not available'); }

    assert.equal(isGlobalInstall(observed.globalFlag), true, 'npm i -g');
    assert.equal(
      isGlobalInstall(observed.globalLocation), true,
      'npm i --location=global installs globally too, and sets a different variable'
    );

    // The distinction this is guarding, stated as npm reports it.
    assert.equal(observed.globalLocation.npm_config_global, undefined);
    assert.equal(observed.globalLocation.npm_config_location, 'global');
  });

  it('does not treat a local install as global', (t) => {
    if (!observed.localFromSubdir) { return t.skip('npm not available'); }

    assert.equal(isGlobalInstall(observed.localFromSubdir), false);
  });

  it('resolves a local install to the project root, not the invoking directory', (t) => {
    if (!observed.localFromSubdir) { return t.skip('npm not available'); }

    const env = observed.localFromSubdir;
    assert.notEqual(env.INIT_CWD, env.npm_config_local_prefix, 'the fixture must exercise the difference');
    assert.equal(
      localInstallRoot(env), env.npm_config_local_prefix,
      'a .env in a subdirectory is not where CGMB will look for it'
    );
  });

  it('falls back to INIT_CWD when npm does not report a local prefix', () => {
    // Older npm. Not produced by the installs above, so stated directly.
    assert.equal(localInstallRoot({ INIT_CWD: '/somewhere/project' }), '/somewhere/project');
  });
});

describe('whether to tell the user to build', () => {
  it('stays silent when the entry point is already there', () => {
    // Every published copy: `files` ships dist, so a dependency install never
    // needs building. Recommending it there sends the user at their own
    // project's build script.
    const dir = mkdtempSync(join(scratch, 'built-'));
    mkdirSync(join(dir, 'dist'));
    writeFileSync(join(dir, 'dist', 'cli.js'), '#!/usr/bin/env node\n', 'utf8');

    assert.equal(needsBuildStep(dir), false);
  });

  it('asks for a build only when there is nothing to run', () => {
    assert.equal(needsBuildStep(mkdtempSync(join(scratch, 'checkout-'))), true);
  });
});

describe('the .env file postinstall creates', () => {
  /** Run setupEnvironment with a given lifecycle environment. */
  function withEnv(env, body) {
    const keys = ['npm_config_global', 'npm_config_location', 'npm_config_local_prefix', 'INIT_CWD'];
    const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
    for (const k of keys) { delete process.env[k]; }
    Object.assign(process.env, env);
    try {
      return body();
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) { delete process.env[k]; } else { process.env[k] = saved[k]; }
      }
    }
  }

  it('writes nothing during either spelling of a global install', (t) => {
    if (!observed.globalFlag) { return t.skip('npm not available'); }

    // The right directory is whichever one the user later runs cgmb from, and
    // only they know that. So: guidance, not a file.
    for (const [label, env] of [['-g', observed.globalFlag], ['--location=global', observed.globalLocation]]) {
      const dir = mkdtempSync(join(scratch, 'gcheck-'));
      const ok = withEnv({ ...env, npm_config_local_prefix: dir, INIT_CWD: dir }, () => setupEnvironment());

      assert.equal(ok, true, `${label} must still report success`);
      assert.deepEqual(readdirSync(dir), [], `${label} must not drop a file`);
    }
  });

  it('writes to the project root for a local install', () => {
    const proj = mkdtempSync(join(scratch, 'local-'));
    const sub = join(proj, 'subdir');
    mkdirSync(sub);

    const ok = withEnv({ npm_config_local_prefix: proj, INIT_CWD: sub }, () => setupEnvironment());

    assert.equal(ok, true);
    assert.ok(existsSync(join(proj, '.env')), 'the project root is where CGMB reads it from');
    assert.ok(!existsSync(join(sub, '.env')), 'not the directory npm happened to be invoked from');
  });

  it('never overwrites an existing .env', () => {
    // Someone's real credentials live in this file.
    const dir = mkdtempSync(join(scratch, 'existing-'));
    writeFileSync(join(dir, '.env'), 'AI_STUDIO_API_KEY=already-here\n', 'utf8');

    withEnv({ npm_config_local_prefix: dir, INIT_CWD: dir }, () => setupEnvironment());

    assert.match(readFileSync(join(dir, '.env'), 'utf8'), /already-here/);
  });
});
