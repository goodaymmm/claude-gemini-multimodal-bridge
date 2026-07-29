import { spawn } from 'child_process';
import { join } from 'path';
import { buildSpawnTarget, isUntrustedBinaryLocation, SpawnTarget } from './processUtils.js';
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
    // Go through buildSpawnTarget rather than spawning the path directly.
    //
    // A raw spawn cannot launch a .cmd or .bat shim on Windows -- it fails with
    // EINVAL, which this function's caller then reports as "agy is not
    // installed". An agy delivered as a batch shim was therefore undetectable,
    // and the diagnosis pointed at the wrong problem. buildSpawnTarget already
    // knows to route those through cmd.exe.
    let target: SpawnTarget;
    try {
      target = buildSpawnTarget(command, args);
    } catch (error) {
      reject(error as Error);
      return;
    }

    const child = spawn(target.file, target.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      ...target.spawnOptions,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const settleTimedOut = (): void => {
      if (settled) { return; }
      settled = true;
      clearTimeout(timer);

      // Let go of the child's pipes and its handle.
      //
      // A grandchild inherits the write ends, so after the shim is killed the
      // orphan keeps them open -- and an open pipe keeps this process's event
      // loop alive. Probing a wedged agy therefore stopped the MCP server from
      // ever exiting. Destroying the streams and unref'ing the child releases
      // the loop; the orphan is already being SIGKILLed above.
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();

      resolve({ stdout, stderr, code: null, timedOut: true });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');

      // Escalate only if the process is genuinely still alive. `child.killed`
      // only means a signal was delivered, so it cannot be used for this.
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }

        // Settle on the timeout rather than waiting for 'close'.
        //
        // 'close' fires when the child's stdio streams close, and a grandchild
        // inherits those pipes. Killing a cmd.exe shim therefore leaves the
        // real process holding them open, and this promise never resolved at
        // all -- the probe hung indefinitely instead of reporting a timeout,
        // which is the exact failure the stdin work was meant to end.
        settleTimedOut();
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
 * Where an installer is likely to have put `agy`.
 *
 * Platform and environment are parameters with defaults rather than reads from
 * the module, so the macOS branch can be exercised from a Windows or Linux
 * test run. There is no darwin branch here -- macOS takes the same path as
 * Linux -- which makes /opt/homebrew the only Mac-specific thing in the list,
 * and the only thing a test on another OS can meaningfully check.
 */
export function candidateInstallPaths(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): string[] {
  return platform === 'win32'
    ? [
        join(env.LOCALAPPDATA ?? '', 'agy', 'bin', 'agy.exe'),
        join(env.USERPROFILE ?? '', 'AppData', 'Local', 'agy', 'bin', 'agy.exe'),
        join(env.USERPROFILE ?? '', '.local', 'bin', 'agy.exe'),
      ]
    : [
        join(env.HOME ?? '', '.local', 'bin', 'agy'),
        '/usr/local/bin/agy',
        // Homebrew's prefix on Apple Silicon. Intel Macs use /usr/local above.
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
    // Absolute path for the lookup helper itself. (A planted where.exe did not
    // take precedence in testing -- Node resolves bare names against PATH, not
    // cwd, with shell:false -- but naming the system copy removes any
    // dependence on that behaviour.)
    const lookupCommand = isWindows
      ? join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'where.exe')
      : '/usr/bin/which';
    const lookup = await runCommand(lookupCommand, ['agy'], 5000);

    // EVERY result is checked before it is executed.
    //
    // This probed result[0] directly. `where agy` lists the current directory
    // first -- measured -- so an agy.exe committed to a repository was run by
    // the version probe, which server dependency verification reaches
    // automatically, with the full environment including API keys.
    //
    // A previous commit claimed this filter was in place. It was not: the
    // edit silently failed to match and I did not verify it.
    const found = lookup.code === 0
      ? lookup.stdout.split('\n').map(line => line.trim()).filter(Boolean)
      : [];

    for (const candidate of found) {
      if (isUntrustedBinaryLocation(candidate)) {
        logger.warn(
          'Ignoring an agy candidate inside the working directory; a binary there is not trusted.',
          { path: candidate }
        );
        continue;
      }

      const version = await probeVersion(candidate);
      if (version) {
        logger.debug('Found Antigravity CLI via path lookup', { path: candidate, version });
        return finish(toBinary(candidate, version));
      }
    }
  } catch {
    logger.debug('Path lookup for agy failed, trying fallback paths');
  }

  // 4. Known installer targets
  for (const candidate of candidateInstallPaths()) {
    // These are absolute paths built from LOCALAPPDATA/HOME, so they are
    // normally nowhere near the working tree -- but the check costs nothing and
    // covers a machine whose cwd happens to sit under one of those roots.
    if (isUntrustedBinaryLocation(candidate)) {
      logger.warn('Ignoring an install-target candidate inside the working directory', {
        path: candidate,
      });
      continue;
    }

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
