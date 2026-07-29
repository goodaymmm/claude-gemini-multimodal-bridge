/**
 * Where postinstall puts the .env file.
 *
 * It used `process.cwd()`, which during `npm install -g` is the directory npm
 * is installing the package into -- not the user's. Measured against the
 * published 1.2.0: the file landed at
 * <prefix>/lib/node_modules/claude-gemini-multimodal-bridge/.env while the
 * next-steps text said "Edit .env file and add your API keys". There was no
 * path from that instruction to that file.
 *
 * npm passes both facts needed to get this right: npm_config_global says which
 * kind of install this is, and INIT_CWD is the directory npm was invoked from.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));

const { isGlobalInstall, setupEnvironment } = require(join(HERE, '..', 'scripts', 'postinstall.cjs'));

// Not `cgmb-agy-*`: the workspace-isolation test scans tmpdir for that prefix.
const scratch = mkdtempSync(join(tmpdir(), 'cgmb-postinstall-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** Run setupEnvironment with npm's lifecycle variables set to a given shape. */
function runWith({ global: isGlobal, initCwd }, body) {
  const saved = { g: process.env.npm_config_global, i: process.env.INIT_CWD };
  if (isGlobal) { process.env.npm_config_global = 'true'; } else { delete process.env.npm_config_global; }
  if (initCwd) { process.env.INIT_CWD = initCwd; } else { delete process.env.INIT_CWD; }
  try {
    return body();
  } finally {
    if (saved.g === undefined) { delete process.env.npm_config_global; } else { process.env.npm_config_global = saved.g; }
    if (saved.i === undefined) { delete process.env.INIT_CWD; } else { process.env.INIT_CWD = saved.i; }
  }
}

describe('recognising the kind of install', () => {
  it('reads npm_config_global rather than guessing', () => {
    runWith({ global: true }, () => assert.equal(isGlobalInstall(), true));
    runWith({ global: false }, () => assert.equal(isGlobalInstall(), false));
  });
});

describe('the .env file postinstall creates', () => {
  it('writes nothing anywhere during a global install', () => {
    // The right directory is whichever one the user later runs cgmb from, and
    // only they know that. INIT_CWD is where `npm i -g` was typed, which is as
    // likely to be $HOME; the package directory is worse still. So: guidance,
    // not a file.
    const dir = mkdtempSync(join(scratch, 'global-'));

    const ok = runWith({ global: true, initCwd: dir }, () => setupEnvironment());

    assert.equal(ok, true, 'it must still report success');
    assert.deepEqual(readdirSync(dir), [], 'a global install must not drop a file');
  });

  it('uses INIT_CWD for a local install, not the package directory', () => {
    const dir = mkdtempSync(join(scratch, 'local-'));

    const ok = runWith({ global: false, initCwd: dir }, () => setupEnvironment());

    assert.equal(ok, true);
    assert.ok(existsSync(join(dir, '.env')), 'the project root is where a developer expects it');
  });

  it('never overwrites an existing .env', () => {
    // Someone's real credentials live in this file.
    const dir = mkdtempSync(join(scratch, 'existing-'));
    const envPath = join(dir, '.env');
    writeFileSync(envPath, 'AI_STUDIO_API_KEY=already-here\n', 'utf8');

    runWith({ global: false, initCwd: dir }, () => setupEnvironment());

    assert.match(
      require('node:fs').readFileSync(envPath, 'utf8'), /already-here/,
      'an existing file must survive untouched'
    );
  });
});
