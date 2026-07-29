/**
 * WSL behaviour.
 *
 * CGMB runs on Windows, on Linux, and on WSL, which is neither: it is Linux by
 * every check the code makes, but the filesystem it shares with the host is
 * mounted under /mnt and the two sides have different user accounts. That last
 * point produced a real defect -- see the resolveMCPServerPath suite below.
 *
 * Most of this runs on any platform, deliberately. The WSL-specific logic takes
 * injectable inputs so a Windows CI run exercises it too; a check that only
 * fires under WSL protects nobody the rest of the time. The suites that need a
 * real WSL kernel are skipped elsewhere.
 */

import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { describe, it } from 'node:test';

import { AIStudioLayer } from '../dist/layers/AIStudioLayer.js';
import { AGY_INSTALL_HINT, looksLikeAgyBinary } from '../dist/utils/antigravityCli.js';
import { buildSpawnTarget, isUntrustedBinaryLocation } from '../dist/utils/processUtils.js';
import { normalizeCrossPlatformPath, toPlatformPath } from '../dist/utils/platformUtils.js';

const isWsl = Boolean(process.env.WSL_DISTRO_NAME);
const isWindows = process.platform === 'win32';
const SERVER_FILE = 'ai-studio-mcp-server.js';

describe('WSL: locating a Windows-side npm install', () => {
  // The Linux account name and the Windows profile name are unrelated. Building
  // a Windows path out of $USER produced a candidate that could not exist, so
  // this fallback silently never fired.

  it('never builds a candidate from the Linux username', () => {
    const linuxUser = 'scarred';
    const windowsProfiles = ['All Users', 'Default', 'Public', 'hikari', 'desktop.ini'];

    // Compared on forward slashes: join() emits backslashes when this test runs
    // on Windows, and the assertion is about which *profile* was chosen, not
    // about separators.
    const paths = AIStudioLayer.wslWindowsNpmPaths(SERVER_FILE, {
      isWsl: true,
      usersDir: '/mnt/c/Users',
      listUsers: () => windowsProfiles,
    }).map(normalizeCrossPlatformPath);

    assert.ok(paths.length > 0, 'a WSL host with profiles must yield candidates');
    for (const candidate of paths) {
      assert.doesNotMatch(
        candidate, new RegExp(`/Users/${linuxUser}/`),
        `candidate must not be built from the Linux user: ${candidate}`
      );
    }

    assert.ok(
      paths.some(p => p.includes('/Users/hikari/')),
      'the real Windows profile must be among the candidates'
    );
  });

  it('skips the profiles Windows creates for itself', () => {
    const paths = AIStudioLayer.wslWindowsNpmPaths(SERVER_FILE, {
      isWsl: true,
      listUsers: () => ['All Users', 'Default', 'Default User', 'Public', 'desktop.ini'],
    });

    assert.deepEqual(paths, [], 'none of those can hold an npm install');
  });

  it('adds nothing when the directory cannot be read, rather than guessing', () => {
    // The old code always appended one path whether or not it existed, which
    // made the search log misleading.
    const paths = AIStudioLayer.wslWindowsNpmPaths(SERVER_FILE, {
      isWsl: true,
      listUsers: () => { throw new Error('ENOENT'); },
    });

    assert.deepEqual(paths, []);
  });

  it('contributes nothing outside WSL', () => {
    assert.deepEqual(
      AIStudioLayer.wslWindowsNpmPaths(SERVER_FILE, { isWsl: false, listUsers: () => ['x'] }),
      []
    );
  });

  it('covers every real profile on a WSL host', { skip: !isWsl && 'requires WSL' }, () => {
    const paths = AIStudioLayer.wslWindowsNpmPaths(SERVER_FILE).map(normalizeCrossPlatformPath);
    const realProfiles = new Set(readdirSync('/mnt/c/Users'));

    // Note the assertion is *not* "no candidate names $USER". A Windows profile
    // with the same name as the Linux account can genuinely exist -- it does on
    // the machine this was written on -- and would be a legitimate candidate.
    // What went wrong before was assuming that profile is the one holding the
    // install. So: every candidate must come from a directory that is actually
    // there, and every profile that is there must be covered.
    for (const candidate of paths) {
      assert.match(candidate, /^\/mnt\/c\/Users\/[^/]+\/AppData\/Roaming\/npm\//);
      const profile = candidate.split('/')[4];
      assert.ok(realProfiles.has(profile), `${profile} is not a real profile`);
    }

    const covered = new Set(paths.map(p => p.split('/')[4]));
    for (const profile of realProfiles) {
      if (['All Users', 'Default', 'Default User', 'Public', 'desktop.ini'].includes(profile)) {
        continue;
      }
      assert.ok(covered.has(profile), `profile ${profile} was not searched`);
    }
  });
});

describe('WSL: binary resolution', () => {
  it('does not wrap anything in cmd.exe off Windows', { skip: isWindows && 'Windows uses the shim path' }, () => {
    // WSL is Linux to every platform check, so a .cmd shim is not a thing here
    // and buildSpawnTarget must hand the executable straight to spawn.
    const target = buildSpawnTarget(process.execPath, ['--version']);

    assert.equal(target.file, process.execPath, 'the binary must be spawned directly');
    assert.deepEqual(target.args, ['--version']);
    assert.deepEqual(target.spawnOptions, {}, 'no windowsVerbatimArguments off Windows');
  });

  it('recognises a Windows agy reached through WSL interop', () => {
    // With interop enabled, PATH inside WSL can include Windows directories, so
    // `which agy` may answer with a /mnt/c path ending in .exe. The name check
    // has to accept that, or a working install is refused.
    assert.equal(looksLikeAgyBinary('/mnt/c/Users/someone/AppData/Local/agy/bin/agy.exe'), true);
    assert.equal(looksLikeAgyBinary('/mnt/c/tools/agy.EXE'), true);
    assert.equal(looksLikeAgyBinary('/home/user/.local/bin/agy'), true);

    // And still reject the retired CLI, wherever it lives.
    assert.equal(looksLikeAgyBinary('/mnt/c/Users/someone/AppData/Roaming/npm/gemini.cmd'), false);
    assert.equal(looksLikeAgyBinary('/usr/local/bin/gemini'), false);
  });

  it('applies the working-directory check to /mnt paths', () => {
    // The repository is under /mnt/m when this runs in WSL, so the containment
    // check has to work on a mounted path exactly as it does on a native one.
    const inside = `${process.cwd()}/node_modules/.bin/agy`;
    assert.equal(isUntrustedBinaryLocation(inside), true, 'cwd-relative candidates stay refused');

    const outside = isWindows ? 'C:\\Windows\\System32\\where.exe' : '/usr/bin/env';
    assert.equal(isUntrustedBinaryLocation(outside), false, 'system paths stay trusted');
  });
});

describe('WSL: path normalisation across the mount', () => {
  it('round-trips a /mnt path without corrupting it', () => {
    const mounted = '/mnt/m/workMCPtest/claude-gemini-multimodal-bridge/output/report.pdf';

    // normalizeCrossPlatformPath is the JSON/URL form: forward slashes only.
    assert.equal(normalizeCrossPlatformPath(mounted), mounted, 'already forward-slashed');

    // toPlatformPath is the filesystem form. On Linux and WSL that is unchanged;
    // on Windows it converts. Either way it must not lose segments.
    const native = toPlatformPath(mounted);
    assert.equal(
      normalizeCrossPlatformPath(native), mounted,
      'converting to native form and back must be lossless'
    );
  });

  it('leaves a Windows path alone when normalising for JSON', () => {
    assert.equal(
      normalizeCrossPlatformPath('M:\\workMCPtest\\file.txt'),
      'M:/workMCPtest/file.txt'
    );
  });
});

describe('install advice matches the platform', () => {
  // AGY_INSTALL_HINT branches on process.platform, which reports linux under
  // WSL -- so a WSL user must get the shell installer, not `irm ... | iex`.
  // Asserted on both sides rather than only under WSL: a hint that is wrong on
  // Windows is just as useless, and gating this meant only one branch was ever
  // checked.
  it('offers the shell installer off Windows and PowerShell on it', () => {
    if (isWindows) {
      assert.match(AGY_INSTALL_HINT, /irm|iex/, 'Windows must get the PowerShell installer');
      assert.doesNotMatch(AGY_INSTALL_HINT, /curl/);
    } else {
      assert.match(AGY_INSTALL_HINT, /curl/, 'Linux and WSL must get the shell installer');
      assert.doesNotMatch(AGY_INSTALL_HINT, /irm|iex/);
    }
  });

  it('names a real install command either way', () => {
    assert.match(AGY_INSTALL_HINT, /antigravity\.google/, 'the hint must point at the installer');
  });
});
