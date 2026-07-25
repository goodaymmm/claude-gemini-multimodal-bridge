import { join } from 'path';
import { logger } from './logger.js';

/**
 * Shared discovery and health probing for the Antigravity CLI (`agy`).
 *
 * Google discontinued Gemini CLI for individual accounts on 2026-06-18; `agy` is
 * the successor. Path resolution, the minimum-version guard and the auth probe
 * all live here so the layer, the capability detector and the auth stack cannot
 * drift apart.
 */

/**
 * Builds before 1.1.7 gate stdout on isatty(): when stdout is not a terminal they
 * print nothing and still exit 0, which turns every CGMB call into a silent
 * wrong-answer. Refuse to use them (upstream antigravity-cli#76).
 */
export const MIN_AGY_VERSION = '1.1.7';

export const AGY_INSTALL_HINT =
  process.platform === 'win32'
    ? 'irm https://antigravity.google/cli/install.ps1 | iex'
    : 'curl -fsSL https://antigravity.google/cli/install.sh | bash';

export interface AntigravityBinary {
  /** Path or bare command used to invoke the CLI. */
  path: string;
  /** Version string reported by `agy --version`, when it could be parsed. */
  version?: string;
  /** False when the binary is older than MIN_AGY_VERSION. */
  versionSupported: boolean;
}

let cachedBinary: AntigravityBinary | undefined;
let cachedBinaryResolved = false;

/** Compare dotted version strings: isVersionAtLeast('1.1.7', '1.1.7') === true */
export function isVersionAtLeast(actual: string, minimum: string): boolean {
  const toParts = (v: string): number[] =>
    v.trim().replace(/^v/i, '').split('.').map(part => Number.parseInt(part, 10) || 0);

  const actualParts = toParts(actual);
  const minimumParts = toParts(minimum);
  const length = Math.max(actualParts.length, minimumParts.length);

  for (let i = 0; i < length; i++) {
    const a = actualParts[i] ?? 0;
    const b = minimumParts[i] ?? 0;
    if (a !== b) {
      return a > b;
    }
  }

  return true;
}

/**
 * True when a path plausibly names the Antigravity CLI rather than some other
 * binary. Used to reject a stale GEMINI_CLI_PATH still pointing at Gemini CLI.
 */
export function looksLikeAgyBinary(candidate: string): boolean {
  const base = candidate.replace(/\\/g, '/').split('/').pop() ?? candidate;
  return /^agy(\.(exe|cmd|bat))?$/i.test(base);
}

/**
 * Run a candidate binary with `--version`.
 *
 * Uses execFileSync with an argv array (no shell) so paths containing spaces
 * resolve correctly and shell metacharacters inside an env-var value are never
 * interpreted.
 */
