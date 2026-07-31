/**
 * Guards against a suite that disappears instead of failing.
 *
 * postinstall.cjs once called process.exit(0) at module scope when CI was set,
 * above the `require.main === module` guard. Requiring it therefore ended the
 * process that required it -- both test files that import it -- so on GitHub
 * Actions the run reported 152 cases where a local run reported 165 and exited
 * 0. Thirteen cases silently absent, CI green, nothing proven.
 *
 * The guard written for that lived in the file it was guarding, and required
 * the module at the top before setting CI, so a reintroduction would have taken
 * the guard with it. This file exists separately and never imports the module
 * in process: every check here runs in a child, so it survives whatever the
 * child does.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
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
  // summary this file reads. Inheriting it produced empty output and an
  // assertion about a missing count rather than about CI, which is the wrong
  // thing to be told.
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

/** How many cases a file reported, from the TAP-ish summary node --test prints. */
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
  it('runs the cases of the file that once vanished, under CI', () => {
    // Named cases, not counts. Comparing a CI run against a plain one looked
    // like the obvious check and is not: reintroducing the defect degrades both
    // runs to one file-level entry, so the two numbers agree at 1 and the
    // comparison passes. Asking for the case by name cannot be satisfied by a
    // file that never got that far.
    const target = join(HERE, 'postinstall-node-version.test.mjs');
    const known = [
      'accepts the Node actually running these tests',
      'loads with CI set, the way GitHub Actions runs it',
    ];

    const underCi = node(['--test', target], { CI: 'true' });
    const plain = node(['--test', target], { CI: '' });

    for (const name of known) {
      assert.match(underCi.stdout, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        `"${name}" did not run under CI -- the file was cut short before reaching it`);
    }

    assert.ok(caseCount(underCi.stdout) > known.length, 'and the rest of the file must run too');
    assert.equal(caseCount(underCi.stdout), caseCount(plain.stdout), 'CI must not change what runs');
    assert.equal(underCi.status, 0, 'and it must pass');
  });
});

describe('a skipped case must say why', () => {
  it('never skips on a bare condition', () => {
    // A skip with a reason shows up in the report as a sentence someone can
    // act on. A bare boolean disappears with nothing to explain which guarantee
    // just stopped applying on this platform -- and 30 of these sit across the
    // suite, so silence is expensive.
    const offenders = [];

    for (const file of readdirSync(HERE).filter(name => name.endsWith('.test.mjs'))) {
      const lines = readFileSync(join(HERE, file), 'utf8').split('\n');

      lines.forEach((line, index) => {
        const match = line.match(/\bskip:\s*(.+?)\s*[,}]/);
        if (!match) { return; }

        const expression = match[1];
        // A template placeholder is this file describing the pattern, not a
        // case using it.
        if (expression.includes('${')) { return; }

        // node:test prints the reason when skip is a string, and prints nothing
        // when it is true. So the expression has to be able to *produce* a
        // string: `cond && 'why'`, or a helper that returns one.
        //
        // Merely containing a quote is not enough -- `process.platform ===
        // 'win32'` mentions a string and evaluates to a boolean. An earlier
        // version of this check tested for a quote anywhere and passed while
        // two such skips sat in the suite.
        const yieldsReason = /&&\s*['"`]/.test(expression) || /^[\w.]+\(\)$/.test(expression);
        if (!yieldsReason) {
          offenders.push(`${file}:${index + 1}  skip: ${expression}`);
        }
      });
    }

    assert.deepEqual(
      offenders, [],
      `these skips vanish without saying what stopped being checked:\n${offenders.join('\n')}`
    );
  });
});
