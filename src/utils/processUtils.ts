import { execFileSync } from 'child_process';
import { accessSync, constants, readdirSync, readFileSync, realpathSync, statSync } from 'fs';
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
  // Two questions, asked of two different paths.
  //
  // 1. Is the *entry on PATH* inside a project's node_modules? That is what npm
  //    and npx put there, and a shim committed to a repository is what must not
  //    be run. This is asked of the path as given, before any symlink is
  //    followed.
  //
  //    Asking it after realpath was a serious mistake: `npm install -g
  //    @anthropic-ai/claude-code` puts /usr/local/bin/claude -- a symlink into
  //    /usr/local/lib/node_modules/... -- so resolving first made the ordinary
  //    global install look like a project shim and refused it. Measured: the
  //    exact npm layout came back rejected, which would have disabled the
  //    Claude layer on every POSIX machine that installed it the documented
  //    way.
  //
  // 2. Does it *end up* inside the working directory? That one needs the real
  //    path, or a symlink in the tree pointing at itself would slip through.
  const segments = pathSegments(candidate);
  if (segments.includes('node_modules')) {
    return true;
  }

  const cwd = realpathOrSelf(resolve(process.cwd()));
  const resolved = realpathOrSelf(resolve(candidate));
  const rel = relative(cwd, resolved);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * A path split into its parts, comparably.
 *
 * No regex: inside a character class a backslash escapes the next character, so
 * `[<backslash>/]` is a class containing only `/` -- which meant Windows paths
 * were never split at all and this check passed everything.
 *
 * Lower-cased where the filesystem is: Windows resolves paths without regard to
 * case, so a directory actually named NODE_MODULES would otherwise walk past a
 * case-sensitive comparison.
 */
