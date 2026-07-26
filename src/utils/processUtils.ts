import { execFileSync } from 'child_process';

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

/** Quote a single argument for a cmd.exe command line. */
function quoteForCmd(value: string): string {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`;
}

/**
 * Resolve a bare command name to a concrete path on Windows.
 *
 * Needed because a bare name may resolve to a `.cmd` shim, which has to be
 * detected before deciding how to launch it. Returns the input unchanged when
 * it already looks like a path, when resolution fails, or off Windows.
 */
export function resolveWindowsCommand(command: string): string {
  if (!isWindows() || /[\\/]/.test(command) || /\.[a-z]+$/i.test(command)) {
    return command;
  }

  try {
    const output = execFileSync('where', [command], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: 'pipe',
      windowsHide: true,
    });
    const first = output.split('\n')[0]?.trim();
    return first === undefined || first === '' ? command : first;
  } catch {
    return command;
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
