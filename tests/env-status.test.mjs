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
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { after, afterEach, describe, it } from 'node:test';

import { SmartEnvLoader } from '../dist/utils/envLoader.js';

const loaderUrl = new URL('../dist/utils/envLoader.js', import.meta.url).href;

/** Why the bind-mount case cannot run here, or false when it can. */
function bindMountSkipReason() {
  if (process.platform !== 'linux') {
    return 'bind mounts need Linux; nothing here is verified on this platform';
  }
  const probe = spawnSync('unshare', ['--map-root-user', '--mount', '--', 'true'], {
    encoding: 'utf8',
    timeout: 30000,
  });
  return probe.status === 0 ? false : 'unprivileged user namespaces are unavailable';
}

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

  // Home is passed explicitly almost everywhere below. The real one varies by
  // machine and, on Windows, contains tmpdir -- so leaving it implicit would
  // make these cases mean different things on different platforms.
  const ancestors = (start, home = join(scratch, 'no-such-home')) =>
    SmartEnvLoader.getInstance().ancestorsUpToProjectRoot(start, home);

  function marker(dir, kind) {
    if (kind === 'package.json') {
      writeFileSync(join(dir, 'package.json'), '{}', 'utf8');
    } else if (kind === '.git') {
      mkdirSync(join(dir, '.git'));
    }
  }

  /** <root>/a/b, with a marker at <root>. */
  function projectWith(kind) {
    const root = mkdtempSync(join(scratch, 'proj-'));
    marker(root, kind);
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

describe('the home directory is a ceiling on that walk', () => {
  // Review finding, high. Stopping at "the first package.json or .git" is not
  // enough when that marker is the home directory itself -- ~/.git is an
  // ordinary dotfiles setup. Measured before the fix, with .git at a stand-in
  // home: a run from <home>/scratch/subdir returned ["<home>/scratch",
  // "<home>"] and the loader read <home>/.env. That crosses a credential
  // boundary; another project's AI_STUDIO_API_KEY gets billed silently and its
  // CGMB_ALLOWED_ROOTS widens what may be uploaded to Google.
  //
  // The earlier tests could not have caught it: every fixture put its marker
  // below the home directory, so the ceiling was never reached.

  const scratch = mkdtempSync(join(tmpdir(), 'cgmb-home-ceiling-'));
  after(() => rmSync(scratch, { recursive: true, force: true }));

  const ancestors = (start, home) =>
    SmartEnvLoader.getInstance().ancestorsUpToProjectRoot(start, home);

  function homeWithMarker(kind) {
    const home = mkdtempSync(join(scratch, 'home-'));
    if (kind === 'package.json') {
      writeFileSync(join(home, 'package.json'), '{}', 'utf8');
    } else {
      mkdirSync(join(home, '.git'));
    }
    const deep = join(home, 'scratch', 'subdir');
    mkdirSync(deep, { recursive: true });
    return { home, deep };
  }

  it('refuses the home directory even when it carries a marker', () => {
    for (const kind of ['.git', 'package.json']) {
      const { home, deep } = homeWithMarker(kind);

      assert.deepEqual(
        ancestors(deep, home), [],
        `~/${kind} must not turn the home directory into a project root`
      );
    }
  });

  it('stops at home rather than continuing above it', () => {
    // The marker is above home, so without a ceiling the walk would sail past
    // and offer directories belonging to no project of the user's.
    const above = mkdtempSync(join(scratch, 'above-'));
    mkdirSync(join(above, '.git'));
    const home = join(above, 'home');
    const deep = join(home, 'a', 'b');
    mkdirSync(deep, { recursive: true });

    assert.deepEqual(ancestors(deep, home), []);
  });

  it('still finds a project that lives below home', () => {
    // The ceiling must not cost us the case the walk exists for.
    const { home } = homeWithMarker('.git');
    const project = join(home, 'work', 'app');
    const deep = join(project, 'src', 'lib');
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(project, 'package.json'), '{}', 'utf8');

    const found = ancestors(deep, home);
    assert.ok(found.includes(project), 'the project root is what this walk is for');
    assert.ok(!found.includes(home), 'and home is still not on the list');
  });

  it('returns nothing when the working directory is home itself', () => {
    const { home } = homeWithMarker('.git');

    assert.deepEqual(ancestors(home, home), []);
  });

  it('recognises home through a symlink', {
    skip: process.platform === 'win32'
      && 'POSIX symlinks; the ceiling is unverified against links on this platform',
  }, () => {
    // Home is frequently a link -- /home/x -> /mnt/data/x and the like. Compare
    // the resolved paths or the ceiling is trivially side-stepped.
    const { home, deep } = homeWithMarker('.git');
    const linked = join(scratch, `link-${Math.abs(home.length)}-${basename(home)}`);
    symlinkSync(home, linked, 'dir');

    assert.deepEqual(ancestors(deep, linked), [], 'the link names the same directory');
  });

  it('ignores case on Windows', {
    skip: process.platform !== 'win32'
      && 'case-insensitive paths are a Windows property; nothing here checks them elsewhere',
  }, () => {
    // C:\Users\x and c:\users\x are one directory; a case difference must not
    // let the walk step onto home.
    const { home, deep } = homeWithMarker('.git');

    assert.deepEqual(ancestors(deep, home.toUpperCase()), []);
    assert.deepEqual(ancestors(deep, home.toLowerCase()), []);
  });

  it('defaults to the real home directory', () => {
    // The parameter exists for these tests; the default is what ships.
    const real = homedir();
    const deep = join(real, 'a', 'b', 'c');

    assert.ok(
      !SmartEnvLoader.getInstance().ancestorsUpToProjectRoot(deep).includes(real),
      'called with no home argument, it must still refuse the real one'
    );
  });
});

