import { AsyncLocalStorage } from 'async_hooks';
import { ChildProcess, spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import { DEFAULT_ANTIGRAVITY_MODEL, FileReference, GroundedResult, GroundingContext, LayerInterface, LayerResult, MultimodalResult, RETIRED_GEMINI_CLI_MODEL_PATTERN, taskFileRefs } from '../core/types.js';
import { logger } from '../utils/logger.js';
import { safeExecute } from '../utils/errorHandler.js';
import { AuthVerifier } from '../auth/AuthVerifier.js';
import { SearchCache } from '../utils/SearchCache.js';
import { terminateProcessTree } from '../utils/processUtils.js';
import { onShutdown } from '../utils/shutdown.js';
import { AGY_INSTALL_HINT, MIN_AGY_VERSION, findAntigravityBinary, isVersionAtLeast, probeAntigravityAuth } from '../utils/antigravityCli.js'; // eslint-disable-line sort-imports

/**
 * Workspaces and children that still exist, swept if the process ends first.
 *
 * Both are normally released when the child closes. A timeout does not close
 * anything: the layer signals the child and rejects, and the child's exit --
 * and with it the cleanup and the SIGKILL escalation two seconds later -- only
 * happens if this process is still around to see it. The MCP server is, so the
 * defect stayed invisible there; the one-shot CLI is not. `cgmb search` that
 * times out returned to the shell leaving a live agy and its scratch directory
 * behind, once per timed-out search, and nothing ever collected them. Measured
 * with a stand-in agy that outlives its budget: workspace present, two strays.
 *
 * 'exit' handlers may only do synchronous work, which both of these are.
 */
const isWindows = process.platform === 'win32';

/**
 * The cancellation in force for the current execute() call.
 *
 * Per-call rather than per-instance: one layer instance serves concurrent
 * requests, so an instance field would have one caller giving up kill another
 * caller's agy. Same mechanism as the other two layers.
 */
const cancellation = new AsyncLocalStorage<AbortSignal>();
const liveWorkspaces = new Set<string>();
const liveChildren = new Set<ChildProcess>();
let sweepInstalled = false;

function installExitSweep(): void {
  if (sweepInstalled) {
    return;
  }
  sweepInstalled = true;

  onShutdown('antigravity', () => shutdownAntigravity());

  process.once('exit', () => {
    // The last-resort backstop, and it can only do synchronous work: there is
    // no way to wait for a child to close inside an 'exit' handler. So it kills
    // the tree and tries the directory, and accepts that on Windows the removal
    // may lose a race against a process that has not finished dying -- a
    // leftover directory in tmp is the lesser failure, and shutdownAntigravity()
    // below is what makes it rare.
    for (const child of liveChildren) {
      terminateProcessTree(child);
    }
    for (const dir of liveWorkspaces) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Nothing useful can be logged at exit.
      }
    }
  });
}

/**
 * Stop everything this layer started, and wait for it.
 *
 * Called before a one-shot CLI run exits. The exit hook cannot wait, and on
 * Windows a `rmSync` issued while the process is still dying fails because the
 * files are still open -- and the failure is swallowed, because throwing out of
 * an exit handler is worse. Here there is somewhere to wait, so the children
 * are ended, awaited, and only then are the directories removed.
 *
 * Safe to call when nothing is running: it returns immediately.
 */
export async function shutdownAntigravity(timeoutMs = 5000): Promise<void> {
  const children = [...liveChildren];
  const workspaces = [...liveWorkspaces];

  if (children.length === 0 && workspaces.length === 0) {
    return;
  }

  for (const child of children) {
    terminateProcessTree(child);
  }

  await Promise.all(children.map(child => new Promise<void>(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }

    const done = setTimeout(resolve, timeoutMs);
    child.once('close', () => {
      clearTimeout(done);
      resolve();
    });
  })));

  for (const dir of workspaces) {
    try {
      rmSync(dir, { recursive: true, force: true });
      liveWorkspaces.delete(dir);
    } catch (error) {
      logger.debug('Could not remove Antigravity workspace during shutdown', {
        dir,
        error: (error as Error).message,
      });
    }
  }
}

/**
 * Task interface for better type safety
 */

interface AntigravityTask {
  type?: string;
  action?: string;
  prompt?: string;
  request?: string;
  input?: string;
  useSearch?: boolean;
  needsGrounding?: boolean;
  files?: FileReference[];
  model?: string;
  [key: string]: unknown;
}

