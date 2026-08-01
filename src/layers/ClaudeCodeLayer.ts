import { AsyncLocalStorage } from 'async_hooks';
import { ChildProcess, execFileSync, spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { LayerInterface, LayerResult, ReasoningResult, ReasoningTask, WorkflowDefinition, WorkflowResult } from '../core/types.js';

// Task interface for better type safety
interface ClaudeCodeTask {
  type?: string;
  action?: string;
  prompt?: string;
  request?: string;
  input?: string;
  workflow?: WorkflowDefinition;
  depth?: 'shallow' | 'medium' | 'deep';
  files?: string[];
  [key: string]: unknown;
}
import { logger } from '../utils/logger.js';
import { retry, safeExecute } from '../utils/errorHandler.js';
import { AuthVerifier } from '../auth/AuthVerifier.js';
import { buildSpawnTarget, resolveTrustedCommand, terminateProcessTree } from '../utils/processUtils.js';
import { onShutdown } from '../utils/shutdown.js';

/**
 * Said by whichever initialisation path fails first.
 *
 * Both paths locate the executable themselves, so both can be the one that
 * reports it missing -- and the guidance has to name CLAUDE_CODE_PATH, since a
 * user whose install is simply somewhere unusual needs to be told the setting
 * exists rather than to reinstall.
 */
const CLAUDE_NOT_FOUND_MESSAGE =
  'Claude Code executable not found. Install Claude Code: ' +
  'npm install -g @anthropic-ai/claude-code, or set CLAUDE_CODE_PATH ' +
  'to an existing installation.';

/**
 * ClaudeCodeLayer handles direct Claude Code execution with enhanced authentication support
 * Provides complex reasoning tasks and workflow orchestration capabilities
 */

/**
 * The cancellation in force for the current execute() call.
 *
 * Per-call rather than per-instance: one layer instance serves concurrent
 * requests, so an instance field would have one caller giving up kill another
 * caller's child. Same mechanism as AIStudioLayer.
 */
const claudeCancellation = new AsyncLocalStorage<AbortSignal>();

/**
 * The `claude` children this process has started.
 *
 * They had no owner at all: no live set, no shutdown step, no exit backstop.
 * The layer ends a child when its own call is cancelled, which covers the
 * timeout, but says nothing about the process being interrupted -- Ctrl-C ended
 * the parent and left `claude` and its helpers running against packageRoot.
 */
const liveClaudeChildren = new Set<ChildProcess>();

onShutdown('claude', async () => {
  const children = [...liveClaudeChildren];
  liveClaudeChildren.clear();

  for (const child of children) {
    terminateProcessTree(child);
  }

  await Promise.all(children.map(child => new Promise<void>(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const done = setTimeout(resolve, 5000);
    child.once('close', () => {
      clearTimeout(done);
      resolve();
    });
  })));
});

// The synchronous backstop, for a process.exit() that awaited nothing.
process.once('exit', () => {
  for (const child of liveClaudeChildren) {
    terminateProcessTree(child);
  }
});


export class ClaudeCodeLayer implements LayerInterface {
  private authVerifier: AuthVerifier;
  private claudePath?: string;
  /** Where the caller says Claude Code is, if anywhere. Tried before the defaults. */
  private readonly configuredPath: string | undefined;
  private isInitialized = false;
  private isLightweightInitialized = false; // Fast initialization for simple tasks
  private lastAuthCheck = 0; // Timestamp of last auth verification
  private readonly AUTH_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours auth cache (same as normal Claude Code session)
  private readonly DEFAULT_TIMEOUT = 300000; // 5 minutes
  private readonly MAX_RETRIES = 3;

  /**
   * @param codePath config.claude.code_path, when the caller has a config to
   *   hand. Takes precedence over CLAUDE_CODE_PATH; both are still subject to
   *   the trust check, so neither is a way past it.
   */
  constructor(codePath?: string) {
    this.authVerifier = new AuthVerifier();

    // ConfigSchema defaults claude.code_path to the bare name 'claude', and
    // LayerManager forwards that field whether or not anyone set it. So the
    // default arrived here looking deliberate and, being the most specific
    // candidate, outranked CLAUDE_CODE_PATH -- measured: with the variable
    // pointing at a different install, the PATH copy was used instead. That is
    // the main routing path, so the setting was defeated exactly where it
    // matters. A value equal to the schema default carries no information, so
    // it is treated as unset; 'claude' heads the default list anyway, leaving
    // the search unchanged.
    //
    // zod's .default() erases whether the caller omitted the field or wrote
    // the default value on purpose, so someone who means "use the PATH copy,
    // ignore the variable" cannot say so here. The variable wins in that case.
    const trimmed = codePath?.trim();
    this.configuredPath = trimmed && trimmed !== 'claude' ? trimmed : undefined;
  }

