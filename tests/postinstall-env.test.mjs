/**
 * What postinstall writes, and when it decides it is running under CI.
 *
 * It used to create a .env in process.cwd() -- under npm, the package's own
 * installation directory -- and tell the user to edit it. The env loader has
 * not read the installation directory since 1.2.1, so that file was read by
 * nothing. Its fallback template also wrote AI_STUDIO_API_KEY=${GEMINI_API_KEY},
 * which dotenv does not expand: the literal text became the key.
 *
 * And `if (process.env.CI)` took CI=false -- set precisely to say "not CI" --
 * as CI.
 *
 * The module is only required in child processes here, never in this one: see
 * ci-guard.test.mjs for why.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const POSTINSTALL = join(HERE, '..', 'scripts', 'postinstall.cjs');

function run(code, { cwd = join(HERE, '..'), env = {} } = {}) {
  const inherited = { ...process.env };
  delete inherited.NODE_TEST_CONTEXT;
  delete inherited.CI;
  delete inherited.CONTINUOUS_INTEGRATION;
  const result = spawnSync(process.execPath, ['-e', code], {
    cwd,
    env: { ...inherited, ...env },
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

describe('postinstall does not write a .env', () => {
  it('leaves the directory it runs in untouched and says where the key goes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cgmb-postinstall-'));
    try {
      const out = run(
        `require(${JSON.stringify(POSTINSTALL)}).setupEnvironment();`,
        { cwd: dir }
      );

      assert.deepEqual(readdirSync(dir), [], 'postinstall created files in its working directory');
      assert.match(out, /AI_STUDIO_API_KEY=/);
      assert.match(out, /directory you run it in/);
      assert.match(out, /CGMB_ENV_PATH/);
      assert.doesNotMatch(out, /Created \.env/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('what counts as CI', () => {
  const verdicts = (envs) => JSON.parse(run(
    `const { isCiEnvironment } = require(${JSON.stringify(POSTINSTALL)});` +
    `console.log(JSON.stringify(${JSON.stringify(envs)}.map(e => isCiEnvironment(e))));`
  ));

  it('takes true, 1 and yes, in any case, from CI or CONTINUOUS_INTEGRATION', () => {
    const envs = [
      { CI: 'true' }, { CI: 'TRUE' }, { CI: '1' }, { CI: 'yes' }, { CI: ' Yes ' },
      { CONTINUOUS_INTEGRATION: 'true' }, { CONTINUOUS_INTEGRATION: '1' },
      { CI: 'false', CONTINUOUS_INTEGRATION: 'true' },
    ];
    assert.deepEqual(verdicts(envs), envs.map(() => true));
  });

  it('does not take false, 0, no or an empty value', () => {
    const envs = [
      {}, { CI: '' }, { CI: 'false' }, { CI: 'FALSE' }, { CI: '0' }, { CI: 'no' },
      { CONTINUOUS_INTEGRATION: 'false' }, { CONTINUOUS_INTEGRATION: '0' },
      { CI: 'false', CONTINUOUS_INTEGRATION: 'false' },
    ];
    assert.deepEqual(verdicts(envs), envs.map(() => false));
  });
});
