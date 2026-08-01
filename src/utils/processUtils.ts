import { execFileSync, execSync } from 'child_process';
import { realpathSync } from 'fs';
import { isAbsolute, join, relative, resolve } from 'path';
import { logger } from './logger.js';

/**
 * Safe, shell-free invocation of external commands on every platform.
 *
 * Windows makes this non-obvious in two ways, and both have already caused
 * production defects in this codebase:
 *
 *   1. `.cmd`/`.bat` files are not executable images. CreateProcess rejects
 *      them, so spawn/execFile without a shell fails with EINVAL. npm installs
 *      its global binaries as `.cmd` shims, so `claude` from `npm install -g`
 *      hits this. An auth probe that used execFileSync directly reported an
 *      installed, signed-in Claude as unauthenticated and disabled the layer.
 *
 *   2. Reaching for `shell: true` to fix (1) is worse. Node then joins argv
 *      into a single cmd.exe command line, so arguments containing spaces are
 *      re-split and arguments containing quotes or `&` can execute commands.
 *      cmd.exe has no backslash-escape concept, so `\"` does not protect
 *      anything.
 *
 * The rule this module encodes: never pass a shell untrusted text. Static flags
 * go through the cmd.exe wrapper below; caller-controlled data (prompts, file
 * contents, MCP input) must be delivered on stdin instead.
 */

export interface SpawnTarget {
  file: string;
  args: string[];
  spawnOptions: { windowsVerbatimArguments?: boolean };
}

const isWindows = (): boolean => process.platform === 'win32';

/**
 * True when a discovered executable must not be run.
 *
 * Windows `where` lists the current directory before PATH -- verified: with an
 * agy.cmd present, `where agy` returns it ahead of the real installation. Any
 * discovery that trusts result[0] therefore executes whatever the working tree
 * contains, inheriting the full environment including API keys. The path is
 * canonicalised first so a symlink or junction cannot point back inside.
 */
export function isUntrustedBinaryLocation(candidate: string): boolean {
  const cwd = realpathOrSelf(resolve(process.cwd()));
  const resolved = realpathOrSelf(resolve(candidate));
  const rel = relative(cwd, resolved);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function realpathOrSelf(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return target;
  }
}