  /**
   * Lightweight initialization for simple tasks (skips connection tests)
   */
  async initializeLightweight(): Promise<void> {
    if (this.isLightweightInitialized) {
      return;
    }

    logger.debug('Performing lightweight Claude Code initialization...');

    // Find path only if not already set
    if (!this.claudePath) {
      this.claudePath = await this.findClaudeCodePath() || '';
      if (!this.claudePath) {
        throw new Error(CLAUDE_NOT_FOUND_MESSAGE);
      }
    }

    // Skip auth verification if recent check exists
    const now = Date.now();
    if (now - this.lastAuthCheck > this.AUTH_CACHE_TTL) {
      // The resolved path, not the bare name. This is the path execute() takes
      // for ordinary prompts -- anything without a workflow, a depth or
      // complex_reasoning -- so leaving it probing `claude` meant the whole
      // CLAUDE_CODE_PATH fix missed the common case, and the "not installed"
      // verdict it produced was then cached for 12 hours.
      const authResult = await this.authVerifier.verifyClaudeCodeAuth(this.claudePath);
      if (!authResult.success) {
        throw new Error(`Claude Code authentication failed: ${authResult.error}`);
      }
      this.lastAuthCheck = now;
    }

    this.isLightweightInitialized = true;
    logger.debug('Lightweight Claude Code initialization completed');
  }

  /**
   * Initialize the Claude Code layer
   */
  async initialize(): Promise<void> {
    return safeExecute(
      async () => {
        if (this.isInitialized) {
          return;
        }

        logger.info('Initializing Claude Code layer...');

        // Locate the executable BEFORE asking whether it is installed.
        //
        // The auth check probes the literal name `claude`, so on a machine
        // where the only install is the one CLAUDE_CODE_PATH points at -- the
        // case that setting exists for -- it reported "not installed" and threw
        // here, before the configured path was ever tried. Finding it first
        // both answers the installation question and gives the auth probe a
        // path that exists. The install hint the auth failure used to carry has
        // to be reproduced here, since this is now the check that fails first.
        this.claudePath = await this.findClaudeCodePath() || '';
        if (!this.claudePath) {
          throw new Error(CLAUDE_NOT_FOUND_MESSAGE);
        }

        // Verify authentication using the executable we just resolved
        const authResult = await this.authVerifier.verifyClaudeCodeAuth(this.claudePath);
        if (!authResult.success) {
          throw new Error(`Claude Code authentication failed: ${authResult.error}`);
        }

        // Test basic functionality
        await this.testClaudeCodeConnection();

        this.isInitialized = true;
        logger.info('Claude Code layer initialized successfully', {
          claudePath: this.claudePath,
          authenticated: authResult.success,
        });
      },
      {
        operationName: 'initialize-claude-code-layer',
        layer: 'claude',
        timeout: 30000,
      }
    );
  }

  /**
   * Check if Claude Code layer is available
   */
  async isAvailable(): Promise<boolean> {
    try {
      if (!this.isInitialized) {
        await this.initialize();
      }
      return this.isInitialized;
    } catch (error) {
      logger.debug('Claude Code layer not available', { error: (error as Error).message });
      return false;
    }
  }

  /**
   * Check if this layer can handle the given task
   */
  canHandle(task: ClaudeCodeTask): boolean {
    if (!task || typeof task !== 'object') {
      return false;
    }

    // Handle general Claude Code tasks
    if (task.type === 'claude_code' || task.action === 'execute' || task.action === 'complex_reasoning') {
      return true;
    }

    // Handle reasoning tasks
    if (task.type === 'reasoning' || task.prompt) {
      return true;
    }

    // Handle workflow orchestration
    if (task.type === 'workflow' || task.workflow) {
      return true;
    }

    // Handle synthesis and general tasks
    if (task.action === 'synthesize_response' || task.request) {
      return true;
    }

    return false;
  }

