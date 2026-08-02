/**
 * Guards against a suite that disappears instead of failing.
 *
 * postinstall.cjs calls process.exit(0) at module scope when CI is set, above
 * the `require.main === module` guard. Requiring it therefore ends the process
 * that required it -- and a test file that imports it is that process. On
 * GitHub Actions, which sets CI, postinstall-node-version.test.mjs reported one
 * case where a local run reported six, and exited 0. Five cases silently
 * absent, CI green, nothing proven.
 *
 * Every check here runs in a child process and never imports the module in this
 * one, so a reintroduction of the defect cannot take the guard with it.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const POSTINSTALL = join(ROOT, 'scripts', 'postinstall.cjs');

const SENTINEL = 'CGMB_MODULE_SURVIVED_IMPORT';

function node(args, env = {}) {
  // NODE_TEST_CONTEXT is set for us by the runner and tells a child that it is
  // a test worker, which makes it emit the worker protocol instead of the
  // summary this file reads.
  const inherited = { ...process.env };
  delete inherited.NODE_TEST_CONTEXT;

  return spawnSync(process.execPath, args, {
    cwd: ROOT,
    env: { ...inherited, ...env },
    encoding: 'utf8',
    timeout: 180000,
    windowsHide: true,
  });
}

/** How many cases a file reported, from the summary node --test prints. */
function caseCount(output) {
  const line = output.split('\n').find(l => l.startsWith('# tests '));
  assert.ok(line, `no case count in:\n${output.slice(-600)}`);
  return Number(line.slice('# tests '.length).trim());
}

describe('a module must survive being imported under CI', () => {
  it('loads postinstall.cjs with CI set and keeps running', () => {
    // The sentinel is printed *after* the require returns. A module-scope exit
    // means no sentinel, whatever the exit code says.
    const result = node(
      ['-e', `require(${JSON.stringify(POSTINSTALL)}); console.log(${JSON.stringify(SENTINEL)});`],
      { CI: 'true' }
    );

    assert.equal(result.status, 0, `the import must not end the process:\n${result.stderr}`);
    assert.match(
      result.stdout, new RegExp(SENTINEL),
      'the require returned but execution did not continue -- something exited at module scope'
    );
  });

  it('does the same with CONTINUOUS_INTEGRATION', () => {
    const result = node(
      ['-e', `require(${JSON.stringify(POSTINSTALL)}); console.log(${JSON.stringify(SENTINEL)});`],
      { CONTINUOUS_INTEGRATION: 'true' }
    );

    assert.equal(result.status, 0);
    assert.match(result.stdout, new RegExp(SENTINEL));
  });

  it('still skips the setup when run as a script under CI', () => {
    // The skip has to keep working where it belongs, or moving it would have
    // traded one silent failure for another.
    const result = node([POSTINSTALL], { CI: 'true' });

    assert.equal(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /CI environment detected/);
  });
});

describe('the suite must not shrink under CI', () => {
  it('runs the cases of the file that vanishes, under CI', () => {
    // Named cases, not counts. Comparing a CI run against a plain one looks
    // like the obvious check and is not: with the defect present both runs
    // degrade to one file-level entry, so the two numbers agree at 1 and the
    // comparison passes. Asking for a case by name cannot be satisfied by a
    // file that never got that far.
    const target = join(HERE, 'postinstall-node-version.test.mjs');
    const known = ['reads the requirement from package.json rather than repeating it'];

    const underCi = node(['--test', target], { CI: 'true' });
    const plain = node(['--test', target], { CI: '' });

    for (const name of known) {
      assert.match(
        underCi.stdout, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        `"${name}" did not run under CI -- the file was cut short before reaching it`
      );
    }

    assert.ok(caseCount(underCi.stdout) > known.length, 'and the rest of the file must run too');
    assert.equal(caseCount(underCi.stdout), caseCount(plain.stdout), 'CI must not change what runs');
    assert.equal(underCi.status, 0, 'and it must pass');
  });
});
