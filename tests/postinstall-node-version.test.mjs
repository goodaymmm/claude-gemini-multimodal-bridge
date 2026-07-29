/**
 * The Node version gate in postinstall.
 *
 * This runs on every fresh install, before anything is written. It used to
 * compare version *strings* against a hardcoded v18 while package.json required
 * 22, so an unsupported Node passed and the setup then pinned that Node's
 * executable path into the user's Claude Code config. The install reported
 * success and the server failed later, at first use, pointing nowhere near the
 * cause.
 *
 * The check takes the version as an argument, which is what makes the
 * unsupported cases testable without an unsupported Node to run them on.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));

// Requiring this used to run the whole installer; it is guarded by
// `require.main === module` now, which this import also proves.
const { checkNodeVersion, requiredNodeMajor } = require(join(HERE, '..', 'scripts', 'postinstall.cjs'));

const packageJson = require(join(HERE, '..', 'package.json'));

describe('postinstall node version gate', () => {
  it('reads the requirement from package.json rather than repeating it', () => {
    const declared = packageJson.engines?.node ?? '';
    const declaredMajor = Number.parseInt(/(\d+)/.exec(declared)[1], 10);

    assert.equal(
      requiredNodeMajor(), declaredMajor,
      'the gate and engines.node must not be able to drift apart'
    );
  });

  it('rejects a Node below the requirement', () => {
    const required = requiredNodeMajor();

    for (const version of ['18.19.1', '20.11.0', 'v16.0.0']) {
      const verdict = checkNodeVersion(version, required);
      assert.equal(verdict.ok, false, `${version} must not pass a >=${required} gate`);
    }
  });

  it('rejects the single-digit version the old string comparison let through', () => {
    // 'v9.0.0' >= 'v18.0.0' is true, because '9' > '1'. A numeric comparison is
    // the whole point of the change.
    const verdict = checkNodeVersion('9.0.0', requiredNodeMajor());

    assert.equal(verdict.ok, false, 'v9 must not pass a >=22 gate');
    assert.equal(verdict.major, 9);
  });

  it('accepts the requirement and anything newer', () => {
    const required = requiredNodeMajor();

    for (const version of [`${required}.0.0`, `v${required}.17.0`, `${required + 2}.1.0`]) {
      const verdict = checkNodeVersion(version, required);
      assert.equal(verdict.ok, true, `${version} must pass a >=${required} gate`);
    }
  });

  it('rejects something it cannot parse instead of assuming it is fine', () => {
    const verdict = checkNodeVersion('garbage', requiredNodeMajor());

    assert.equal(verdict.ok, false, 'an unparseable version is not a passing one');
  });

  it('accepts the Node actually running these tests', () => {
    // If this fails, the suite is running on a Node the package says it does
    // not support -- worth knowing either way.
    assert.equal(checkNodeVersion(process.versions.node, requiredNodeMajor()).ok, true);
  });
});

describe('importing this module must not end the process', () => {
  // Review finding, high. The CI skip sat at module scope, above the
  // `require.main === module` guard, and called process.exit(0). So requiring
  // the file under CI killed whatever was requiring it -- which is every test
  // in this file and in postinstall-env-file. Measured before the fix:
  // `CI=true npm test` reported 152 tests against 165 locally, and exited 0.
  // Thirteen cases silently absent, CI green, nothing proven.

  it('loads with CI set, the way GitHub Actions runs it', () => {
    const scriptPath = join(HERE, '..', 'scripts', 'postinstall.cjs');
    const saved = { ci: process.env.CI, continuous: process.env.CONTINUOUS_INTEGRATION };

    process.env.CI = 'true';
    delete require.cache[require.resolve(scriptPath)];

    try {
      const reloaded = require(scriptPath);

      // Reaching this line is the assertion: before the fix the process was
      // gone by now. The callable check keeps it from passing vacuously.
      assert.equal(typeof reloaded.checkNodeVersion, 'function');
      assert.equal(reloaded.checkNodeVersion(process.versions.node, requiredNodeMajor()).ok, true);
    } finally {
      if (saved.ci === undefined) { delete process.env.CI; } else { process.env.CI = saved.ci; }
      if (saved.continuous === undefined) {
        delete process.env.CONTINUOUS_INTEGRATION;
      } else {
        process.env.CONTINUOUS_INTEGRATION = saved.continuous;
      }
      delete require.cache[require.resolve(scriptPath)];
    }
  });

  it('still skips the setup when npm runs it as a script under CI', () => {
    // The other half: moving the check must not disable it where it belongs.
    // npm runs postinstall as a script, and an unattended CI install should not
    // go through interactive setup.
    const result = spawnSync(process.execPath, [join(HERE, '..', 'scripts', 'postinstall.cjs')], {
      env: { ...process.env, CI: 'true' },
      encoding: 'utf8',
      timeout: 60000,
      windowsHide: true,
    });

    assert.equal(result.status, 0, 'a CI install must not fail');
    assert.match(
      `${result.stdout}${result.stderr}`, /CI environment detected/,
      'and it must say it skipped rather than quietly running the setup'
    );
  });
});

describe('deciding whether this is a CI run', () => {
  // Review finding. `if (process.env.CI)` accepts any non-empty string, so
  // CI=false said yes. Measured before the fix: CI=false, CI=0, CI=no and
  // CI=off all skipped the setup. Somewhere that sets CI=false to declare it is
  // *not* CI got no .env and no MCP registration, and learned that at first
  // use. The earlier test only ever passed 'true'.

  const scriptPath = join(HERE, '..', 'scripts', 'postinstall.cjs');
  const { isCiEnvironment } = require(scriptPath);

  const ENABLED = ['true', 'TRUE', '1', 'yes', 'on', ' true '];
  const DISABLED = ['false', 'FALSE', '0', 'no', 'off', '', '   '];

  it('reads a flag value rather than its presence', () => {
    for (const value of ENABLED) {
      assert.equal(isCiEnvironment({ CI: value }), true, `CI=${JSON.stringify(value)}`);
    }
    for (const value of DISABLED) {
      assert.equal(isCiEnvironment({ CI: value }), false, `CI=${JSON.stringify(value)}`);
    }
    assert.equal(isCiEnvironment({}), false, 'unset');
  });

  it('applies the same reading to CONTINUOUS_INTEGRATION', () => {
    assert.equal(isCiEnvironment({ CONTINUOUS_INTEGRATION: 'true' }), true);
    assert.equal(isCiEnvironment({ CONTINUOUS_INTEGRATION: 'false' }), false);
    // Either one saying yes is enough.
    assert.equal(isCiEnvironment({ CI: 'false', CONTINUOUS_INTEGRATION: '1' }), true);
  });

  it('behaves that way when npm actually runs the script', () => {
    // The unit check above tests the function; this tests the wiring, because
    // the defect was in how the value reached the condition.
    const run = value => spawnSync(process.execPath, [scriptPath], {
      env: { ...process.env, CI: value, CONTINUOUS_INTEGRATION: '' },
      encoding: 'utf8',
      timeout: 120000,
      windowsHide: true,
    });

    const skipped = result => /CI environment detected/.test(`${result.stdout}${result.stderr}`);

    assert.ok(skipped(run('true')), 'a real CI run must still skip');
    assert.ok(!skipped(run('false')), 'CI=false says this is not CI');
    assert.ok(!skipped(run('0')), 'and so does CI=0');
  });
});