/** Quote a single argument for a cmd.exe command line. */
function quoteForCmd(value: string): string {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`;
}

/** Absolute path to the platform's command-lookup helper. */
function lookupHelper(): string {
  return isWindows()
    ? join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'where.exe')
    : '/usr/bin/which';
}

/**
 * Resolve a bare command name to a concrete, trusted path on Windows.
 *
 * Needed because a bare name may resolve to a `.cmd` shim, which has to be
 * detected before deciding how to launch it.
 *
 * Every candidate is filtered. Returning result[0] unconditionally meant a
 * `claude.cmd` committed to a repository was executed by the auth probe and the
 * version probe -- both of which run during server start-up, before the user
 * asks for anything, and both inheriting the environment.
 */
export function resolveTrustedCommand(command: string): string | undefined {
  // An explicit path is the caller's own decision, but it still must not point
  // into the working tree.
  if (/[\\/]/.test(command)) {
    return isUntrustedBinaryLocation(command) ? undefined : command;
  }

  try {
    const output = execFileSync(lookupHelper(), [command], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: 'pipe',
      windowsHide: true,
    });

    for (const line of output.split('\n')) {
      const candidate = line.trim();
      if (candidate === '' || isUntrustedBinaryLocation(candidate)) {
        continue;
      }
      return candidate;
    }

    // Fail closed.
    //
    // Returning the bare command handed it straight to spawn/execFile, and on a
    // default Windows install the executable search includes the current
    // directory -- so rejecting a planted candidate only to fall back to the
    // bare name would run that very file. (This machine sets
    // NoDefaultCurrentDirectoryInExePath=1, which masks the behaviour locally;
    // most machines do not.) With nothing trustworthy found there is nothing
    // safe to run.
    return undefined;
  } catch {
    return undefined;
  }
}

/** @deprecated Renamed to resolveTrustedCommand; the check now applies on every platform. */
export function resolveWindowsCommand(command: string): string | undefined {
  return resolveTrustedCommand(command);
}

/**
 * Decide how to invoke `command` with `args` without using a shell.
 *
 * IMPORTANT: `args` must contain only trusted, static values. See the module
 * comment -- cmd.exe cannot be escaped reliably, so caller-controlled text must
 * travel on stdin, never in argv.
 */
export function buildSpawnTarget(command: string, args: string[]): SpawnTarget {
  // Resolution and the trust check run on every platform. Returning the command
  // untouched off Windows meant AuthVerifier, CapabilityDetector and
  // ClaudeCodeLayer all handed a bare `claude` to spawn for PATH to resolve --
  // and PATH routinely leads with ./node_modules/.bin, which is inside the
  // repository. Round 14 only closed the Windows half of this.
  const resolved = resolveTrustedCommand(command);

  if (resolved === undefined) {
    throw new Error(
      `Could not resolve a trusted "${command}" executable. Candidates inside the working ` +
      `directory are refused, and no other match was found on PATH.`
    );
  }

  // Only Windows batch shims need cmd.exe; everything else spawns directly.
  if (!isWindows() || !/\.(cmd|bat)$/i.test(resolved)) {
    return { file: resolved, args, spawnOptions: {} };
  }

  const commandLine = [resolved, ...args].map(quoteForCmd).join(' ');

  return {
    file: process.env.ComSpec ?? 'cmd.exe',
    args: ['/d', '/s', '/c', `"${commandLine}"`],
    spawnOptions: { windowsVerbatimArguments: true },
  };
}

/**
 * Run a trusted external command and return its stdout, or undefined.
 *
 * The single entry point every probe should use. Sixteen review rounds found
 * the same defect in eight different places -- a command name interpolated
 * into a shell string, resolved by the shell against PATH or the current
 * directory, bypassing whatever trust check the previous fix had added. Fixing
 * them one at a time did not converge; routing them all through here does.
 *
 * Returns undefined when the command cannot be resolved to a trusted path or
 * exits non-zero, so callers cannot mistake "did not run" for "ran and said
 * nothing".
 */
export function probeCommand(
  command: string,
  args: string[],
  options: { timeoutMs?: number } = {}
): string | undefined {
  try {
    const target = buildSpawnTarget(command, args);
    const output = execFileSync(target.file, target.args, {
      encoding: 'utf8',
      timeout: options.timeoutMs ?? 5000,
      stdio: 'pipe',
      windowsHide: true,
      ...target.spawnOptions,
    });
    return typeof output === 'string' ? output : String(output);
  } catch {
    return undefined;
  }
}

/** True when a command resolves to a trusted executable that runs successfully. */
export function commandAvailable(command: string, args: string[] = ['--version']): boolean {
  return probeCommand(command, args) !== undefined;
}

/**
 * Where `pgrep` is, resolved once and only from a trusted location.
 *
 * `execFileSync('pgrep', ...)` searched PATH. This module exists partly to stop
 * exactly that: a `pgrep` inside the working tree or a node_modules/.bin on
 * PATH -- which npm and npx both arrange -- would have been executed during
 * cancellation and shutdown, inheriting this process's whole environment,
 * API keys included. Resolved through the same check every other command in
 * here goes through, and fail closed when there is nothing trustworthy.
 */
let pgrepPath: string | undefined | null = null;

function trustedPgrep(): string | undefined {
  if (pgrepPath === null) {
    pgrepPath = resolveTrustedCommand('pgrep');
  }
  return pgrepPath;
}

/** For tests: forget the resolved path so a different PATH can be exercised. */
export function resetPgrepResolution(): void {
  pgrepPath = null;
}

/**
 * Direct children of a pid, or undefined if they cannot be determined.
 *
 * The distinction matters: "no children" and "there is no pgrep here" were the
 * same answer, so on a POSIX system without procps every tree kill silently
 * became a single-process kill.
 */
function childrenOf(pid: number, pgrep: string): number[] | undefined {
  try {
    return execFileSync(pgrep, ['-P', String(pid)], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
      // Only what a process lister needs. It has no business with this
      // process's credentials.
      env: { PATH: process.env.PATH ?? '' },
    })
      .split('\n')
      .map(line => Number(line.trim()))
      .filter(value => Number.isInteger(value) && value > 0);
  } catch (error) {
    // Exit status 1 is pgrep's "no matches", which is a real answer. Anything
    // else -- not found, timed out, killed -- is not.
    const status = (error as { status?: number }).status;
    return status === 1 ? [] : undefined;
  }
}

/**
 * Every descendant of a pid, deepest last.
 *
 * Walked repeatedly rather than once. A single snapshot misses anything forked
 * after its parent was scanned, and killing that parent reparents the newcomer
 * out of reach. Re-walking until a pass finds nothing new closes the window
 * that a process which forks while being torn down would otherwise sit in.
 */
function descendantsOf(pid: number, pgrep: string): number[] {
  const found: number[] = [];

  for (let pass = 0; pass < 5; pass += 1) {
    const before = found.length;
    const queue = [pid, ...found];

    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) {
        break;
      }

      for (const child of childrenOf(current, pgrep) ?? []) {
        if (!found.includes(child)) {
          found.push(child);
          queue.push(child);
        }
      }
    }

    if (found.length === before) {
      break; // nothing new appeared; the tree has stopped growing
    }
  }

  return found;
}

/**
 * End a child and anything it started.
 *
 * SIGKILL rather than SIGTERM because the point is to stop paying: a process
 * blocked inside an HTTP call, or one that installed a SIGTERM handler, would
 * otherwise keep going.
 *
 * The tree matters. `child.kill()` signals one process, and both `claude` and
 * `agy` spawn their own helpers -- so killing the one we hold left descendants
 * running and, on Windows, holding files open in a directory about to be
 * removed.
 *
 * Two mechanisms, in order of how much they can be trusted:
 *
 *  1. The process group. Spawning `detached` gives a child a group of its own,
 *     and signalling the negative pid reaches every member at once -- the
 *     kernel's own bookkeeping, with no window for a fork to escape through.
 *     Windows has no groups; `taskkill /T /F` is its equivalent.
 *  2. Walking with `pgrep -P`, for a child that has no group of its own --
 *     spawned elsewhere, or on a platform where detaching did not take. A walk
 *     is a snapshot, so it is repeated until it stops finding anything new, but
 *     it cannot be as airtight as (1). It is the fallback, not the plan.
 *
 * Detaching used to be the whole answer, and its cost is that the child leaves
 * the terminal's foreground process group, so Ctrl-C no longer reaches it
 * directly. That is covered by installShutdownHandlers(), which every entry
 * point now installs: the signal reaches this process, and this process ends
 * the groups it owns.
 */
export function terminateProcessTree(child: { pid?: number | undefined; kill: (signal?: NodeJS.Signals | number) => boolean }): void {
  if (child.pid === undefined) {
    return;
  }

  if (process.platform === 'win32') {
    try {
      execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' });
      return;
    } catch {
      // The process may already be gone; fall through to the signal attempt.
    }
  } else if (!killProcessGroup(child.pid)) {
    walkAndKillDescendants(child.pid);
  }

  try {
    child.kill('SIGKILL');
  } catch {
    // Already gone.
  }
}

/**
 * Signal the child's own process group, if it has one.
 *
 * A negative pid addresses the group whose id is that pid, which exists only
 * for a process spawned `detached` (or one that called setpgid itself). For
 * anything else this fails with ESRCH -- measured -- and the caller falls back
 * to walking.
 */
function killProcessGroup(pid: number): boolean {
  try {
    process.kill(-pid, 'SIGKILL');
    return true;
  } catch {
    return false;
  }
}

/** The fallback: find the descendants ourselves and end them, deepest first. */
function walkAndKillDescendants(pid: number): void {
  const pgrep = trustedPgrep();

  if (pgrep === undefined) {
    // Nothing trustworthy to enumerate with. Say so rather than silently
    // killing one process and reporting success: a caller that believes the
    // tree is gone will not look for what is left.
    logger.warn('Cannot enumerate the process tree: no trusted pgrep found', {
      pid,
      consequence: 'only the process itself will be ended; helpers it started may survive',
    });
    return;
  }

  for (const descendant of descendantsOf(pid, pgrep).reverse()) {
    try {
      process.kill(descendant, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}