describe('the ceiling holds against aliases and a broken home', () => {
  // Two review findings on the same boundary.
  //
  // Comparing canonical paths collapsed symlinks but not bind mounts:
  // reproduced in a user namespace, entering through /mnt/u for a home at
  // /home/u left the ceiling unmatched, so the alias became a project root and
  // its .env -- the home one -- was read.
  //
  // And homedir() as a default parameter ran before the body with its result
  // unchecked. With HOME='' it returns '', resolve('') is the working
  // directory, and the walk stopped before it began: measured [] where a real
  // project root one level up should have been found.

  const scratch = mkdtempSync(join(tmpdir(), 'cgmb-ceiling-'));
  after(() => rmSync(scratch, { recursive: true, force: true }));

  const loader = () => SmartEnvLoader.getInstance();

  /** <root>/proj/sub, with package.json at <root>/proj. */
  function projectTree() {
    const root = mkdtempSync(join(scratch, 'tree-'));
    const project = join(root, 'proj');
    const deep = join(project, 'sub');
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(project, 'package.json'), '{}', 'utf8');
    return { root, project, deep };
  }

  it('recognises the same directory reached by two names', () => {
    const dir = mkdtempSync(join(scratch, 'same-'));
    const other = mkdtempSync(join(scratch, 'other-'));

    assert.equal(SmartEnvLoader.sameDirectory(dir, dir), true);
    assert.equal(SmartEnvLoader.sameDirectory(dir, other), false, 'two real directories are not one');
    assert.equal(
      SmartEnvLoader.sameDirectory(dir, join(scratch, 'not-on-disk')), false,
      'a path with nothing behind it cannot be the home directory'
    );
  });

  it('sees through a bind mount', { skip: bindMountSkipReason() }, () => {
    // The case canonical paths cannot answer. Only reachable where an
    // unprivileged user namespace can mount -- Linux. Skipped elsewhere, which
    // means a green run on Windows or macOS says nothing about this.
    const home = mkdtempSync(join(scratch, 'bind-home-'));
    const alias = mkdtempSync(join(scratch, 'bind-alias-'));
    mkdirSync(join(home, '.git'));
    mkdirSync(join(home, 'scratch', 'subdir'), { recursive: true });

    const mounted = spawnSync('unshare', [
      '--map-root-user', '--mount', '--',
      'bash', '-c',
      `mount --bind ${JSON.stringify(home)} ${JSON.stringify(alias)} && ` +
      `node --input-type=module -e ${JSON.stringify(
        `import { SmartEnvLoader } from ${JSON.stringify(loaderUrl)};` +
        `console.log(JSON.stringify(SmartEnvLoader.getInstance()` +
        `.ancestorsUpToProjectRoot(${JSON.stringify(join(alias, 'scratch', 'subdir'))}, ${JSON.stringify(home)})));`
      )}`,
    ], { encoding: 'utf8', timeout: 120000 });

    assert.equal(mounted.status, 0, `the mount must have worked:\n${mounted.stderr}`);
    assert.deepEqual(
      JSON.parse(mounted.stdout.trim().split('\n').pop()), [],
      'the alias names the home directory, so the walk must stop there too'
    );
  });

  it('falls back when the home value is unusable', () => {
    // Each of these resolves against the working directory if taken at face
    // value, which is how the ceiling became cwd.
    const { project, deep } = projectTree();

    for (const home of ['', '   ', '../somewhere', 'relative/path']) {
      assert.deepEqual(
        loader().ancestorsUpToProjectRoot(deep, home), [project],
        `home=${JSON.stringify(home)} must fall through, not become the ceiling`
      );
    }
  });

  it('walks nothing rather than throwing when no home can be found', () => {
    // A container running as an arbitrary UID with no passwd entry: homedir()
    // throws. That used to happen in a default parameter, taking down the whole
    // environment load before it could look at variables already set.
    const { deep } = projectTree();
    const saved = { home: process.env.HOME, profile: process.env.USERPROFILE };
    delete process.env.HOME;
    delete process.env.USERPROFILE;

    try {
      const found = loader().ancestorsUpToProjectRoot(deep, '');
      assert.ok(Array.isArray(found), 'it must return a list, not throw');
    } finally {
      if (saved.home === undefined) { delete process.env.HOME; } else { process.env.HOME = saved.home; }
      if (saved.profile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = saved.profile;
      }
    }
  });

  it('still stops at a home it can resolve', () => {
    const home = mkdtempSync(join(scratch, 'ok-home-'));
    mkdirSync(join(home, '.git'));
    const deep = join(home, 'a', 'b');
    mkdirSync(deep, { recursive: true });

    assert.deepEqual(loader().ancestorsUpToProjectRoot(deep, home), []);
  });
});

