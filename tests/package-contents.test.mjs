/**
 * What `npm publish` would ship, checked locally.
 *
 * `files` used to list the whole `.claude` directory. That directory is where
 * Claude Code creates `.claude/worktrees/<agent>/` -- complete checkouts of the
 * repository, `.env` included -- and it is not gitignored, so a publish from a
 * machine that had one would have put the copy and its secrets on npm. Only
 * two files under `.claude` are meant for users, and `files` now names them.
 *
 * CI has an inline check for tests/ and src/; this one runs with the rest of
 * the suite and covers the other things that must, or must not, be published.
 *
 * It packs with --ignore-scripts: `prepack` runs `rimraf dist`, which would
 * delete the build out from under the test files running alongside this one.
 * So it reads the dist/ that `npm run build` left. tsc never deletes outputs,
 * so a dist/ built before a source file or option was removed still holds the
 * old files; if an assertion below names one, `npm run clean && npm run build`
 * first.
 */

import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** @type {string[]} */
let files = [];

describe('npm package contents', () => {
  before(() => {
    // A fixed command line with no caller input; the shell is only there so
    // Windows finds npm.cmd.
    const out = execSync('npm pack --dry-run --json --ignore-scripts', {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const [pkg] = JSON.parse(out);
    files = pkg.files.map((f) => f.path.replace(/\\/g, '/'));
    assert.ok(files.length > 0, 'npm pack listed no files');
  });

  const STALE_HINT = ' (if dist/ was built before this changed, run `npm run clean && npm run build`)';

  it('does not ship tests, sources or Claude Code worktrees', () => {
    const leaked = files.filter(
      (f) => f.startsWith('tests/') || f.startsWith('src/') || f.startsWith('.claude/worktrees/')
    );
    assert.deepEqual(leaked, [], 'these must not be published');
  });

  it('ships nothing under .claude/ beyond its README and settings', () => {
    const claude = files.filter((f) => f.startsWith('.claude/')).sort();
    assert.deepEqual(claude, ['.claude/README.md', '.claude/settings.json']);
  });

  it('does not ship any .env file other than .env.example', () => {
    const envFiles = files.filter((f) => /(^|\/)\.env(\.|$)/.test(f) && f !== '.env.example');
    assert.deepEqual(envFiles, [], 'environment files must not be published');
  });

  it('does not ship declaration maps, whose sources are not published', () => {
    const maps = files.filter((f) => f.endsWith('.d.ts.map'));
    assert.deepEqual(maps, [], 'declaration maps point into src/, which is not in the package' + STALE_HINT);
  });

  it('ships the entry points, the postinstall script, the docs and .env.example', () => {
    const required = [
      'dist/cli.js',
      'dist/index.js',
      'dist/mcp-servers/ai-studio-mcp-server.js',
      '.claude/settings.json',
      '.claude/README.md',
      'scripts/postinstall.cjs',
      'README.md',
      'README_JP.md',
      '.env.example',
    ];
    const missing = required.filter((f) => !files.includes(f));
    assert.deepEqual(missing, [], 'these must be published (dist/ needs `npm run build` first)');
  });
});