function pathSegments(target: string): string[] {
  const parts = target.split(String.fromCharCode(92)).join('/').split('/');
  return isWindows() ? parts.map(part => part.toLowerCase()) : parts;
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

/**
 * The Windows system directory, or undefined if SystemRoot is not a shape we
 * are willing to execute out of.
 *
 * SystemRoot is an ordinary environment variable. Building an executable path
 * from it unchecked moves the trust boundary rather than closing it: a relative
 * path, a UNC share, a device path or an 8.3 short name all point somewhere
 * else, and whatever sits at System32\<tool>.exe under it runs with this
 * process's privileges. `SystemRoot='.'` was enough to have where.exe taken
 * from the working directory -- before any candidate had been trust-checked,
 * since where.exe is what does the checking.
 *
 * Checked with character comparisons rather than a regex, because a backslash
 * in one did not survive being written: an earlier version compiled to a class
 * matching only forward slashes, rejected `C:` + separator + `Windows`, and so
 * silently removed the Windows tree kill entirely. Three suites failed, which
 * is the only reason it was noticed.
 */
/**
 * Where Windows keeps its system tools. Fixed, because the environment
 * variable that used to name it is attacker-controllable.
 */
const WINDOWS_SYSTEM_DIRECTORIES = [
  'C:' + String.fromCharCode(92) + 'Windows' + String.fromCharCode(92) + 'System32',
  'C:/Windows/System32',
];

function windowsSystemDirectory(): string | undefined {
  // SystemRoot is not consulted.
  //
  // Two versions tried to validate it and neither could. Checking that it was
  // drive-absolute let C:\Users\attacker\payload through; requiring
  // it to be `<drive>:\Windows` still lets an attacker who can write to any
  // drive create D:\Windows\System32\where.exe, or point a junction
  // there, and set the variable. The value is attacker-controllable in every
  // scenario the check exists for, so no amount of parsing makes it a trust
  // anchor -- and where.exe runs *before* any candidate has been checked,
  // because where.exe is what does the checking.
  //
  // Node exposes no GetSystemDirectoryW, so the alternative is the same one
  // already used for pgrep: a fixed list of the places the tool actually lives,
  // and fail closed when it is at none of them. Windows has been installed at
  // %SystemDrive%\Windows for its entire history, and a machine where that
  // is untrue loses the tree kill rather than gaining an execution hole.
  for (const candidate of WINDOWS_SYSTEM_DIRECTORIES) {
    try {
      if (statSync(candidate).isDirectory()) {
        return candidate;
      }
    } catch {
      // Not here; try the next.
    }
  }

  logger.warn('No Windows system directory found; taskkill and where will not be used', {
    looked: WINDOWS_SYSTEM_DIRECTORIES,
  });
  return undefined;
}

/** A Windows system tool, by absolute path, or undefined if none is trustworthy. */
function windowsSystemTool(name: string): string | undefined {
  const directory = windowsSystemDirectory();
  if (directory === undefined) {
    return undefined;
  }

  const candidate = join(directory, name);
  try {
    return statSync(candidate).isFile() ? candidate : undefined;
  } catch {
    return undefined;
  }
}

/** Absolute path to the platform's command-lookup helper. */
function lookupHelper(): string | undefined {
  return isWindows() ? windowsSystemTool('where.exe') : '/usr/bin/which';
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

  const helper = lookupHelper();
  if (helper === undefined) {
    // No trustworthy way to look anything up, so nothing is trustworthy.
    return undefined;
  }

  try {
    const output = execFileSync(helper, [command], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: 'pipe',
      windowsHide: true,
      // The environment is *not* stripped here, unlike for taskkill: `where`
      // and `which` search PATH, so taking it away does not harden the lookup,
      // it stops it working -- and with it the discovery of claude and agy.
      // What makes this safe is that the helper itself is now an absolute path
      // from a validated system directory, and every candidate it returns is
      // still filtered by isUntrustedBinaryLocation below.
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
 * Windows' own taskkill, by absolute path.
 *
 * Every call was `execSync('taskkill /pid ...')`, which runs through cmd.exe --
 * and cmd.exe searches the current directory before PATH. A `taskkill.cmd` in a
 * checkout would therefore have been executed on every timeout, cancellation
 * and shutdown, at this process's privileges and with its whole environment.
 * The same trust boundary that was closed for pgrep, left open here.
 *
 * Also no shell: the pid goes in an argument array, so there is nothing to
 * quote and nothing for cmd.exe to reinterpret.
 */
/** The taskkill this process will use, or undefined if none is trustworthy. */
export function resolveSystemTaskkill(): string | undefined {
  return systemTaskkill();
}

function systemTaskkill(): string | undefined {
  return windowsSystemTool('taskkill.exe');
}

/**
 * End a Windows process and everything it started. Returns false if taskkill
 * could not do it, so the caller can fall back to the signal it has.
 */
export function windowsTerminateTree(pid: number | undefined): boolean {
  if (pid === undefined) {
    return false;
  }

  const taskkill = systemTaskkill();
  if (taskkill === undefined) {
    return false;
  }

  try {
    execFileSync(taskkill, ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      timeout: 10000,
      windowsHide: true,
      // A process-ending tool needs none of this process's environment.
      env: { SystemRoot: process.env.SystemRoot ?? '' },
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Where `pgrep` is -- from a fixed list of system locations, never from PATH.
 *
 * Two earlier versions were wrong. The first let PATH decide, which npm and npx
 * populate with node_modules/.bin. The second used resolveTrustedCommand, whose
 * rule is "not inside the current working directory" -- so running from a
 * subdirectory made the repository's own node_modules/.bin an *ancestor*, and
 * therefore trusted. Both would have run a `pgrep` committed to a checkout,
 * during cancellation and shutdown, at this process's privileges.
 *
 * There is no general rule that makes PATH safe here, so PATH is not consulted.
 * Each candidate must be executable, and a candidate that is not is skipped
 * rather than cached -- otherwise a stray non-executable file at the first path
 * would have masked the real tool further down.
 *
 * On Linux none of this is reached: /proc answers the same question with no
 * external process at all. This is for the POSIX systems without it.
 */
const SYSTEM_PGREP_PATHS = [
  '/usr/bin/pgrep',
  '/bin/pgrep',
  '/usr/local/bin/pgrep',
  '/sbin/pgrep',
  '/usr/sbin/pgrep',
];

let pgrepPath: string | undefined | null = null;

function trustedPgrep(): string | undefined {
  if (pgrepPath === null) {
    pgrepPath = SYSTEM_PGREP_PATHS.find(candidate => {
      try {
        if (!statSync(candidate).isFile()) {
          return false;
        }
        accessSync(candidate, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  }
  return pgrepPath;
}

/** The resolved system pgrep, if there is one. */
export function resolveSystemPgrep(): string | undefined {
  return trustedPgrep();
}

/** For tests: forget the resolved path. */
export function resetPgrepResolution(): void {
  pgrepPath = null;
}

/**
 * Direct children of a pid, read from /proc.
 *
 * No external process, so no command to resolve and no trust boundary to get
 * wrong -- which is the whole of the pgrep problem, avoided rather than
 * defended. Linux and WSL both have it; anything else falls through to pgrep.
 *
 * PPid comes from `status` rather than `stat`, whose second field is the
 * command name in parentheses and may itself contain spaces and parentheses.
 */
function childrenViaProc(pid: number): number[] | undefined {
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    return undefined; // no /proc here
  }

  const children: number[] = [];

  for (const entry of entries) {
    const candidate = Number(entry);
    if (!Number.isInteger(candidate) || candidate <= 0) {
      continue;
    }

    try {
      const status = readFileSync(`/proc/${candidate}/status`, 'utf8');
      const match = status.match(/^PPid:\s+([0-9]+)/m);
      if (match && Number(match[1]) === pid) {
        children.push(candidate);
      }
    } catch {
      // The process ended between the listing and the read. Not a child of
      // ours as far as anything we can still act on is concerned.
    }
  }

  return children;
}

/**
 * Direct children of a pid, or undefined if they cannot be determined.
 *
 * The distinction matters: "no children" and "there is no pgrep here" were the
 * same answer, so on a POSIX system without procps every tree kill silently
 * became a single-process kill.
 */
function childrenViaPgrep(pid: number, pgrep: string | undefined): number[] | undefined {
  if (pgrep === undefined) {
    return undefined;
  }

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
 * How children are found, in order of preference.
 *
 * A parameter rather than a hard-coded chain, because "this source on its own"
 * is the only way to show that a source works. The first version of the test
 * for /proc emptied PATH -- which proves nothing, since the resolver does not
 * read PATH -- and passed with /proc removed.
 */
export type ChildLister = (pid: number) => number[] | undefined;

export const PROC_SOURCE: ChildLister = pid => childrenViaProc(pid);
export const PGREP_SOURCE: ChildLister = pid => childrenViaPgrep(pid, trustedPgrep());

/** What production uses: /proc where there is one, pgrep otherwise. */
export const DEFAULT_CHILD_SOURCES: ChildLister[] = [PROC_SOURCE, PGREP_SOURCE];

/**
 * Every descendant of a pid, deepest last.
 *
 * Walked repeatedly rather than once. A single snapshot misses anything forked
 * after its parent was scanned, and killing that parent reparents the newcomer
 * out of reach. Re-walking until a pass finds nothing new closes the window
 * that a process which forks while being torn down would otherwise sit in.
 */
export function listDescendants(
  pid: number,
  sources: ChildLister[] = DEFAULT_CHILD_SOURCES,
  onDiscover: (pid: number) => void = () => {}
): number[] {
  const childrenOf = (of: number): number[] | undefined => {
    for (const source of sources) {
      const children = source(of);
      if (children !== undefined) {
        return children;
      }
    }
    return undefined;
  };

  const found: number[] = [];

  for (let pass = 0; pass < 5; pass += 1) {
    const before = found.length;
    const queue = [pid, ...found];

    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) {
        break;
      }

      for (const child of childrenOf(current) ?? []) {
        if (!found.includes(child)) {
          found.push(child);
          queue.push(child);
          // Frozen as soon as it is seen. Stopping only the root's group left
          // a descendant that had moved to a group of its own free to fork
          // throughout the walk -- and its children belonged to neither the
          // list nor any group being signalled.
          onDiscover(child);
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
 *  2. Walking with `pgrep -P`, which finds descendants wherever they are --
 *     including one that called setsid and left the group entirely, which (1)
 *     cannot reach. A walk is a snapshot, so it is repeated until it stops
 *     finding anything new.
 *
 * Both run on POSIX, every time. They find different things: (1) is atomic but
 * only covers the group, (2) covers escapees but is a snapshot. Using either as
 * a reason to skip the other leaves exactly the gap the other was for.
 *
 * Detaching used to be the whole answer, and its cost is that the child leaves
 * the terminal's foreground process group, so Ctrl-C no longer reaches it
 * directly. That is covered by installShutdownHandlers(), which every entry
 * point now installs: the signal reaches this process, and this process ends
 * the groups it owns.
 */
export function terminateProcessTree(
  child: { pid?: number | undefined; kill: (signal?: NodeJS.Signals | number) => boolean },
  sources: ChildLister[] = DEFAULT_CHILD_SOURCES
): void {
  if (child.pid === undefined) {
    return;
  }

  if (process.platform === 'win32') {
    if (windowsTerminateTree(child.pid)) {
      return;
    }
    // The process may already be gone; fall through to the signal attempt.
  } else {
    // Stop, enumerate, kill -- in that order, and both mechanisms every time.
    //
    // Treating a successful group signal as "the tree is gone" was wrong:
    // process.kill(-pid) succeeding says only that *something* in that group
    // received it. A descendant that called setsid, or was itself spawned
    // detached, has left for a group of its own and never hears it. The two
    // mechanisms find different things, so neither is a reason to skip the
    // other.
    //
    // SIGSTOP comes first because enumeration is a snapshot, and a snapshot
    // races anything still able to fork: a child spawned after the last
    // `pgrep -P` and before the kill belongs to no list and, once its parent
    // dies, to no reachable group either. A stopped process cannot fork. This
    // does not make the window zero -- a fork already in flight when the signal
    // lands still completes, and only an OS containment (cgroup, job object)
    // closes that properly -- but it turns a wide window into a narrow one.
    //
    // The walk still runs before the group kill: killing the group first
    // reparents anything that escaped and puts it out of reach of `pgrep -P`.
    stopProcessGroup(child.pid);
    walkAndKillDescendants(child.pid, sources);
    killProcessGroup(child.pid);
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
 * anything else this fails with ESRCH -- measured. The result is not a verdict
 * on whether the tree is gone; see the caller.
 */
/**
 * A process's start time, from /proc, as an opaque token.
 *
 * A pid on its own is not an identity: a descendant can exit between being
 * listed and being signalled, and on a busy machine -- or in a namespace with a
 * small pid_max -- the number can be handed to something else owned by the same
 * user. SIGKILL would then land on a stranger. Start time distinguishes them:
 * it is field 22 of /proc/<pid>/stat, counted from the *last* close paren,
 * because the command name in field 2 may itself contain spaces and parens.
 *
 * Returns undefined where there is no /proc, in which case the pid is all there
 * is and the check simply does not apply.
 */
function identityOf(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const afterComm = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    // Fields from 3 onwards: ppid is field 4 (index 1) and starttime field 22
    // (index 19). Both together, because a pid reused by a child of the same
    // parent would otherwise look unchanged for the first few ticks.
    const ppid = afterComm[1];
    const startedAt = afterComm[19];
    return ppid !== undefined && startedAt !== undefined ? `${ppid}:${startedAt}` : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a pid may still be signalled as the process we found.
 *
 * Three states, not two. "No identity available" used to mean "go ahead", and
 * on a system that *does* have /proc that is exactly the dangerous case: the
 * read fails because the process has already exited, and by the time the signal
 * goes out the number may belong to somebody else. Where identity is
 * obtainable in principle, an unobtainable one is a refusal.
 */
function mayStillSignal(pid: number, recorded: string | undefined): boolean {
  if (!hasProcFilesystem()) {
    return true; // no way to tell here; the pid is all there is
  }

  if (recorded === undefined) {
    return false; // it was already gone when we looked -- do not signal a number
  }

  return identityOf(pid) === recorded;
}

let procAvailable: boolean | undefined;

function hasProcFilesystem(): boolean {
  if (procAvailable === undefined) {
    try {
      procAvailable = statSync('/proc/self').isDirectory();
    } catch {
      procAvailable = false;
    }
  }
  return procAvailable;
}

/**
 * Freeze the group so it cannot fork while it is being enumerated.
 *
 * Best-effort: a process with no group of its own, or one already gone, simply
 * is not stopped. Anything still running is killed moments later regardless, so
 * a failed stop costs nothing but the narrower window.
 */
function stopProcessGroup(pid: number): 'group' | 'pid' | 'none' {
  try {
    process.kill(-pid, 'SIGSTOP');
    return 'group';
  } catch {
    try {
      process.kill(pid, 'SIGSTOP');
      return 'pid';
    } catch {
      return 'none';
    }
  }
}

/** Undo a stop, at the scope it was applied. */
function resumeStopped(pid: number, scope: 'group' | 'pid'): void {
  try {
    process.kill(scope === 'group' ? -pid : pid, 'SIGCONT');
  } catch {
    // Gone, which is the outcome we wanted anyway.
  }
}

function killProcessGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // No group of its own, or already gone. The walk above is what covers it.
  }
}

/** The fallback: find the descendants ourselves and end them, deepest first. */
function walkAndKillDescendants(pid: number, sources: ChildLister[] = DEFAULT_CHILD_SOURCES): void {
  // /proc is tried first and needs nothing resolved; only a system without it
  // *and* without a usable pgrep leaves us unable to enumerate.
  if (sources.every(source => source(pid) === undefined)) {
    // Nothing trustworthy to enumerate with. Say so rather than silently
    // killing one process and reporting success: a caller that believes the
    // tree is gone will not look for what is left.
    logger.warn('Cannot enumerate the process tree: no trusted pgrep found', {
      pid,
      consequence: 'only the process itself will be ended; helpers it started may survive',
    });
    return;
  }

  // Identity is taken at the moment of discovery, not afterwards.
  //
  // A pid on its own is not an identity: a descendant can exit between being
  // listed and being signalled, and the number is then reused. Reading identity
  // after the whole walk was too late in two ways -- the reused process had
  // already been SIGSTOPped by then, and its start time was recorded as if it
  // were the one we meant, so the later check compared a stranger against
  // itself and passed.
  const identities = new Map<number, string | undefined>();

  // What was stopped, and at what scope. Recording only the target pid conflated
  // three different outcomes -- a whole group stopped, one process stopped,
  // nothing stopped -- so the compensation could resume a group that was never
  // stopped, skip one that was, or send SIGCONT twice to the same group. Worse,
  // a group whose leader was killed had its compensation suppressed entirely,
  // leaving any other member of that group suspended for good.
  const stops = new Map<string, { pid: number; scope: 'group' | 'pid' }>();

  const freeze = (target: number): void => {
    const identity = identityOf(target);
    identities.set(target, identity);

    // Nothing is stopped that we could not identify: freezing a number that may
    // already belong to someone else is the same mistake as killing it, and a
    // stopped stranger is worse than a running one -- it never finishes.
    if (!mayStillSignal(target, identity)) {
      return;
    }

    const scope = stopProcessGroup(target);
    if (scope !== 'none') {
      stops.set(`${scope}:${target}`, { pid: target, scope });
    }
  };

  for (const descendant of listDescendants(pid, sources, freeze).reverse()) {
    if (!mayStillSignal(descendant, identities.get(descendant))) {
      logger.debug('Skipping a pid that is no longer the process we found', { pid: descendant });
      continue;
    }

    try {
      process.kill(descendant, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }

  // Every stop is paired, at the scope it was made. A group stop is resumed as
  // a group even when its leader was killed, because the other members of that
  // group -- including anything reparented into it that the walk never saw --
  // are still stopped and nothing else will ever wake them.
  for (const { pid: target, scope } of stops.values()) {
    resumeStopped(target, scope);
  }
}