describe('every home the process has, and what happens with none', () => {
  // Three review findings, all on the same boundary, all in conditions the
  // previous tests did not enter.
  //
  // Taking the first usable home meant HOME=/root under sudo or a service
  // manager hid the effective user's own home: measured, a walk from
  // /home/u/proj/sub returned ["/home/u/proj", "/home/u"].
  //
  // And "no home could be resolved" returned an empty ancestor list while
  // getDefaultSearchPaths carried on into CGMB's own package directory and the
  // global prefix -- so the host project's .env was excluded and an unrelated
  // installed one was read. The test I wrote for that branch never entered it:
  // os.userInfo() still answers after HOME is unset, and the assertion was only
  // that an array came back. These reach the branch and say so.

  const scratch = mkdtempSync(join(tmpdir(), 'cgmb-homes-'));
  after(() => rmSync(scratch, { recursive: true, force: true }));

  const loader = () => SmartEnvLoader.getInstance();
  const failing = () => { throw new Error('no passwd entry for this uid'); };

  it('keeps both the environment home and the effective user home', () => {
    const fromEnv = mkdtempSync(join(scratch, 'env-home-'));
    const fromUid = mkdtempSync(join(scratch, 'uid-home-'));

    const homes = loader().homeDirectories(undefined, [() => fromEnv, () => fromUid]);

    assert.deepEqual(homes, [fromEnv, fromUid], 'HOME and the real home are separate facts');
  });

  it('stops at the effective user home even when HOME points elsewhere', () => {
    // The measured failure. Both directories exist, so neither is discarded for
    // being absent -- the old code simply stopped looking after the first.
    const stale = mkdtempSync(join(scratch, 'stale-'));
    const real = mkdtempSync(join(scratch, 'real-'));
    const deep = join(real, 'proj', 'sub');
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(real, 'proj', 'package.json'), '{}', 'utf8');
    mkdirSync(join(real, '.git'));

    const ceilings = loader().homeDirectories(undefined, [() => stale, () => real]);
    assert.ok(ceilings.includes(real), 'the real home must be among the ceilings');

    // And the project below it is still reachable -- the ceiling must not cost
    // us the case the walk exists for.
    assert.deepEqual(loader().ancestorsUpToProjectRoot(deep, stale), [join(real, 'proj')]);
  });

  it('drops blank and relative candidates without dropping the rest', () => {
    const real = mkdtempSync(join(scratch, 'usable-'));

    assert.deepEqual(
      loader().homeDirectories('', [() => '   ', () => '../relative', () => real]),
      [real],
      'each of those would resolve against the working directory'
    );
  });

  it('reports no home at all when every source fails', () => {
    // The branch the earlier test claimed to cover and did not.
    assert.deepEqual(
      loader().homeDirectories(undefined, [failing, () => undefined, () => '']), []
    );
  });

  it('searches only the working directory when there is no home', async () => {
    // What the empty list must actually cause. Before this, the walk was
    // skipped but the search went on into CGMB's own install -- excluding the
    // user's project while reading a stranger's credential.
    const instance = loader();
    const realHomes = instance.homeDirectories;
    instance.homeDirectories = () => [];

    try {
      const paths = await instance.getDefaultSearchPaths();

      assert.deepEqual(
        paths, [process.cwd()],
        'no package directory, no global prefix, no ~/.cgmb -- only where we were pointed'
      );
    } finally {
      instance.homeDirectories = realHomes;
    }
  });

  it('still searches beyond the working directory when a home is known', async () => {
    // The other half: the restriction must be the exception, not the rule.
    const instance = loader();
    const paths = await instance.getDefaultSearchPaths();

    assert.ok(paths.length > 1, 'a normal environment must keep its wider search');
    assert.equal(paths[0], process.cwd());
  });
});

