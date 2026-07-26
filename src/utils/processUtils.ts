import { execFileSync } from 'child_process';
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
export function resolveWindowsCommand(command: string): string | undefined {
  if (!isWindows() || /[\\/]/.test(command) || /\.[a-z]+$/i.test(command)) {
    return command;
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

/**
 * Decide how to invoke `command` with `args` without using a shell.
 *
 * IMPORTANT: `args` must contain only trusted, static values. See the module
 * comment -- cmd.exe cannot be escaped reliably, so caller-controlled text must
 * travel on stdin, never in argv.
 */
export function buildSpawnTarget(command: string, args: string[]): SpawnTarget {
  if (!isWindows()) {
    return { file: command, args, spawnOptions: {} };
  }

  const resolved = resolveWindowsCommand(command);

  if (resolved === undefined) {
    throw new Error(
      `Could not resolve a trusted "${command}" executable. Candidates inside the working ` +
      `directory are refused, and no other match was found on PATH.`
    );
  }

  // Real executables can be spawned directly; only batch shims need cmd.exe.
  if (!/\.(cmd|bat)$/i.test(resolved)) {
    return { file: resolved, args, spawnOptions: {} };
  }

  const commandLine = [resolved, ...args].map(quoteForCmd).join(' ');

  return {
    file: process.env.ComSpec ?? 'cmd.exe',
    args: ['/d', '/s', '/c', `"${commandLine}"`],
    spawnOptions: { windowsVerbatimArguments: true },
  };
}
