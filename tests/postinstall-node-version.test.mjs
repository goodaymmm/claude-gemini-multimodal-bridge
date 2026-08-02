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