/**
 * AntigravityCLILayer - wrapper around the Antigravity CLI (`agy`) binary.
 *
 * Replaces the former Gemini CLI integration: Google discontinued Gemini CLI for
 * individual accounts on 2026-06-18 and `agy` is the successor.
 *
 * Focuses on high-speed search and real-time information processing,
 * with an intelligent cache layer on top (CGMB-specific).
 */
export class AntigravityCLILayer implements LayerInterface {
  private authVerifier: AuthVerifier;
  private searchCache: SearchCache;
  private agyPath: string = 'agy';
  private agyVersion?: string;
  private isInitialized = false;

  // Antigravity responds slower than the old Gemini CLI, so the default budget is higher.
  private readonly DEFAULT_TIMEOUT = Number.parseInt(process.env.ANTIGRAVITY_TIMEOUT ?? '', 10) || 90000;
  // Model IDs must exist in `agy models` output. `gemini-2.5-*` no longer does.
  private readonly DEFAULT_MODEL =
    this.normalizeModel((process.env.ANTIGRAVITY_MODEL ?? '').trim(), DEFAULT_ANTIGRAVITY_MODEL);

  constructor() {
    this.authVerifier = new AuthVerifier();

    // Initialize search cache for performance optimization (CGMB unique value)
    this.searchCache = new SearchCache({
      ttl: Number.parseInt(process.env.CACHE_TTL ?? '', 10) || 1800000, // 30 minutes
      maxEntries: Number.parseInt(process.env.MAX_CACHE_ENTRIES ?? '', 10) || 1000,
      enableMetrics: process.env.ENABLE_CACHING === 'true',
      similarityThreshold: 0.8
    });
  }

  /**
   * Initialize the Antigravity CLI layer with minimal overhead.
   * Only checks authentication status; never blocks on failure.
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    return safeExecute(
      async () => {
        logger.info('Initializing Antigravity CLI layer...');

        // Check authentication status but don't block on failure
        const authResult = await this.authVerifier.verifyGeminiAuth();
        if (!authResult.success) {
          logger.info('Antigravity authentication not configured. Some features may not work.', {
            error: authResult.error,
            instructions: 'Run `agy` once interactively to complete the Google OAuth flow'
          });
        }

        // Path is resolved lazily on first actual use
        this.agyPath = 'agy';

        this.isInitialized = true;
        logger.info('Antigravity CLI layer initialized', {
          authenticated: authResult.success,
          authMethod: authResult.status?.method ?? 'none',
        });
      },
      {
        operationName: 'initialize-antigravity-cli-layer',
        layer: 'antigravity',
        timeout: 10000,
      }
    );
  }

  /**
   * Check whether this layer can actually serve a request.
   *
   * "Initialized" and "usable" are not the same thing. initialize() only logs
   * an authentication warning and never blocks, so it always ends with
   * isInitialized = true. Returning that flag reported the search layer as
   * available on machines with no agy installed at all, which meant
   * CGMBServer.verifyDependencies() and any monitoring built on it hid a real
   * outage and every request failed downstream instead.
   *
   * Checks the three things a request actually depends on: the binary exists,
   * it is new enough, and the session is authenticated.
   */
  async isAvailable(): Promise<boolean> {
    try {
      if (!this.isInitialized) {
        await this.initialize();
      }

      const binary = await findAntigravityBinary();
      if (!binary) {
        logger.debug('Antigravity CLI layer unavailable: agy not found', {
          install: AGY_INSTALL_HINT,
        });
        return false;
      }

      if (!binary.versionSupported) {
        logger.warn('Antigravity CLI layer unavailable: agy is older than the supported minimum', {
          version: binary.version,
          minimum: MIN_AGY_VERSION,
        });
        return false;
      }

      const probe = await probeAntigravityAuth(binary.path);
      if (!probe.authenticated) {
        // Distinguish "signed out" from "could not reach the service": the
        // second is transient and should not be read as a configuration error.
        logger.debug('Antigravity CLI layer unavailable', {
          outcome: probe.outcome,
          error: probe.error,
        });
        return false;
      }

      return true;
    } catch (error) {
      logger.debug('Antigravity CLI layer not available', { error: (error as Error).message });
      return false;
    }
  }