  /**
   * Execute a task through Claude Code
   */
  async execute(task: ClaudeCodeTask, signal?: AbortSignal): Promise<LayerResult> {
    // Nothing is started for a caller that has already given up. Without this,
    // the work ran and the cancellation then had to undo it -- and an
    // interactive `claude` is not free to start.
    if (signal?.aborted) {
      throw new Error('Claude Code execution cancelled before it started');
    }

    return safeExecute(
      async (operationSignal) => claudeCancellation.run(operationSignal, async () => {
        const startTime = Date.now();
        
        // Use lightweight initialization for simple tasks
        if (!this.isInitialized && !this.isLightweightInitialized) {
          // For simple text processing, use lightweight init
          if (!task.workflow && !task.depth && task.action !== 'complex_reasoning') {
            await this.initializeLightweight();
          } else {
            await this.initialize();
          }
        }

        logger.info('Executing Claude Code task', {
          taskType: task.type || 'general',
          action: task.action || 'execute',
        });

        let result: any;

        // Route to appropriate execution method based on task type/action
        switch (task.action || task.type) {
          case 'complex_reasoning':
            const reasoningResult = await this.executeComplexReasoning(task);
            result = reasoningResult.reasoning || 'Reasoning completed';
            break;
          case 'synthesize_response':
            result = await this.synthesizeResponse(task);
            break;
          case 'workflow':
            const workflowResult = await this.orchestrateWorkflow(task.workflow ?? task);
            result = workflowResult.summary || 'Workflow completed';
            break;
          default:
            result = await this.executeGeneral(task);
        }

        const duration = Date.now() - startTime;
        
        return {
          success: true,
          data: result,
          metadata: {
            layer: 'claude' as const,
            duration,
            tokens_used: this.estimateTokensUsed(task, result),
            cost: this.calculateCost(task, result),
            model: 'claude-code',
          },
        };
      }),
      {
        operationName: 'execute-claude-code-task',
        ...(signal ? { signal } : {}),
        layer: 'claude',
        timeout: this.getTaskTimeout(task),
      }
    );
  }

  /**
   * Execute complex reasoning task
   */
  async executeComplexReasoning(task: ClaudeCodeTask): Promise<ReasoningResult> {
    return retry(
      async () => {
        logger.debug('Executing complex reasoning task', {
          promptLength: task.prompt?.length || 0,
          depth: task.depth ?? 'medium',
          domain: task.domain,
        });

        const prompt = this.buildReasoningPrompt({
          prompt: task.prompt || 'Please provide reasoning',
          depth: task.depth,
          context: task.context as string | undefined,
          domain: task.domain as string | undefined,
        });
        const result = await this.executeClaudeCommand(prompt, {
          timeout: this.DEFAULT_TIMEOUT,
          reasoning: true,
        });

        return this.parseReasoningResult(result, {
          prompt: task.prompt || 'Please provide reasoning',
          depth: task.depth,
          context: task.context as string | undefined,
          domain: task.domain as string | undefined,
        });
      },
      {
        maxAttempts: this.MAX_RETRIES,
        delay: 2000,
        operationName: 'complex-reasoning',
      }
    );
  }

  /**
   * Synthesize response from multiple inputs
   */
  async synthesizeResponse(task: ClaudeCodeTask): Promise<string> {
    return retry(
      async () => {
        logger.debug('Synthesizing response', {
          inputSources: task.inputs ? Object.keys(task.inputs).length : 1,
          request: task.request?.substring(0, 100) + '...',
        });

        const prompt = this.buildSynthesisPrompt(task);
        const result = await this.executeClaudeCommand(prompt, {
          timeout: this.DEFAULT_TIMEOUT,
          synthesis: true,
        });

        return result.trim();
      },
      {
        maxAttempts: this.MAX_RETRIES,
        delay: 1500,
        operationName: 'synthesize-response',
      }
    );
  }

  /**
   * Orchestrate workflow execution
   */
  async orchestrateWorkflow(workflow: WorkflowDefinition | ClaudeCodeTask): Promise<WorkflowResult> {
    return retry(
      async () => {
        logger.info('Orchestrating workflow', {
          stepCount: (workflow as WorkflowDefinition).steps?.length || 0,
          timeout: (workflow as WorkflowDefinition).timeout || this.DEFAULT_TIMEOUT,
        });

        const workflowDef = workflow as WorkflowDefinition;
        const prompt = this.buildWorkflowPrompt(workflowDef);
        const result = await this.executeClaudeCommand(prompt, {
          timeout: workflowDef.timeout || this.DEFAULT_TIMEOUT * 2,
          workflow: true,
        });

        return this.parseWorkflowResult(result, workflowDef);
      },
      {
        maxAttempts: this.MAX_RETRIES,
        delay: 3000,
        operationName: 'orchestrate-workflow',
      }
    );
  }

  /**
   * Get layer capabilities
   */
  getCapabilities(): string[] {
    return [
      'complex_reasoning',
      'synthesize_response', 
      'workflow_orchestration',
      'code_analysis',
      'text_processing',
      'general_intelligence',
      'task_planning',
      'problem_solving',
    ];
  }