describe('filesystem identity is compared exactly', () => {
  it('does not confuse inodes that differ beyond 2^53', () => {
    // statSync without the bigint option hands these back as JavaScript
    // numbers. Measured on this machine: inodes around 6.2e15 against a safe
    // integer ceiling of 9.0e15, so a filesystem numbering them higher would
    // round two distinct inodes together -- declaring an ordinary ancestor to
    // be the home directory and dropping the project root from the search.
    const dev = 2n ** 40n;

    assert.equal(
      SmartEnvLoader.sameFileIdentity({ dev, ino: 2n ** 53n }, { dev, ino: 2n ** 53n + 1n }),
      false,
      'these are two inodes, and as JavaScript numbers they are one'
    );
    assert.equal(Number(2n ** 53n) === Number(2n ** 53n + 1n), true, 'which is the trap');
  });

  it('separates a difference in device from a difference in inode', () => {
    assert.equal(SmartEnvLoader.sameFileIdentity({ dev: 1n, ino: 9n }, { dev: 2n, ino: 9n }), false);
    assert.equal(SmartEnvLoader.sameFileIdentity({ dev: 1n, ino: 9n }, { dev: 1n, ino: 8n }), false);
    assert.equal(SmartEnvLoader.sameFileIdentity({ dev: 1n, ino: 9n }, { dev: 1n, ino: 9n }), true);
  });
});