  /**
   * Check if this layer can handle the given task
   */
  canHandle(task: AntigravityTask): boolean {
    if (!task || typeof task !== 'object') {
      return false;
    }

    // Antigravity CLI specializes in:
    // - Search and current information
    // - Simple text processing
    // - Real-time queries
    return !!(
      task.type === 'search' ||
      task.type === 'grounding' ||
      task.action === 'grounded_search' ||
      task.useSearch !== false || // Default to search-enabled
      task.needsGrounding === true ||
      ((task.type === 'antigravity' || task.type === 'gemini') && !task.files) ||
      task.type === 'text_processing'
    );
  }

  /**
   * Main execution method
   */
  async execute(task: AntigravityTask, signal?: AbortSignal): Promise<LayerResult> {
    if (signal?.aborted) {
      throw new Error('Antigravity CLI execution cancelled before it started');
    }

    return cancellation.run(signal ?? new AbortController().signal, () => this.executeInContext(task, Date.now()));
  }

  private async executeInContext(task: AntigravityTask, startTime: number): Promise<LayerResult> {

    // Ensure initialization
    if (!this.isInitialized) {
      await this.initialize();
    }

    // This layer is text-prompt only, and says so before doing any work.
    //
    // It used to silently drop task.files and answer from the prompt alone, so
    // `cgmb analyze` falling back from AI Studio asked the CLI to summarise
    // documents it had never been given -- a confident non-answer reported as
    // success. Passing paths cannot work either: agy runs in an empty scratch
    // directory with no access to the caller's files, by design. Failing here
    // is the honest outcome; file work belongs to the AI Studio layer.
    //
    // taskFileRefs, not task.files: the document-analysis fallback arrives here
    // with `documents` instead, and reading only `files` let it straight past
    // this guard to be answered from the prompt alone.
    const referencedFiles = taskFileRefs(task);
    if (referencedFiles.length > 0) {
      throw new Error(
        'The Antigravity CLI layer cannot process files; it accepts a text prompt only. ' +
        'Use the AI Studio layer for documents and media (for example `cgmb analyze <file>`).'
      );
    }

    return safeExecute(
      async () => {
        logger.info('Executing Antigravity CLI task', {
          taskType: task.type ?? 'general',
          useSearch: task.useSearch !== false,
          promptLength: task.prompt?.length ?? 0,
        });

        const prompt = this.extractPrompt(task);
        if (!prompt.trim()) {
          throw new Error('No prompt provided for Antigravity CLI execution');
        }

        // Check cache for search-enabled tasks (CGMB unique feature)
        if (task.useSearch !== false) {
          const cachedResult = await this.searchCache.get(
            prompt,
            'antigravity',
            this.normalizeModel(task.model, this.DEFAULT_MODEL)
          );
          if (cachedResult) {
            logger.debug('Cache hit for Antigravity search', {
              promptLength: prompt.length,
              cacheAge: Date.now() - cachedResult.timestamp
            });

            return {
              success: true,
              data: cachedResult.content,
              metadata: {
                layer: 'antigravity' as const,
                duration: Date.now() - startTime,
                cache_hit: true,
                model: this.normalizeModel(task.model, this.DEFAULT_MODEL),
              }
            };
          }
        }

        const result = await this.executeAntigravityCLI(prompt, {
          model: this.normalizeModel(task.model, this.DEFAULT_MODEL)
        });

        const duration = Date.now() - startTime;

        // Cache search results (CGMB enhancement)
        if (task.useSearch !== false && result.trim()) {
          await this.searchCache.set(prompt, {
            content: result,
            sources: this.extractSources(result),
            grounded: true,
            search_used: true,
            timestamp: Date.now()
          }, 'antigravity', duration, this.normalizeModel(task.model, this.DEFAULT_MODEL));
        }

        return {
          success: true,
          data: result,
          metadata: {
            layer: 'antigravity' as const,
            duration,
            cache_hit: false,
            model: this.normalizeModel(task.model, this.DEFAULT_MODEL),
            search_enabled: task.useSearch !== false,
          }
        };
      },
      {
        operationName: 'execute-antigravity-cli-task',
        layer: 'antigravity',
        // Outer budget sits above the in-process timeout so `agy --print-timeout`
        // and the kill backstop both get a chance to produce a specific error.
        timeout: this.DEFAULT_TIMEOUT + 10000,
      }
    );
  }

