import { spawn } from 'child_process';
import { isAbsolute as isAbsolutePath, join, relative as relativePath, resolve as resolvePath } from 'path';
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

/**
 * Why an auth probe came back negative. Distinguishing these matters: a network
 * blip must not be presented to the user as "you are signed out".
 */
export type AntigravityAuthOutcome =
  | 'authenticated'
  | 'unauthenticated'
  | 'unavailable'
  | 'timeout'
  | 'not-installed';

export interface AntigravityAuthProbe {
  authenticated: boolean;
  outcome: AntigravityAuthOutcome;
  error?: string;
}

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

interface CommandResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

/**
 * Run a helper command and collect its output.
 *
 * Uses spawn rather than execFile for one non-obvious reason: `agy models`
 * drains stdin to EOF before it writes anything, and execFile always wires
 * stdin to a pipe it never closes, so the probe hung until its own timeout
 * fired (measured: 12s+ vs 3.2s with stdin closed). `agy --version` answers
 * before it touches stdin, which is why binary detection looked healthy while
 * every auth probe timed out. Closing stdin is therefore load-bearing, not
 * hygiene.
 *
 * Also async on purpose: a synchronous child blocks the MCP server's event
 * loop, which additionally prevents the caller's own timeout timer from firing.
 *
 * Rejects only when the process could not be spawned (e.g. ENOENT).
 */
async function runCommand(
  command: string,
  args: string[],
  timeoutMs: number
): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      // Escalate only if the process is genuinely still alive. `child.killed`
      // only means a signal was delivered, so it cannot be used for this.
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
      }, 2000).unref();
    }, timeoutMs);
    timer.unref();

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });

    child.on('error', error => {
      if (settled) { return; }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', code => {
      if (settled) { return; }
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });
  });
}

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
 * Uses an argv array (no shell) so paths containing spaces resolve correctly and
 * shell metacharacters inside an env-var value are never interpreted.
 */
async function probeVersion(candidate: string): Promise<string | undefined> {
  try {
    const result = await runCommand(candidate, ['--version'], 5000);
    if (result.code !== 0) {
      return undefined;
    }
    // An empty first line is not a version; treat it as "not found" so callers
    // do not record a binary they cannot verify.
    const firstLine = result.stdout.trim().split('\n')[0]?.trim() ?? '';
    return firstLine === '' ? undefined : firstLine;
  } catch {
    return undefined;
  }
}

/**
 * True when a discovered path must not be executed.
 *
 * Windows `where` searches the current directory before PATH, and CreateProcess
 * does the same for a bare command name. Verified: with an `agy.cmd` in the
 * working directory, `where agy` returns it ahead of the real installation. A
 * repository containing that file would therefore run its own binary as soon as
 * CGMB was invoked from that directory -- with the full environment, API keys
 * included. Anything at or under the working directory is refused.
 */
export function isUntrustedBinaryLocation(candidate: string): boolean {
  const resolved = resolvePath(candidate);
  const cwd = resolvePath(process.cwd());
  const rel = relativePath(cwd, resolved);
  return rel === '' || (!rel.startsWith('..') && !isAbsolutePath(rel));
}

function candidateInstallPaths(): string[] {
  return process.platform === 'win32'
    ? [
        join(process.env.LOCALAPPDATA ?? '', 'agy', 'bin', 'agy.exe'),
        join(process.env.USERPROFILE ?? '', 'AppData', 'Local', 'agy', 'bin', 'agy.exe'),
        join(process.env.USERPROFILE ?? '', '.local', 'bin', 'agy.exe'),
      ]
    : [
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

    if (isUntrustedBinaryLocation(candidate.value)) {
      logger.warn(
        `${candidate.source} points inside the working directory and was ignored.`,
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

  // 3. Platform path lookup (async: see runCommand)
  try {
    const lookup = await runCommand(isWindows ? 'where' : 'which', ['agy'], 5000);
    const firstPath = lookup.code === 0 ? lookup.stdout.split('\n')[0]?.trim() : undefined;
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
  binaryPath?: string,
  options: { timeoutMs?: number } = {}
): Promise<AntigravityAuthProbe> {
  const resolved = binaryPath ?? (await findAntigravityBinary())?.path;
  if (!resolved) {
    return {
      authenticated: false,
      outcome: 'not-installed',
      error: 'Antigravity CLI (agy) is not installed',
    };
  }

  // `agy models` measures ~3.2s on a warm profile. Keep the budget comfortably
  // above that but below the 10s safeExecute window the callers run under, so a
  // stuck probe surfaces as 'timeout' here rather than aborting the caller.
  const timeout = options.timeoutMs ?? 8000;

  try {
    const result = await runCommand(resolved, ['models'], timeout);

    if (result.timedOut) {
      return {
        authenticated: false,
        outcome: 'timeout',
        error: `\`agy models\` did not respond within ${timeout}ms`,
      };
    }

    if (result.code === 0 && result.stdout.trim()) {
      return { authenticated: true, outcome: 'authenticated' };
    }

    const message = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;

    // A transport failure says nothing about credentials. Reporting it as
    // "unauthenticated" would send users through a pointless sign-in.
    if (/network|ENOTFOUND|ECONNRESET|ECONNREFUSED|EAI_AGAIN|unavailable/i.test(message)) {
      return { authenticated: false, outcome: 'unavailable', error: message };
    }

    // Exit 0 with no models means the CLI ran but could not answer.
    if (result.code === 0) {
      return {
        authenticated: false,
        outcome: 'unavailable',
        error: '`agy models` returned no models',
      };
    }

    return { authenticated: false, outcome: 'unauthenticated', error: message };
  } catch (error) {
    return {
      authenticated: false,
      outcome: 'not-installed',
      error: (error as Error).message,
    };
  }
}

/** Reset the memoised lookup. Intended for tests and post-install re-checks. */
export function resetAntigravityBinaryCache(): void {
  cachedBinary = undefined;
  cachedBinaryResolved = false;
}
