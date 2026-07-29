/**
 * macOS behaviour, checked from any platform.
 *
 * There is no `process.platform === 'darwin'` branch anywhere in this codebase.
 * Every platform decision is "is this Windows", so macOS follows exactly the
 * same path as Linux -- which means the branch coverage is already exercised by
 * a Linux or WSL run. What is genuinely Mac-specific is narrower than it looks:
 * whether the candidate lists name the places macOS actually puts things,
 * chiefly Homebrew's Apple Silicon prefix (/opt/homebrew) and
 * ~/Library/Application Support.
 *
 * Those lists are pure functions of platform and environment, so passing
 * 'darwin' explicitly exercises the Mac path from Windows or WSL. What cannot
 * be reproduced anywhere else -- APFS being case-insensitive, Gatekeeper, .app
 * bundles -- is left to the macOS runner in CI.
 */

import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { describe, it } from 'node:test';

import { candidateInstallPaths } from '../dist/utils/antigravityCli.js';
import { AIStudioLayer } from '../dist/layers/AIStudioLayer.js';
import { ClaudeCodeLayer } from '../dist/layers/ClaudeCodeLayer.js';
import { MCPConfigManager } from '../dist/utils/mcpConfigManager.js';

/** A plausible macOS environment. */
const MAC_ENV = { HOME: '/Users/someone' };
/** A plausible Windows environment. */
const WIN_ENV = {
  APPDATA: 'C:\\Users\\someone\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Users\\someone\\AppData\\Local',
  USERPROFILE: 'C:\\Users\\someone',
};

/** Compare on forward slashes: join() emits backslashes when run on Windows. */
const slashes = paths => paths.map(p => p.replace(/\\/g, '/'));

describe('macOS: locating the Antigravity CLI', () => {
  it('offers the Homebrew prefix and the user-local bin', () => {
    const paths = slashes(candidateInstallPaths('darwin', MAC_ENV));

    assert.ok(
      paths.includes('/opt/homebrew/bin/agy'),
      'Apple Silicon Homebrew installs here; without it agy is invisible on most Macs'
    );
    assert.ok(paths.includes('/usr/local/bin/agy'), 'Intel Macs and Linux use this prefix');
    assert.ok(paths.includes('/Users/someone/.local/bin/agy'), 'the installer default');
  });

  it('keeps Windows locations out of the macOS list', () => {
    const paths = slashes(candidateInstallPaths('darwin', { ...MAC_ENV, ...WIN_ENV }));

    for (const candidate of paths) {
      assert.doesNotMatch(candidate, /AppData|\.exe$/, `${candidate} is a Windows location`);
    }
  });

  it('keeps Homebrew out of the Windows list', () => {
    const paths = slashes(candidateInstallPaths('win32', WIN_ENV));

    for (const candidate of paths) {
      assert.doesNotMatch(candidate, /homebrew/, `${candidate} does not exist on Windows`);
    }
  });
});

describe('macOS: locating Claude Code', () => {
  it('offers both Homebrew and /usr/local, for either binary name', () => {
    const paths = slashes(ClaudeCodeLayer.claudeCandidatePaths('darwin', MAC_ENV));

    for (const expected of [
      '/opt/homebrew/bin/claude',
      '/opt/homebrew/bin/claude-original',
      '/usr/local/bin/claude',
      '/usr/local/bin/claude-original',
    ]) {
      assert.ok(paths.includes(expected), `${expected} must be a candidate`);
    }
  });

  it('still tries the bare name first, which is what PATH resolution needs', () => {
    const paths = ClaudeCodeLayer.claudeCandidatePaths('darwin', MAC_ENV);
    assert.equal(paths[0], 'claude');
  });

  it('adds the npm shim only on Windows', () => {
    const mac = slashes(ClaudeCodeLayer.claudeCandidatePaths('darwin', { ...MAC_ENV, ...WIN_ENV }));
    assert.ok(!mac.some(p => p.endsWith('claude.cmd')), 'a .cmd shim cannot run on macOS');

    const win = slashes(ClaudeCodeLayer.claudeCandidatePaths('win32', WIN_ENV));
    assert.ok(win.some(p => p.endsWith('claude.cmd')), 'Windows npm installs Claude Code as a .cmd');
  });
});

describe('macOS: locating the bundled MCP server', () => {
  const SERVER = 'ai-studio-mcp-server.js';

  it('searches the Homebrew node_modules prefix', () => {
    const paths = slashes(AIStudioLayer.globalInstallPaths(SERVER, 'darwin', MAC_ENV, 'v22.0.0'));

    assert.ok(
      paths.some(p => p.startsWith('/opt/homebrew/lib/node_modules/claude-gemini-multimodal-bridge/')),
      'a Homebrew-installed Node puts global packages here'
    );
    assert.ok(paths.some(p => p.startsWith('/usr/local/lib/node_modules/')));
    assert.ok(
      paths.some(p => p.includes('/Users/someone/.nvm/versions/node/v22.0.0/lib/')),
      'nvm is the common case on developer Macs'
    );
  });

  it('does not offer Windows or WSL locations on macOS', () => {
    const paths = slashes(
      AIStudioLayer.globalInstallPaths(SERVER, 'darwin', { ...MAC_ENV, ...WIN_ENV }, 'v22.0.0')
    );

    for (const candidate of paths) {
      assert.doesNotMatch(candidate, /AppData|Program Files|^\/mnt\/c\//, `${candidate} is not a macOS location`);
    }
  });

  it('every candidate ends at the server file', () => {
    const paths = AIStudioLayer.globalInstallPaths(SERVER, 'darwin', MAC_ENV, 'v22.0.0');
    assert.ok(paths.length > 0);
    for (const candidate of paths) {
      assert.ok(candidate.endsWith(SERVER), `${candidate} does not point at the server`);
    }
  });
});

describe('macOS: Claude Code configuration location', () => {
  it('includes the Application Support path macOS actually uses', () => {
    // A static list, so it is the same on every platform -- but it has to
    // contain the Mac location or `cgmb setup-mcp` cannot find the config
    // there.
    const configPaths = slashes(new MCPConfigManager().CONFIG_PATHS);
    const home = homedir().replace(/\\/g, '/');

    assert.ok(
      configPaths.includes(`${home}/Library/Application Support/Claude Code/mcp_servers.json`),
      'macOS keeps application configuration under ~/Library/Application Support'
    );
  });

  it('still covers the Linux and Windows locations', () => {
    const configPaths = slashes(new MCPConfigManager().CONFIG_PATHS);
    const home = homedir().replace(/\\/g, '/');

    assert.ok(configPaths.includes(`${home}/.config/claude-code/mcp_servers.json`), 'XDG-style');
    assert.ok(configPaths.includes(`${home}/AppData/Roaming/Claude Code/mcp_servers.json`), 'Windows');
  });
});