  /**
   * Execute with grounding (simplified for search tasks)
   */
  async executeWithGrounding(prompt: string, context: GroundingContext): Promise<GroundedResult> {
    const task: AntigravityTask = {
      type: 'grounding',
      prompt,
      useSearch: context.useSearch !== false,
    };

    const result = await this.execute(task);

    return {
      content: result.data as string,
      sources: this.extractSources(result.data as string),
      grounded: true,
      search_used: context.useSearch !== false,
    };
  }

  /**
   * Not supported: this layer takes a text prompt and nothing else.
   *
   * Kept so callers that route file work here (cli.ts `cgmb gemini -f`) fail
   * with an actionable message instead of a type error. Reading files and
   * inlining them into the prompt was tried and removed: the feature existed
   * only as a fallback for AI Studio, and making it safe -- binary sniffing,
   * encoding detection, credential filtering, size budgets -- cost far more
   * code than the fallback was worth. AI Studio handles files natively.
   */
  processFiles(files: FileReference[], _prompt: string): Promise<MultimodalResult> {
    const names = files.map(f => basename(f.path)).join(', ');
    return Promise.reject(new Error(
      `The Antigravity CLI layer cannot process files (${names}); it accepts a text prompt only. ` +
      `Use the AI Studio layer instead -- for example \`cgmb analyze ${files[0]?.path ?? '<file>'}\`.`
    ));
  }

  /**
   * Get layer capabilities
   */
  getCapabilities(): string[] {
    return [
      'real_time_search',
      'web_grounding',
      'current_information',
      'text_processing',
      'simple_analysis',
      'search_integration',
    ];
  }

  /**
   * Get cost estimation (free tier)
   */
  getCost(_task: AntigravityTask): number {
    return 0; // Free tier usage
  }

  /**
   * Get estimated duration
   */
  getEstimatedDuration(task: AntigravityTask): number {
    const baseTime = 3000; // 3 seconds base

    if (task.useSearch !== false) {
      return baseTime + 5000; // +5s for search
    }

    return baseTime;
  }

