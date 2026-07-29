/**
 * Which environment variables CGMB believes in.
 *
 * Found by installing the published 1.2.0 from the registry and running
 * `cgmb info` against it. Two lists here had drifted a whole migration behind
 * what the code reads:
 *
 *   - the credential check omitted AI_STUDIO_API_KEY, the one variable the
 *     README asks for, while accepting CLAUDE_API_KEY, which nothing in src/
 *     reads at all
 *   - the display list advertised GEMINI_CLI_PATH -- the CLI Google
 *     discontinued -- as a healthy entry
 *
 * The first is not cosmetic. The check decides whether exported variables count
 * as a configured environment when no .env file is found, and the README
 * documents exactly that setup (`export AI_STUDIO_API_KEY=...`).
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, describe, it } from 'node:test';

import { SmartEnvLoader } from '../dist/utils/envLoader.js';

const CREDENTIALS = [
  'AI_STUDIO_API_KEY',
  'GOOGLE_AI_STUDIO_API_KEY',
  'GEMINI_API_KEY',
  'CLAUDE_API_KEY',
];

const saved = Object.fromEntries(CREDENTIALS.map(k => [k, process.env[k]]));

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) { delete process.env[k]; } else { process.env[k] = v; }
  }
});

/** Run the credential check with exactly one variable set. */
function withOnly(name) {
  for (const k of CREDENTIALS) { delete process.env[k]; }
  if (name) { process.env[name] = 'dummy-value'; }
  return SmartEnvLoader.getInstance().checkEnvironmentVariables();
}

describe('deciding whether credentials are present', () => {
  it('accepts the key the README tells people to set', () => {
    // Measured before the fix: false. Anyone following the documented
    // export-only setup was told their environment had not loaded.
    assert.equal(withOnly('AI_STUDIO_API_KEY'), true);
  });

  it('accepts the deprecated fallbacks, since AuthVerifier still resolves them', () => {
    assert.equal(withOnly('GOOGLE_AI_STUDIO_API_KEY'), true);
    assert.equal(withOnly('GEMINI_API_KEY'), true);
  });

  it('does not accept CLAUDE_API_KEY on its own', () => {
    // Nothing reads it -- Claude Code carries its own session auth -- so
    // treating it as proof of configuration reported a ready environment while
    // the AI Studio layer had no credential whatsoever. Measured before the
    // fix: true.
    assert.equal(withOnly('CLAUDE_API_KEY'), false);
  });

  it('reports nothing configured when nothing is set', () => {
    assert.equal(withOnly(null), false);
  });
});

describe('what the status report shows', () => {
  it('names the required key and marks it required', () => {
    const status = SmartEnvLoader.getInstance().getEnvironmentStatus();

    assert.ok(
      'AI_STUDIO_API_KEY' in status.availableVars,
      'the one credential the README asks for must appear'
    );
    assert.deepEqual(status.requiredVars, ['AI_STUDIO_API_KEY']);
  });

  it('no longer advertises the retired Gemini CLI or the unread Claude key', () => {
    const shown = Object.keys(SmartEnvLoader.getInstance().getEnvironmentStatus().availableVars);

    assert.ok(!shown.includes('GEMINI_CLI_PATH'), 'the discontinued CLI must not read as healthy');
    assert.ok(!shown.includes('CLAUDE_API_KEY'), 'a variable nothing reads must not be listed');
  });

  it('covers the settings that actually steer this release', () => {
    const shown = Object.keys(SmartEnvLoader.getInstance().getEnvironmentStatus().availableVars);

    for (const name of ['ANTIGRAVITY_MODEL', 'ANTIGRAVITY_CLI_PATH', 'CLAUDE_CODE_PATH']) {
      assert.ok(shown.includes(name), `${name} decides how a layer runs`);
    }
    assert.ok(
      shown.includes('CGMB_ALLOWED_ROOTS'),
      'the setting that decides which files may be uploaded to Google must be visible'
    );
  });

  it('mentions a deprecated key only when it is actually set', () => {
    for (const k of CREDENTIALS) { delete process.env[k]; }
    assert.deepEqual(
      SmartEnvLoader.getInstance().getEnvironmentStatus().deprecatedVars, [],
      'naming them unprompted invites people to set the wrong one'
    );

    process.env.GEMINI_API_KEY = 'dummy-value';
    const status = SmartEnvLoader.getInstance().getEnvironmentStatus();
    assert.deepEqual(status.deprecatedVars, ['GEMINI_API_KEY']);
    assert.ok('GEMINI_API_KEY' in status.availableVars, 'and then it must be shown');
  });
});

describe('finding a .env from inside a project', () => {
  // Review finding. getDefaultSearchPaths went cwd -> findProjectRoot ->
  // CGMB's own package directory, and findProjectRoot only answers for a
  // package.json that is CGMB itself, so a host project's root was invisible.
  // Measured: with .env at <proj> and cwd at <proj>/subdir, the loader reported
  // its source as CGMB's own installed .env -- a different credential, used
  // silently. Running a CLI from a subdirectory is ordinary; this is the walk
  // that makes the file reachable.

  const scratch = mkdtempSync(join(tmpdir(), 'cgmb-env-search-'));
  after(() => rmSync(scratch, { recursive: true, force: true }));

  const ancestors = start => SmartEnvLoader.getInstance().ancestorsUpToProjectRoot(start);

  /** <root>/a/b, with a marker file at <root>. */
  function projectWith(marker) {
    const root = mkdtempSync(join(scratch, 'proj-'));
    if (marker === 'package.json') {
      writeFileSync(join(root, 'package.json'), '{}', 'utf8');
    } else if (marker === '.git') {
      mkdirSync(join(root, '.git'));
    }
    const deep = join(root, 'a', 'b');
    mkdirSync(deep, { recursive: true });
    return { root, deep };
  }

  it('walks up to a package.json root', () => {
    const { root, deep } = projectWith('package.json');

    const found = ancestors(deep);
    assert.ok(found.includes(root), 'the root holding the .env must be searched');
    assert.equal(found[found.length - 1], root, 'and the walk stops there');
  });

  it('accepts .git as the root marker too', () => {
    // Not every project using the CLI is a Node project.
    const { root, deep } = projectWith('.git');

    assert.ok(ancestors(deep).includes(root));
  });

  it('does not climb past the root into $HOME or /', () => {
    const { root, deep } = projectWith('package.json');

    for (const found of ancestors(deep)) {
      assert.ok(
        found.startsWith(root),
        `${found} is above the project root; a stray .env up there is not this project's`
      );
    }
  });

  it('returns nothing when no project root exists', () => {
    // Nothing establishes where a project would even be, so there is no
    // defensible place to stop -- better to search nothing than everything.
    const orphan = join(mkdtempSync(join(scratch, 'orphan-')), 'x', 'y');
    mkdirSync(orphan, { recursive: true });

    assert.deepEqual(ancestors(orphan), []);
  });

  it('leaves the working directory to the caller', () => {
    const { deep } = projectWith('package.json');

    assert.ok(!ancestors(deep).includes(deep), 'cwd is already search path #1');
  });
});
