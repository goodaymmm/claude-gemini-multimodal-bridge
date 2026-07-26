import { spawn } from 'child_process';
import { mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DEFAULT_ANTIGRAVITY_MODEL, FileReference, GroundedResult, GroundingContext, LayerInterface, LayerResult, MultimodalResult, RETIRED_GEMINI_CLI_MODEL_PATTERN } from '../core/types.js';
import { logger } from '../utils/logger.js';
import { safeExecute } from '../utils/errorHandler.js';
import { AuthVerifier } from '../auth/AuthVerifier.js';
import { SearchCache } from '../utils/SearchCache.js';
import { AGY_INSTALL_HINT, MIN_AGY_VERSION, findAntigravityBinary, isVersionAtLeast } from '../utils/antigravityCli.js'; // eslint-disable-line sort-imports

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
  private cachedWorkspaceDir?: string;
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
        layer: 'gemini',
        timeout: 10000,
      }
    );
  }

  /**
   * Check if the Antigravity CLI layer is available
   */
  async isAvailable(): Promise<boolean> {
    try {
      if (!this.isInitialized) {
        await this.initialize();
      }
      return this.isInitialized;
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
  async execute(task: AntigravityTask): Promise<LayerResult> {
    const startTime = Date.now();

    // Ensure initialization
    if (!this.isInitialized) {
      await this.initialize();
    }

    return safeExecute(
      async () => {
        logger.info('Executing Antigravity CLI task', {
          taskType: task.type ?? 'general',
          useSearch: task.useSearch !== false,
          hasFiles: !!(task.files && task.files.length > 0),
          promptLength: task.prompt?.length ?? 0,
        });

        const prompt = this.extractPrompt(task);
        if (!prompt.trim()) {
          throw new Error('No prompt provided for Antigravity CLI execution');
        }

        // Check cache for search-enabled tasks (CGMB unique feature)
        if (task.useSearch !== false) {
          const cachedResult = await this.searchCache.get(prompt, 'gemini');
          if (cachedResult) {
            logger.debug('Cache hit for Antigravity search', {
              promptLength: prompt.length,
              cacheAge: Date.now() - cachedResult.timestamp
            });

            return {
              success: true,
              data: cachedResult.content,
              metadata: {
                layer: 'gemini' as const,
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
          }, 'gemini', duration);
        }

        return {
          success: true,
          data: result,
          metadata: {
            layer: 'gemini' as const,
            duration,
            cache_hit: false,
            model: this.normalizeModel(task.model, this.DEFAULT_MODEL),
            search_enabled: task.useSearch !== false,
          }
        };
      },
      {
        operationName: 'execute-antigravity-cli-task',
        layer: 'gemini',
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
   * Process files (basic support for text files)
   */
  async processFiles(files: FileReference[], prompt: string): Promise<MultimodalResult> {
    // Antigravity CLI has limited file support here - focus on text processing
    const textFiles = files.filter(f => f.type === 'text' || f.path.endsWith('.txt') || f.path.endsWith('.md'));

    if (textFiles.length === 0) {
      throw new Error('Antigravity CLI layer only supports text files. Use AI Studio layer for other file types.');
    }

    logger.debug('Processing text files with Antigravity CLI', {
      fileCount: textFiles.length,
      promptLength: prompt.length,
    });

    const result = await this.execute({
      type: 'multimodal',
      prompt,
      files: textFiles,
    });

    return {
      content: result.data as string,
      success: true,
      files_processed: textFiles.map(f => f.path),
      processing_time: result.metadata?.duration ?? 0,
      workflow_used: 'analysis' as const,
      layers_involved: ['gemini'] as const,
      metadata: {
        total_duration: result.metadata?.duration ?? 0,
        ...result.metadata,
      },
    };
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

    const isWindows = process.platform === 'win32';
    const printTimeoutSec = Math.ceil(this.DEFAULT_TIMEOUT / 1000);

    return new Promise<string>((resolve, reject) => {
      // `-p` (alias of --print/--prompt) runs one prompt and exits.
      const args: string[] = ['-p', prompt, '--print-timeout', `${printTimeoutSec}s`];

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
      const child = spawn(this.agyPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: this.workspaceDir,
        env: this.buildChildEnv(),
        ...(isWindows ? { windowsHide: true } : {}),
      });

      let stdout = '';
      let stderr = '';
      let settled = false;

      child.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', (code) => {
        clearTimeout(killTimer);
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
            if (isWindows) {
              child.kill();
            } else {
              child.kill('SIGKILL');
            }
          }
        }, 2000);

        if (!settled) {
          settled = true;
          reject(new Error(
            `Antigravity CLI timeout after ${printTimeoutSec}s. ` +
            `Raise ANTIGRAVITY_TIMEOUT if the prompt legitimately needs longer.`
          ));
        }
      }, this.DEFAULT_TIMEOUT + 5000);
    });
  }

  /**
   * An empty directory used as the CLI's workspace so it never sees the
   * repository it is running inside. Created lazily and reused.
   */
  private get workspaceDir(): string {
    if (!this.cachedWorkspaceDir) {
      const dir = join(tmpdir(), 'cgmb-agy-workspace');
      mkdirSync(dir, { recursive: true });
      this.cachedWorkspaceDir = dir;
    }
    return this.cachedWorkspaceDir;
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
  async translateToEnglish(text: string, sourceLang: string): Promise<string> {
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

    // Simplified translation prompt for image generation
    const translationPrompt = `Translate to English for image generation: ${text}`;

    logger.info(`Translating ${languageName} prompt to English using Antigravity CLI`, {
      originalText: text,
      sourceLang,
      languageName
    });

    try {
      const result = await this.execute({
        type: 'translation',
        prompt: translationPrompt,
        useSearch: false, // No web search needed for translation
        model: this.DEFAULT_MODEL
      });

      if (!result.success || !result.data) {
        throw new Error('Translation failed: No result returned');
      }

      const translatedText = (result.data as string).trim();

      logger.info('Translation completed successfully', {
        originalText: text,
        translatedText,
        sourceLang,
        duration: result.metadata?.duration ?? 0
      });

      return translatedText;

    } catch (error) {
      logger.error('Translation failed, using original text', {
        error: error instanceof Error ? error.message : String(error),
        originalText: text,
        sourceLang
      });

      // Fallback to original text if translation fails
      return text;
    }
  }
}