  /**
   * Get cost estimation for a task
   */
  getCost(_task: ClaudeCodeTask): number {
    // Claude Code is typically free for personal use
    return 0;
  }

  /**
   * Get estimated duration for a task
   */
  getEstimatedDuration(task: ClaudeCodeTask, prompt?: string): number {
    const baseTime = 5000; // 5 seconds base

    if (task.type === 'workflow' || task.action === 'workflow') {
      return baseTime * 3; // Workflows take longer
    }

    if (task.action === 'complex_reasoning') {
      return baseTime * 2; // Complex reasoning takes longer
    }

    // The prompt that will be sent, when the caller knows it. Reading only
    // task.prompt missed every step whose text is assembled from its fields.
    const text = prompt ?? task.prompt;
    if (text && text.length > 1000) {
      return baseTime * 1.5; // Longer prompts take more time
    }

    return baseTime;
  }

  /**
   * Execute general Claude Code task
   */
  private async executeGeneral(task: ClaudeCodeTask): Promise<string> {
    const prompt = task.prompt || task.request || task.input || this.describeTask(task);

    // Sized from the prompt that is actually sent, not from task.prompt. A step
    // whose text is built here has no task.prompt at all, so the estimate
    // scored it as the shortest possible request.
    return await this.executeClaudeCommand(prompt, {
      timeout: this.getTaskTimeout(task, prompt),
    });
  }

  /**
   * A prompt built from a task that carries no prose.
   *
   * Workflow steps addressed to this layer often carry structure rather than a
   * sentence: the analysis workflow's `analyze_requirements` step arrives as
   * {documents, analysisType, outputRequirements}, and its `synthesize_analysis`
   * step as {analysisResults, requirements}. None of those is prompt, request
   * or input, so both fell through to the literal "Please help with this
   * task." -- measured against a live run, Claude answered "no specific task
   * has been described in this conversation", twice, and both answers were
   * folded into the workflow result as though they were work.
   */
  private describeTask(task: ClaudeCodeTask): string {
    const action = typeof task.action === 'string' ? task.action : task.type;
    const skip = new Set(['action', 'type', 'files', 'options', 'workflow', 'depth']);

    const fields = Object.entries(task)
      .filter(([key, value]) => !skip.has(key) && value !== undefined && value !== null && value !== '')
      .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);

    if (fields.length === 0) {
      return action
        ? `Perform the "${action}" step of a CGMB workflow. No further input was supplied.`
        : 'Please help with this task.';
    }

    const heading = action
      ? `Perform the "${action}" step of a CGMB workflow, using the following input:`
      : 'Please act on the following input:';