  /**
   * Core Antigravity CLI execution.
   *
   * `agy -p` runs a single prompt non-interactively and prints plain text to stdout.
   * There is no JSON output mode, so callers must treat stdout as free-form text.
   *
   * Tool-permission prompts are intentionally NOT auto-approved: `agy` is a coding
   * agent and `--dangerously-skip-permissions` would let it read and write files in
   * the working directory. A prompt that stalls waiting for approval is bounded by
   * `--print-timeout` instead.
   */
  private async executeAntigravityCLI(prompt: string, options: { model?: string } = {}): Promise<string> {
    // Lazy load agy path on first use
    if (this.agyPath === 'agy') {
      const binary = await findAntigravityBinary();
      if (binary) {
        this.agyPath = binary.path;
        if (binary.version !== undefined) {
          this.agyVersion = binary.version;
        }
      } else {
        throw new Error(
          `Antigravity CLI (agy) not found. Install it with: ${AGY_INSTALL_HINT}`
        );
      }
    }

    if (this.agyVersion && !isVersionAtLeast(this.agyVersion, MIN_AGY_VERSION)) {
      throw new Error(
        `Antigravity CLI ${this.agyVersion} is too old (minimum ${MIN_AGY_VERSION}). ` +
        `Older builds return an empty response with exit code 0 when stdout is not a TTY, ` +
        `which silently breaks CGMB. Update with \`agy update\`.`
      );
    }

    const printTimeoutSec = Math.ceil(this.DEFAULT_TIMEOUT / 1000);

    return new Promise<string>((resolve, reject) => {
      // `-p` (alias of --print/--prompt) runs one prompt and exits.
      // The prompt goes on stdin, not in argv.
      //
      // Windows caps a process command line at 32767 characters, and Node
      // throws ENAMETOOLONG synchronously from spawn() past that -- measured
      // here: 32000 spawns, 33000 throws. Inlining a document into the prompt
      // therefore broke outright for any file over ~32KB. `agy` reads the
      // prompt from stdin when no -p is given (verified: exit 0 with the
      // correct answer), which removes the limit entirely and, as a side
      // benefit, keeps caller-controlled text off the command line.
      const args: string[] = ['--print-timeout', `${printTimeoutSec}s`];

      // Only add model flag if explicitly specified and not 'auto'
      if (options.model && options.model !== 'auto') {
        args.push('--model', options.model);
      }

      logger.debug('Executing Antigravity CLI', {
        command: this.agyPath,
        model: options.model,
        promptLength: prompt.length,
        printTimeoutSec,
        platform: process.platform,
      });

      // `agy` is a real executable on every platform (not a .cmd shim), so `shell`
      // is unnecessary here. Avoiding it also avoids Windows quoting hazards.
      //
      // Isolation matters: agy is a coding agent, and the prompt arrives from an
      // MCP caller. Inheriting the CGMB process's cwd would put the repository
      // (including .env) inside its workspace, and inheriting process.env would
      // hand it AI_STUDIO_API_KEY and friends. Run it in an empty scratch
      // directory with only the variables it needs to find its own config and
      // credentials.
      const workspaceDir = this.createWorkspaceDir();
      installExitSweep();
      liveWorkspaces.add(workspaceDir);

      const child = spawn(this.agyPath, args, {
        // stdin carries the prompt and is closed immediately: agy drains it to
        // EOF before producing output, so an idle pipe would hang forever.
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: workspaceDir,
        env: this.buildChildEnv(),
        // Its own process group, so a cancellation can signal the group rather
        // than one process. agy spawns helpers of its own, and without this the
        // negative-pid kill fails with ESRCH -- measured -- leaving descendants
        // running and, on the timeout path, holding the workspace open. The
        // trade is that Ctrl-C in a terminal no longer reaches it directly,
        // which is why shutdown is explicit now.
        ...(isWindows ? { windowsHide: true } : { detached: true }),
      });

      liveChildren.add(child);

      child.stdin.on('error', () => {
        // The child may exit before reading stdin; the close handler reports
        // the real failure.
      });
      child.stdin.end(prompt);

      let stdout = '';
      let stderr = '';
      let settled = false;

      // Cancellation ends the CLI, not just the waiting. A short workflow
      // timeout used to return failure while this agy ran to its own budget --
      // a duplicate external call the caller would never read.
      const signal = cancellation.getStore();

      const stopOnAbort = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(killTimer);
        logger.info('Cancelling Antigravity CLI execution', { pid: child.pid });
        terminateProcessTree(child);
        cleanupWorkspace();
        reject(new Error('Antigravity CLI execution cancelled'));
      };

      // Remove the scratch directory once the child is gone, whatever the
      // outcome. Anything agy wrote there belongs to this request alone.
      const cleanupWorkspace = (): void => {
        liveWorkspaces.delete(workspaceDir);
        liveChildren.delete(child);
        try {
          rmSync(workspaceDir, { recursive: true, force: true });
        } catch (error) {
          logger.debug('Could not remove Antigravity workspace directory', {
            workspaceDir,
            error: (error as Error).message,
          });
        }
      };

      // setEncoding before the listeners, so Node's decoder holds partial
      // multi-byte sequences across chunk boundaries.
      //
      // Calling toString() on each Buffer decoded chunks independently: a UTF-8
      // character split across two data events became U+FFFD on both sides.
      // Chunk boundaries are arbitrary, so ordinary Japanese answers could come
      // back quietly corrupted -- and be returned as a success and cached.
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');

      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk;
      });

      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk;
      });

      child.on('close', (code) => {
        clearTimeout(killTimer);
        cleanupWorkspace();
        if (settled) {
          return;
        }
        settled = true;

        const output = stdout.trim();

        logger.debug('Antigravity CLI process closed', {
          code,
          stdoutLength: stdout.length,
          stderrLength: stderr.length,
        });

        if (code !== 0) {
          // The stderr vocabulary of `agy` is not documented and differs from Gemini
          // CLI's. Surface it verbatim rather than pattern-matching on guesses.
          reject(new Error(
            `Antigravity CLI failed (exit code ${code}): ${stderr.trim() || 'no stderr output'}`
          ));
          return;
        }

        if (!output) {
          reject(new Error(
            `Antigravity CLI returned an empty response (exit code 0). ` +
            `Check authentication with \`agy models\` and the log at ` +
            `~/.gemini/antigravity-cli/log/. stderr: ${stderr.trim() || 'none'}`
          ));
          return;
        }

        resolve(output);
      });

      child.on('error', (err) => {
        clearTimeout(killTimer);
        cleanupWorkspace();
        if (settled) {
          return;
        }
        settled = true;
        reject(new Error(`Antigravity CLI spawn error: ${err.message}`));
      });

      // Backstop only: `--print-timeout` should fire first and let agy exit cleanly.
      const killTimer = setTimeout(() => {
        logger.warn('Antigravity CLI exceeded its print timeout, terminating process', {
          timeoutMs: this.DEFAULT_TIMEOUT,
          promptLength: prompt.length,
          platform: process.platform
        });

        if (isWindows) {
          child.kill(); // Windows: kill() without signal
        } else {
          child.kill('SIGTERM');
        }

        // `child.killed` only means a signal was delivered, so it flips to true
        // even when the process ignores SIGTERM and keeps running. Gate the
        // escalation on the process actually having exited instead, otherwise
        // SIGKILL is never sent and agy survives in the background.
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            logger.warn('Antigravity CLI ignored SIGTERM, escalating', { pid: child.pid });
            // The tree, not the one process: agy spawns its own helpers, and a
            // survivor holds files open in the directory about to be removed.
            terminateProcessTree(child);
          }
          // Cleanup here as well as on close. On a timeout the caller has
          // already been told it failed and may be on its way out, and the
          // close that cleanup normally hangs off may never be observed.
          cleanupWorkspace();
        }, 2000);

        if (!settled) {
          settled = true;
          reject(new Error(
            `Antigravity CLI timeout after ${printTimeoutSec}s. ` +
            `Raise ANTIGRAVITY_TIMEOUT if the prompt legitimately needs longer.`
          ));
        }
      }, this.DEFAULT_TIMEOUT + 5000);

      if (signal) {
        if (signal.aborted) {
          stopOnAbort();
        } else {
          signal.addEventListener('abort', stopOnAbort, { once: true });
          child.once('close', () => signal.removeEventListener('abort', stopOnAbort));
        }
      }
    });
  }

  /**
   * A fresh, private, empty directory used as the CLI's workspace so it never
   * sees the repository it is running inside.
   *
   * One directory per execution, via mkdtemp. A fixed shared path was wrong on
   * two counts: agy can read and write its cwd depending on the prompt, so
   * files left by one request could leak into or contaminate the next; and a
   * predictable name under a world-writable /tmp can be pre-created or
   * symlink-swapped by another user on a shared host. mkdtemp generates an
   * unpredictable name and fails rather than reusing an existing directory.
   */
  private createWorkspaceDir(): string {
    // mode 0700: readable only by the owner. Ignored on Windows, where the
    // per-user temp directory already provides the equivalent isolation.
    return mkdtempSync(join(tmpdir(), 'cgmb-agy-'), { encoding: 'utf8' });
  }

  /**
   * Minimal environment for the CLI child process.
   *
   * Passes only what agy needs to locate itself, its config and its keyring,
   * so secrets held by CGMB (AI_STUDIO_API_KEY, CLAUDE_API_KEY, ...) are never
   * exposed to an agent that can be steered by an untrusted prompt.
   */
  private buildChildEnv(): NodeJS.ProcessEnv {
    const allowed = [
      'PATH', 'Path', 'PATHEXT',
      'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
      'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
      'SystemRoot', 'SystemDrive', 'windir', 'TEMP', 'TMP', 'TMPDIR',
      'LANG', 'LC_ALL', 'TZ',
      'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR',
      'DBUS_SESSION_BUS_ADDRESS', // Linux Secret Service (keyring) access
      'DISPLAY', 'WAYLAND_DISPLAY',
      'CODEX_HOME', 'GEMINI_HOME',
    ];

    const env: NodeJS.ProcessEnv = {};
    for (const key of allowed) {
      const value = process.env[key];
      if (value !== undefined) {
        env[key] = value;
      }
    }
    return env;
  }

  /**
   * Map a requested model onto something Antigravity actually serves.
   *
   * Callers still carry Gemini CLI era IDs (`gemini-2.5-pro`, `gemini-3-flash`, ...)
   * in saved configs, .env files and CLI defaults. Forwarding those to `agy` yields
   * a hard failure, so they are downgraded to the default with a warning instead.
   */
  private normalizeModel(requested: string | undefined, fallback: string): string {
    const model = (requested ?? '').trim();

    if (!model || model === 'auto') {
      return fallback;
    }

    if (RETIRED_GEMINI_CLI_MODEL_PATTERN.test(model)) {
      logger.warn(
        `Model "${model}" belongs to the retired Gemini CLI and is not served by Antigravity. ` +
        `Falling back to "${fallback}". Run \`agy models\` for the current catalogue.`
      );
      return fallback;
    }

    return model;
  }

  /**
   * Extract prompt from task (unified method)
   */
  private extractPrompt(task: AntigravityTask): string {
    return task.prompt ?? task.request ?? task.input ?? '';
  }

  /**
   * Extract sources from CLI output.
   *
   * Known limitation: unlike Gemini CLI, `agy -p` does not reliably emit citation
   * URLs for grounded answers, so this often returns an empty list even when the
   * answer was web-grounded. Treat an empty result as "sources unavailable",
   * not as "answer was not grounded".
   */
  private extractSources(output: string): string[] {
    const sources: string[] = [];

    // Look for URL patterns
    const urlPattern = /https?:\/\/[^\s]+/g;
    const urls = output.match(urlPattern);

    if (urls) {
      sources.push(...urls);
    }

    // Look for source citations
    const sourcePattern = /Source: (.+?)(?:\n|$)/g;
    let match;
    while ((match = sourcePattern.exec(output)) !== null) {
      sources.push(match[1]?.trim() ?? '');
    }

    return [...new Set(sources)]; // Remove duplicates
  }

  /**
   * Get search cache statistics
   */
  getCacheStats() {
    return this.searchCache.getStats();
  }

  /**
   * Clear search cache
   */
  async clearCache(): Promise<void> {
    await this.searchCache.clear();
  }

  /**
   * Translate text to English for image generation.
   * Uses the CLI layer for efficient token usage and cost optimization.
   */
  /**
   * Reduce a model reply to a single usable prompt line.
   *
   * The instruction above asks for a bare translation, but model output is not
   * a contract: a chatty reply must not be able to break image generation. The
   * downstream API rejects prompts over 480 characters, so this enforces the
   * shape in code -- pick the first substantive line, drop markdown decoration,
   * and fall back to the original text rather than emitting something unusable.
   */
  private extractTranslation(raw: string, original: string): string {
    // Strip only complete list/heading markers. A greedy [\d.)\s]+ class ate
    // meaningful leading digits: "3D render of three cats" became "D render of
    // three cats" and "2026 Tokyo skyline" lost its year -- silently producing
    // an image of something else rather than failing.
    const stripMarkers = (line: string): string =>
      line
        .replace(/^\s*(?:[>#]+\s*|[-*+]\s+|\d+[.)]\s+)+/, '')
        .replace(/\*\*/g, '')
        .replace(/^["']|["']$/g, '')
        .trim();

    // Label detection keys on structure, not vocabulary.
    //
    // An earlier version rejected any line starting with anime/cinematic/
    // photorealistic that later contained "style", "prompt" or "translation".
    // Those are ordinary words in an image prompt: "Anime style illustration of
    // a cat" was discarded and the Japanese original was sent to the image API
    // instead -- a worse outcome than the chattiness it was guarding against.
    const isLabel = (line: string): boolean =>
      /^(here are|here is|options?|option\s*\d|alternatives?|choices?|notes?)\b/i.test(line) ||
      line.endsWith(':');

    // A refusal or apology is not a translation. Passing one through would send
    // "I cannot help with that" to the image API as if it were the prompt.
    const isRefusal = (line: string): boolean =>
      /^(i (cannot|can't|am unable|won't)|sorry|unfortunately|as an ai)\b/i.test(line);

    // "Translation: <text>" is the answer wearing a label; keep the payload.
    const unlabel = (line: string): string =>
      line.replace(/^(translation|english|prompt|result)\s*[:\-]\s*/i, '').trim();

    const lines = raw.split('\n').map(stripMarkers).filter(line => line.length > 0);

    // A single-line reply is the requested shape, but it still has to be
    // checked. Taking it verbatim let bare labels ("Option 1", "Translation:")
    // and refusals through as successful translations, which the AI Studio
    // layer then marked wasTranslated and sent to the image API -- generating a
    // picture of the wrong thing and reporting success.
    if (lines.length === 1 && lines[0] !== undefined) {
      const single = unlabel(lines[0]);

      if (single.length >= 3 && !isLabel(single) && !isRefusal(single)) {
        return this.capTranslation(single);
      }

      logger.warn('Single-line reply was a label or refusal, not a translation; using the original text');
      return original;
    }

    const highlighted = [...raw.matchAll(/\*\*"?([^"*\n]{3,300})"?\*\*/g)]
      .map(match => stripMarkers(match[1] ?? ''))
      .filter(line => line.length >= 3 && !isLabel(line));

    const candidates = (highlighted.length > 0 ? highlighted : lines)
      .map(unlabel)
      .filter(line => !isLabel(line) && !isRefusal(line));

    const picked = candidates.find(line => line.length >= 3);

    if (picked === undefined) {
      logger.warn('Could not extract a translation from the model reply; using the original text', {
        rawLength: raw.length,
      });
      return original;
    }

    return this.capTranslation(picked);
  }

  /**
   * Keep a translation inside the image API's prompt budget.
   *
   * The API rejects prompts over 480 characters; 400 leaves headroom for the
   * safety prefix the AI Studio layer prepends.
   */
  private capTranslation(text: string): string {
    const MAX_TRANSLATION_LENGTH = 400;

    if (text.length <= MAX_TRANSLATION_LENGTH) {
      return text;
    }

    // Never log the text itself. Image prompts carry whatever the user typed,
    // which can include personal or confidential content, and warn output goes
    // to the console and to LOG_FILE with no redaction.
    logger.warn('Translation was longer than the image-prompt budget and was truncated', {
      length: text.length,
      limit: MAX_TRANSLATION_LENGTH,
    });
    return text.slice(0, MAX_TRANSLATION_LENGTH).trim();
  }

  async translateToEnglish(text: string, sourceLang: string, signal?: AbortSignal): Promise<string> {
    const languageNames: Record<string, string> = {
      ja: 'Japanese',
      ko: 'Korean',
      zh: 'Chinese',
      fr: 'French',
      de: 'German',
      es: 'Spanish',
      ru: 'Russian',
      ar: 'Arabic',
      hi: 'Hindi',
      th: 'Thai'
    };

    const languageName = languageNames[sourceLang] ?? sourceLang;

    // Antigravity answers conversationally by default. Asked to "translate for
    // image generation" it replied with a markdown document offering four
    // styled variants (700+ characters), which was then handed to the image API
    // verbatim and rejected for exceeding its 480-character prompt limit. Gemini
    // CLI used to answer tersely, so this only surfaced after the migration.
    // Constrain the output explicitly, then enforce it in code below.
    const translationPrompt =
      `Translate the following ${languageName} text into English for use as an image-generation prompt.\n` +
      `Output ONLY the translation on a single line. ` +
      `No explanation, no alternatives, no markdown, no quotes, no preamble.\n\n` +
      text;

    // Length only: the prompt body must not reach the logs (see capTranslation).
    logger.info(`Translating ${languageName} prompt to English using Antigravity CLI`, {
      sourceLang,
      languageName,
      length: text.length,
    });

    try {
      // The caller's cancellation, carried through. Without it this opened a
      // fresh, never-aborted context: a non-English image generation that was
      // still translating when the caller's budget expired left agy running to
      // its own ninety seconds, answering nobody.
      const result = await this.execute({
        type: 'translation',
        prompt: translationPrompt,
        useSearch: false, // No web search needed for translation
        model: this.DEFAULT_MODEL
      }, signal);

      if (!result.success || !result.data) {
        throw new Error('Translation failed: No result returned');
      }

      const raw = (result.data as string).trim();
      const translatedText = this.extractTranslation(raw, text);

      logger.info('Translation completed successfully', {
        sourceLang,
        translatedLength: translatedText.length,
        ...(raw === translatedText ? {} : { rawLength: raw.length }),
        duration: result.metadata?.duration ?? 0
      });

      return translatedText;

    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);

      logger.error('Translation failed', { error: reason, sourceLang, length: text.length });

      // Rethrow rather than returning the input.
      //
      // Returning `text` made a failed translation indistinguishable from a
      // successful one: the caller in AIStudioLayer took the untranslated
      // prompt as a translation, recorded wasTranslated: true, and sent the
      // original language to the image API. It already has a catch that says
      // "translation unavailable, continuing in the input language" and leaves
      // the prompt alone -- that path had simply never been reachable.
      throw new Error(`Could not translate the ${languageName} prompt to English: ${reason}`);
    }
  }
}
