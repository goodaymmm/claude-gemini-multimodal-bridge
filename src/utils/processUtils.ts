import { execFileSync, execSync } from 'child_process';
import { realpathSync } from 'fs';
import { isAbsolute, join, relative, resolve } from 'path';

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
 * Every descendant of a pid, deepest last.
 *
 * `pgrep -P` lists direct children; walking it gives the whole tree. One spawn
 * per level, which is fine at shutdown and nowhere near a hot path.
 */
function descendantsOf(pid: number): number[] {
  const found: number[] = [];
  const queue = [pid];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) {
      break;
    }

    let children: number[] = [];
    try {
      children = execFileSync('pgrep', ['-P', String(current)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        .split('\n')
        .map(line => Number(line.trim()))
        .filter(value => Number.isInteger(value) && value > 0);
    } catch {
      // No children, or no pgrep. Either way there is nothing more to walk.
    }

    for (const child of children) {
      if (!found.includes(child)) {
        found.push(child);
        queue.push(child);
      }
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
 * removed. Windows has taskkill /T for this.
 *
 * POSIX is walked rather than signalled by process group. Signalling the group
 * needs the child spawned `detached`, and detaching had a cost that outweighed
 * the convenience: a detached child is outside the terminal's foreground group,
 * so Ctrl-C no longer reaches it and every spawn site becomes responsible for
 * ending its own children through machinery that has to exist and be wired
 * everywhere. Walking the tree needs nothing from the spawn site.
 *
 * Children first, then the parent: killing the parent first can leave a
 * descendant reparented to init and out of reach of the walk.
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
  } else {
    for (const descendant of descendantsOf(child.pid).reverse()) {
      try {
        process.kill(descendant, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  }

  try {
    child.kill('SIGKILL');
  } catch {
    // Already gone.
  }
}