async function probeVersion(candidate: string): Promise<string | undefined> {
  try {
    const { execFileSync } = await import('child_process');
    const output = execFileSync(candidate, ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output.trim().split('\n')[0]?.trim();
  } catch {
    return undefined;
  }
}

function candidateInstallPaths(): string[] {
  return process.platform === 'win32'
    ? [
        'agy',
        join(process.env.LOCALAPPDATA ?? '', 'agy', 'bin', 'agy.exe'),
        join(process.env.USERPROFILE ?? '', 'AppData', 'Local', 'agy', 'bin', 'agy.exe'),
        join(process.env.USERPROFILE ?? '', '.local', 'bin', 'agy.exe'),
      ]
    : [
        'agy',
        join(process.env.HOME ?? '', '.local', 'bin', 'agy'),
        '/usr/local/bin/agy',
        '/opt/homebrew/bin/agy',
      ];
}

/**
 * Locate the Antigravity CLI.
 *
 * Resolution order:
 *   1. ANTIGRAVITY_CLI_PATH
 *   2. GEMINI_CLI_PATH (deprecated; only honoured when it names `agy`)
 *   3. `where` / `which agy`
 *   4. Known installer targets
 *
 * The result is memoised for the process lifetime; pass `{ refresh: true }` to
 * re-probe after an install.
 */
export async function findAntigravityBinary(
  options: { refresh?: boolean } = {}
): Promise<AntigravityBinary | undefined> {
  if (cachedBinaryResolved && !options.refresh) {
    return cachedBinary;
  }

  const { execSync } = await import('child_process');
  const isWindows = process.platform === 'win32';

  const finish = (binary: AntigravityBinary | undefined): AntigravityBinary | undefined => {
    cachedBinary = binary;
    cachedBinaryResolved = true;
    return binary;
  };

  const toBinary = (path: string, version?: string): AntigravityBinary => ({
    path,
    ...(version === undefined ? {} : { version }),
    versionSupported: version === undefined ? true : isVersionAtLeast(version, MIN_AGY_VERSION),
  });

  // 1 & 2. Environment overrides
  const envCandidates: Array<{ value: string; source: string; legacy: boolean }> = [];
  if (process.env.ANTIGRAVITY_CLI_PATH) {
    envCandidates.push({
      value: process.env.ANTIGRAVITY_CLI_PATH,
      source: 'ANTIGRAVITY_CLI_PATH',
      legacy: false,
    });
  }
  if (process.env.GEMINI_CLI_PATH) {
    envCandidates.push({
      value: process.env.GEMINI_CLI_PATH,
      source: 'GEMINI_CLI_PATH (deprecated)',
      legacy: true,
    });
  }

  for (const candidate of envCandidates) {
    // On upgraded machines GEMINI_CLI_PATH still points at the old Gemini CLI,
    // which answers `--version` happily. Adopting it would either trip the
    // minimum-version guard or invoke the wrong binary, and would short-circuit
    // the search for a real agy on PATH.
    if (candidate.legacy && !looksLikeAgyBinary(candidate.value)) {
      logger.warn(
        'GEMINI_CLI_PATH does not point at the Antigravity CLI and was ignored. ' +
        'Set ANTIGRAVITY_CLI_PATH to the `agy` executable instead.',
        { path: candidate.value }
      );
      continue;
    }

    const version = await probeVersion(candidate.value);
    if (version) {
      if (candidate.legacy) {
        logger.warn('GEMINI_CLI_PATH is deprecated. Set ANTIGRAVITY_CLI_PATH instead.');
      }
      logger.debug('Found Antigravity CLI from environment variable', {
        path: candidate.value,
        source: candidate.source,
        version,
      });
      return finish(toBinary(candidate.value, version));
    }

    logger.debug('Environment variable set but command failed', {
      path: candidate.value,
      source: candidate.source,
    });
  }

  // 3. Platform path lookup
  try {
    const lookup = isWindows ? 'where agy 2>nul' : 'which agy 2>/dev/null';
    const result = execSync(lookup, { encoding: 'utf8', timeout: 5000 });
    const firstPath = result.split('\n')[0]?.trim();
    if (firstPath) {
      const version = await probeVersion(firstPath);
      if (version) {
        logger.debug('Found Antigravity CLI via path lookup', { path: firstPath, version });
        return finish(toBinary(firstPath, version));
      }
    }
  } catch {
    logger.debug('Path lookup for agy failed, trying fallback paths');
  }

  // 4. Known installer targets
  for (const candidate of candidateInstallPaths()) {
    const version = await probeVersion(candidate);
    if (version) {
      logger.debug('Found Antigravity CLI at', { path: candidate, version });
      return finish(toBinary(candidate, version));
    }
  }

  logger.warn('Antigravity CLI (agy) not found in any known location', {
    platform: process.platform,
    install: AGY_INSTALL_HINT,
    docs: 'https://antigravity.google/docs/cli/install',
  });

  return finish(undefined);
}

/**
 * Probe Antigravity authentication.
 *
 * `agy` keeps its OAuth tokens in the OS keyring (Windows Credential Manager,
 * Apple Keychain, Linux Secret Service), so there is no credential file to read
 * and no `agy auth` subcommand to call. `agy models` round-trips to the server
 * and therefore succeeds only when the session is authenticated, which makes it
 * the cheapest reliable probe.
 */
export async function probeAntigravityAuth(
  binaryPath?: string
): Promise<{ authenticated: boolean; error?: string }> {
  const resolved = binaryPath ?? (await findAntigravityBinary())?.path;
  if (!resolved) {
    return { authenticated: false, error: 'Antigravity CLI (agy) is not installed' };
  }

  try {
    const { execFileSync } = await import('child_process');
    const output = execFileSync(resolved, ['models'], {
      encoding: 'utf8',
      timeout: 15000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (output.trim()) {
      return { authenticated: true };
    }

    return { authenticated: false, error: '`agy models` returned no models' };
  } catch (error) {
    return {
      authenticated: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Reset the memoised lookup. Intended for tests and post-install re-checks. */
export function resetAntigravityBinaryCache(): void {
  cachedBinary = undefined;
  cachedBinaryResolved = false;
}