    return `${heading}\n\n${fields.join('\n')}`;
  }

  /**
   * Execute Claude Code command
   */
  private async executeClaudeCommand(prompt: string, options: {
    timeout?: number;
    reasoning?: boolean;
    synthesis?: boolean;
    workflow?: boolean;
  } = {}): Promise<string> {
    if (!this.claudePath) {
      throw new Error('Claude Code not initialized');
    }

    const timeout = options.timeout || this.DEFAULT_TIMEOUT;
    
    return new Promise<string>((resolve, reject) => {
      logger.debug('Executing Claude command', {
        promptLength: prompt.length,
        timeout,
        options,
      });

      // The prompt is delivered on stdin, never on the command line.
      //
      // Prompt text is caller-controlled and reaches this layer from MCP input.
      // Putting it in argv meant that on Windows, where an npm-installed
      // `claude.cmd` shim has to be invoked through cmd.exe, it became part of a
      // shell command line. MSVCRT-style `\"` escaping does not protect it:
      // cmd.exe has no concept of backslash escapes, so it reads the backslash
      // as a literal, treats the quote as closing, and executes anything after
      // an unquoted `&`. Verified with a .cmd shim -- the payload
      // `x" & echo ... & rem "` ran an extra command.
      //
      // With the prompt on stdin the command line carries only static flags, so
      // there is nothing left to escape and the class of bug cannot recur.
      // `--print` makes the headless single-answer mode explicit rather than
      // depending on a CLI default.
      // Checked rather than asserted: claudePath is optional and set during
      // initialize(), so an execution path that skipped it would otherwise
      // reach buildSpawnTarget with undefined and fail obscurely.
      if (!this.claudePath) {
        throw new Error('Claude Code path has not been resolved; call initialize() first.');
      }
      const target = buildSpawnTarget(this.claudePath, ['--print']);

      const child = spawn(target.file, target.args, {
        // stdin is a pipe we write and immediately close. It must not be left
        // idle: Claude Code waits ~3s for piped input before giving up and
        // logging "no stdin data received in 3s", taxing every call.
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: this.packageRoot,
        env: this.buildChildEnv(),
        windowsHide: true,
        // Its own process group on POSIX; see terminateProcessTree. Every
        // child is tracked in liveClaudeChildren and ended by the shutdown
        // step, so detaching does not make it anyone's orphan.
        ...(process.platform === 'win32' ? {} : { detached: true }),
        ...target.spawnOptions,
      });

      liveClaudeChildren.add(child);
      child.once('close', () => liveClaudeChildren.delete(child));

      child.stdin.on('error', () => {
        // A child that exits before reading stdin gives us EPIPE; the close
        // handler below already reports the real failure.
      });
      child.stdin.end(prompt);

      let output = '';
      let errorOutput = '';
      let settled = false;

      // Cancellation ends the child, not just the waiting. A short workflow
      // timeout used to return failure to the caller -- which fell back, or
      // moved on -- while this `claude` ran to its own five-minute budget,
      // still writing wherever it had been pointed.
      const signal = claudeCancellation.getStore();

      const stopOnAbort = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutId);
        logger.info('Cancelling Claude Code execution', { pid: child.pid });
        terminateProcessTree(child);
        reject(new Error('Claude Code execution cancelled'));
      };

      const timeoutId = setTimeout(() => {
        // The tree is ended from the live parent, not after it.
        //
        // Two versions of this were wrong. The first escalated only if the
        // parent was *still alive* two seconds after SIGTERM, so a `claude`
        // that exits promptly left its helpers running -- the tidy case was the
        // leaky one. The second always escalated, but still killed the parent
        // first: on Windows what this holds is the cmd.exe that launched
        // claude.cmd, and `taskkill /PID <parent> /T` cannot enumerate a tree
        // whose root has already exited. Either way the helpers survived.
        //
        // So: end the tree while the parent is still there to be walked from,
        // and let SIGTERM follow for a process that would rather leave tidily.
        terminateProcessTree(child);
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            terminateProcessTree(child);
          }
        }, 2000).unref();
        settled = true;
        reject(new Error(`Claude Code execution timeout after ${timeout}ms`));
      }, timeout);

      if (signal) {
        if (signal.aborted) {
          stopOnAbort();
        } else {
          signal.addEventListener('abort', stopOnAbort, { once: true });
          child.once('close', () => signal.removeEventListener('abort', stopOnAbort));
        }
      }

      child.stdout.on('data', (data) => {
        output += data.toString();
      });

      child.stderr.on('data', (data) => {
        errorOutput += data.toString();
      });

      child.on('close', (code) => {
        clearTimeout(timeoutId);

        if (settled) {
          return; // already timed out or cancelled; the caller has its answer
        }
        settled = true;

        if (code === 0 && output.trim() !== '') {
          logger.debug('Claude command completed successfully', {
            outputLength: output.length,
            code,
          });
          resolve(output);
        } else if (code === 0) {
          // Exit 0 with no output is not an answer. It was resolved as one, so
          // upper layers reported success and substituted placeholders like
          // "Reasoning completed" -- and no fallback to another layer occurred.
          reject(new Error(
            'Claude Code exited successfully but produced no output' +
            (errorOutput.trim() ? `: ${errorOutput.trim()}` : '. Check the CLI version and permissions.')
          ));
        } else {
          const error = `Claude Code exited with code ${code}: ${errorOutput}`;
          logger.error('Claude command failed', { code, error: errorOutput });
          reject(new Error(error));
        }
      });

      child.on('error', (error) => {
        clearTimeout(timeoutId);
        if (settled) {
          return;
        }
        settled = true;
        logger.error('Claude command process error', { error: error.message });
        reject(error);
      });
    });
  }

  /**
   * Directory the spawned Claude Code process runs in.
   *
   * Claude Code loads CLAUDE.md, .claude/settings.json and any skills from its
   * working directory, so cwd decides what governs CGMB's internal reasoning
   * calls. It used to be process.cwd() -- whatever directory the MCP server
   * happened to be launched from, i.e. the end user's project. That made the
   * layer's behaviour depend on an unrelated repository's instructions and
   * permissions, and meant CGMB's own .claude/ configuration was never read.
   * Verified empirically: a CLAUDE.md in the cwd is picked up, one outside it
   * is not.
   *
   * Pinned to the package root so the layer behaves identically wherever CGMB
   * is invoked from. Callers pass absolute paths, so nothing depends on the
   * user's cwd.
   */
  private get packageRoot(): string {
    // dist/layers/ClaudeCodeLayer.js -> package root
    return join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  }

  /**
   * Build the environment for a spawned Claude Code process.
   *
   * CGMB may itself be running inside a Claude Code session whose environment
   * remaps the model aliases (ANTHROPIC_DEFAULT_OPUS_MODEL and friends) or
   * pins a model outright. Inheriting those would silently answer CGMB's
   * internal reasoning calls with whatever model the host developer happened
   * to configure, so they are stripped and the child picks its own defaults.
   */
  static readonly STRIPPED_CHILD_VARS = [
    // Model overrides. A parent that has remapped the aliases would silently
    // remap the child's model too.
    'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'CLAUDE_CODE_SUBAGENT_MODEL',

    // The parent session's identity. CGMB is commonly registered as an MCP
    // server inside Claude Code, so when it shells out to `claude` the child
    // inherited the session it was launched from: the same session id, the same
    // entrypoint, the same IDE socket. The child then presents itself as part
    // of a conversation it is not in.
    'CLAUDECODE',
    'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_CODE_SSE_PORT',
    'CLAUDE_CODE_IDE_HOST',
    'CLAUDE_CODE_IDE_PORT',

    // CGMB's own Google credentials. `claude` has no use for them, and the
    // narrower the set of processes that hold a key, the fewer places it can
    // leak from. The Antigravity layer already builds its child environment
    // from an allowlist for the same reason; this is the same rule stated as a
    // denylist, because unlike agy, `claude` legitimately needs a broad
    // environment to find its own config and credentials.
    'AI_STUDIO_API_KEY',
    'GOOGLE_AI_STUDIO_API_KEY',
    'GEMINI_API_KEY',
  ] as const;

  /**
   * The environment the `claude` child gets: this process's, minus what it
   * must not carry over. Exposed as a static so what is stripped can be
   * checked without spawning anything.
   */
  static childEnvFrom(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const env = { ...source };

    for (const name of ClaudeCodeLayer.STRIPPED_CHILD_VARS) {
      delete env[name];
    }

    return env;
  }

  private buildChildEnv(): NodeJS.ProcessEnv {
    return ClaudeCodeLayer.childEnvFrom(process.env);
  }

  /**
   * Where Claude Code is likely to be installed.
   *
   * Platform and environment are parameters with defaults, so the macOS branch
   * can be exercised from a Windows or Linux test run. There is no darwin
   * branch: macOS follows the same list as Linux, which makes /opt/homebrew the
   * only Mac-specific entry and the only one another OS can check.
   *
   * An explicitly configured path goes first, then CLAUDE_CODE_PATH. Both were
   * previously ignored: .env.example advertises CLAUDE_CODE_PATH and
   * ConfigSchema carries claude.code_path, but this list was a fixed literal,
   * so an install outside these locations was simply unreachable however it
   * was declared. Order is the whole mechanism -- each candidate still has to
   * survive resolveTrustedCommand, so naming one cannot reach a binary the
   * defaults would have refused.
   */
  static claudeCandidatePaths(
    platform: NodeJS.Platform = process.platform,
    env: NodeJS.ProcessEnv = process.env,
    configured?: string
  ): string[] {
    const appDataPath = env.APPDATA ?? '';
    // Blank or whitespace-only means "unset", not "look for a file named ''".
    const preferred = [configured, env.CLAUDE_CODE_PATH]
      .map(value => value?.trim())
      .filter((value): value is string => value !== undefined && value !== '');

    return [...new Set([
      ...preferred,
      'claude',
      'claude-original',
      // Windows paths (npm global install location)
      ...(platform === 'win32' && appDataPath ? [
        join(appDataPath, 'npm', 'claude.cmd'),
        join(appDataPath, 'npm', 'claude'),
      ] : []),
      // Unix paths. /opt/homebrew is Homebrew's prefix on Apple Silicon;
      // Intel Macs and Linux use /usr/local.
      '/usr/local/bin/claude',
      '/usr/local/bin/claude-original',
      '/opt/homebrew/bin/claude',
      '/opt/homebrew/bin/claude-original',
    ])];
  }

  /**
   * Find Claude Code executable path
   */
  private async findClaudeCodePath(): Promise<string | undefined> {
    const possiblePaths = ClaudeCodeLayer.claudeCandidatePaths(
      process.platform,
      process.env,
      this.configuredPath
    );

    for (const path of possiblePaths) {
      try {
        // execFileSync, not a shell string: an interpolated path containing
        // spaces (C:\Program Files\...) would otherwise be split into
        // arguments, and any shell metacharacter in it would be interpreted.
        const target = buildSpawnTarget(path, ['--version']);
        execFileSync(target.file, target.args, {
          stdio: 'ignore',
          timeout: 5000,
          windowsHide: true,
          ...target.spawnOptions,
        });
        // Return the resolved absolute path, not the candidate name. Returning
        // a bare name meant every later use resolved it again, outside the
        // trust check that had just approved a specific file.
        const verified = resolveTrustedCommand(path);
        if (verified === undefined) {
          continue;
        }
        logger.debug('Found Claude Code at', { path: verified });
        return verified;
      } catch {
        continue;
      }
    }

    // System PATH, through the shared trusted resolver.
    //
    // This ran `where claude` / `which claude` through a shell and returned the
    // first line unchecked, so a claude.cmd in the working tree was adopted
    // here even after the loop above had refused it.
    const resolved = resolveTrustedCommand('claude');
    if (resolved !== undefined && !resolved.includes('cgmb')) {
      return resolved;
    }

    return undefined;
  }

  /**
   * Test Claude Code connection
   */
  private async testClaudeCodeConnection(): Promise<void> {
    // Probe the already-verified path with an argv array.
    //
    // These were shell strings interpolating this.claudePath, which resolved
    // the name a second time -- so a candidate the trust check had rejected
    // could be selected here instead, during initialization.
    const probe = (args: string[], timeout: number): string => {
      if (!this.claudePath) {
        throw new Error('Claude Code path has not been resolved; call initialize() first.');
      }
      const target = buildSpawnTarget(this.claudePath, args);
      return execFileSync(target.file, target.args, {
        timeout,
        encoding: 'utf8',
        stdio: 'pipe',
        windowsHide: true,
        ...target.spawnOptions,
      });
    };

    try {
      const output = probe(['--version'], 30000);
      if (output?.trim()) {
        logger.debug('Claude Code connection test successful via --version', {
          version: output.trim().substring(0, 100),
        });
        return;
      }
    } catch (versionError) {
      logger.debug('Claude --version failed, trying --help', {
        error: (versionError as Error).message,
      });

      try {
        const helpOutput = probe(['--help'], 15000);
        if (helpOutput && (helpOutput.includes('Claude') || helpOutput.includes('Usage:') || helpOutput.length > 20)) {
          logger.debug('Claude Code connection test successful via --help', {
            helpLength: helpOutput.length,
          });
          return;
        }
      } catch (helpError) {
        logger.warn('Both --version and --help failed for Claude Code', {
          versionError: (versionError as Error).message,
          helpError: (helpError as Error).message,
        });
        throw new Error(`Claude Code connection test failed: ${(helpError as Error).message}`);
      }
    }

    throw new Error('Claude Code produced no usable output for --version or --help');
  }

  /**
   * Build reasoning prompt
   */
  private buildReasoningPrompt(task: ReasoningTask): string {
    let prompt = `Please provide detailed reasoning for the following:\n\n${task.prompt}`;
    
    if (task.context) {
      prompt += `\n\nContext: ${task.context}`;
    }
    
    if (task.depth) {
      const depthInstructions = {
        shallow: 'Provide a brief, high-level analysis.',
        medium: 'Provide a thorough analysis with key reasoning steps.',
        deep: 'Provide a comprehensive, step-by-step analysis with detailed justification.',
      };
      prompt += `\n\nDepth: ${depthInstructions[task.depth]}`;
    }
    
    if (task.domain) {
      prompt += `\n\nDomain: Focus on ${task.domain} perspectives and principles.`;
    }
    
    prompt += '\n\nPlease structure your response with clear reasoning steps and a conclusion.';
    
    return prompt;
  }

  /**
   * Build synthesis prompt
   */
  private buildSynthesisPrompt(task: ClaudeCodeTask): string {
    let prompt = 'Please synthesize and respond to the following:\n\n';

    // `request` is what a direct caller sends; a workflow step carries the same
    // thing as `prompt`, and some callers as `input`. Only `request` was read,
    // so every synthesis step of a workflow -- the last step of the analysis,
    // conversion and orchestration flows -- reached Claude as two sentences of
    // instructions with nothing to synthesise, and whatever came back was
    // reported as the workflow's answer.
    const request = task.request
      ?? (typeof task.prompt === 'string' ? task.prompt : undefined)
      ?? (typeof task.input === 'string' ? task.input : undefined);

    if (request) {
      prompt += `Request: ${request}\n\n`;
    }

    const inputs = task.inputs as Record<string, unknown> | undefined;
    if (inputs && typeof inputs === 'object') {
      prompt += 'Input Sources:\n';
      Object.entries(inputs).forEach(([source, content], index) => {
        // Upstream answers arrive as objects when a step published structured
        // data; "[object Object]" is not something to synthesise from.
        prompt += `${index + 1}. ${source}: ${
          typeof content === 'string' ? content : JSON.stringify(content)
        }\n`;
      });
      prompt += '\n';
    }

    prompt += 'Please provide a comprehensive, well-structured response that synthesizes all the information.';

    return prompt;
  }

  /**
   * Build workflow prompt
   */
  private buildWorkflowPrompt(workflow: WorkflowDefinition): string {
    let prompt = 'Please execute the following workflow:\n\n';
    
    if (workflow.steps) {
      prompt += 'Steps:\n';
      workflow.steps.forEach((step, index) => {
        prompt += `${index + 1}. ${step.action}: ${JSON.stringify(step.input)}\n`;
      });
      prompt += '\n';
    }
    
    prompt += 'Please execute each step and provide a comprehensive result.';
    
    return prompt;
  }

  /**
   * Parse reasoning result
   */
  private parseReasoningResult(output: string, _task: ReasoningTask): ReasoningResult {
    // Try to extract structured reasoning from output
    const lines = output.trim().split('\n');
    const steps: string[] = [];
    let reasoning = '';
    let conclusion = '';
    
    // Simple parsing - look for numbered steps or bullet points
    let inSteps = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {continue;}
      
      if (/^\d+\./.test(trimmed) || /^[-*]/.test(trimmed)) {
        steps.push(trimmed);
        inSteps = true;
      } else if (inSteps && trimmed.toLowerCase().includes('conclusion')) {
        conclusion = trimmed;
        inSteps = false;
      } else if (!inSteps) {
        reasoning += trimmed + ' ';
      }
    }
    
    // Fallback: use entire output as reasoning
    if (!reasoning && !conclusion) {
      reasoning = output.trim();
    }
    
    return {
      reasoning: reasoning.trim() || output.trim(),
      conclusion: conclusion.trim() || 'Analysis completed.',
      confidence: 0.8, // Default confidence
      steps: steps.length > 0 ? steps : undefined,
    };
  }

  /**
   * Parse workflow result
   */
  private parseWorkflowResult(output: string, workflow: WorkflowDefinition): WorkflowResult {
    return {
      success: true,
      results: {
        workflow_execution: {
          success: true,
          data: output,
          metadata: {
            layer: 'claude' as const,
            duration: 0,
            model: 'claude-code',
          },
        },
      },
      summary: 'Workflow executed successfully via Claude Code',
      metadata: {
        total_duration: 0,
        steps_completed: workflow.steps?.length || 1,
        steps_failed: 0,
        total_cost: 0,
      },
    };
  }

  /**
   * Get task timeout
   */
  private getTaskTimeout(task: ClaudeCodeTask, prompt?: string): number {
    if (typeof task.timeout === 'number') {
      return task.timeout;
    }

    // A floor, not a guess. The estimate below is 5 seconds for anything that
    // is not a workflow or complex reasoning, so an ordinary step got 35
    // seconds -- for an interactive `claude` invocation that answers a real
    // question. Measured: the analysis workflow's first step timed out at
    // exactly 35000ms as soon as it was given something to think about, having
    // previously come back fast because it was answering a placeholder.
    //
    // The floor is this layer's own budget. A step is not a different kind of
    // call from any other `claude` invocation, and the estimate is a guess with
    // no measurement behind it: measured, one analyze_requirements step took 85
    // seconds to do the work properly, which 120 seconds would clear only
    // narrowly and 35 not at all. LayerManager bounds the step at the same five
    // minutes, so this cannot outlive its caller.
    return Math.max(this.getEstimatedDuration(task, prompt) + 30000, this.DEFAULT_TIMEOUT);
  }

  /**
   * Estimate tokens used
   */
  private estimateTokensUsed(task: ClaudeCodeTask, result: string): number {
    const inputText = JSON.stringify(task);
    const outputText = typeof result === 'string' ? result : JSON.stringify(result);
    
    // Rough estimate: 1 token ≈ 4 characters
    return Math.ceil((inputText.length + outputText.length) / 4);
  }

  /**
   * Calculate cost
   */
  private calculateCost(_task: ClaudeCodeTask, _result: string): number {
    // Claude Code is typically free
    return 0;
  }
}