import { spawn } from 'child_process';
import { closeSync, fstatSync, mkdtempSync, openSync, readSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { basename, isAbsolute, join, relative as relativePath } from 'path';
import { DEFAULT_ANTIGRAVITY_MODEL, FileReference, GroundedResult, GroundingContext, LayerInterface, LayerResult, MultimodalResult, RETIRED_GEMINI_CLI_MODEL_PATTERN } from '../core/types.js';
import { logger } from '../utils/logger.js';
import { safeExecute } from '../utils/errorHandler.js';
import { AuthVerifier } from '../auth/AuthVerifier.js';
import { SearchCache } from '../utils/SearchCache.js';
import { AGY_INSTALL_HINT, MIN_AGY_VERSION, findAntigravityBinary, isVersionAtLeast, probeAntigravityAuth } from '../utils/antigravityCli.js'; // eslint-disable-line sort-imports

/**
 * Task interface for better type safety
 */
/** Upper bound on inlined content from any single file. */
const MAX_INLINED_FILE_CHARS = 100000;

/**
 * Byte-level ceiling, checked with stat() before the file is opened.
 *
 * The character limit can only be applied after decoding, which is too late to
 * prevent the read itself from stalling the event loop. 4 bytes per character
 * is a generous allowance for UTF-8 so this never rejects a file the character
 * limit would have accepted.
 */
const MAX_INLINED_FILE_BYTES = MAX_INLINED_FILE_CHARS * 4;

/**
 * Upper bound across all inlined files in one request.
 *
 * A per-file cap alone let several documents add up without limit. The prompt
 * now travels on stdin so the 32767-character Windows command-line limit no
 * longer applies, but an unbounded prompt still wastes tokens and can exceed
 * the model's context, so the total stays capped.
 */
const MAX_TOTAL_INLINED_CHARS = 200000;

/**
 * Formats known to be binary. Everything else is decided by inspecting the
 * bytes.
 *
 * A closed allowlist was the wrong shape: it rejected .ts, .py, .sh, .sql,
 * .conf and extensionless files such as Dockerfile, LICENSE and .gitignore --
 * ordinary inputs for a developer tool. Naming what cannot be text is both
 * shorter and safer, because the content check below is the real gate.
 */
const BINARY_FILE_EXTENSIONS = new Set([
  'pdf', 'doc', 'docx', 'odt', 'rtf', 'pages',
  'xls', 'xlsx', 'ods', 'numbers', 'ppt', 'pptx', 'odp', 'key',
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'tiff', 'ico', 'psd',
  'mp3', 'wav', 'm4a', 'flac', 'aac', 'ogg', 'wma',
  'mp4', 'mov', 'avi', 'webm', 'mkv', 'flv', 'wmv',
  'zip', 'gz', 'tar', 'bz2', 'xz', '7z', 'rar',
  'exe', 'dll', 'so', 'dylib', 'bin', 'class', 'jar', 'wasm',
  'sqlite', 'db', 'woff', 'woff2', 'ttf', 'otf', 'eot',
]);

/** Leading bytes that identify common binary containers. */
const BINARY_MAGIC: ReadonlyArray<readonly number[]> = [
  [0x25, 0x50, 0x44, 0x46],        // %PDF
  [0x50, 0x4b, 0x03, 0x04],        // ZIP / OOXML
  [0x89, 0x50, 0x4e, 0x47],        // PNG
  [0xff, 0xd8, 0xff],              // JPEG
  [0x47, 0x49, 0x46, 0x38],        // GIF8
  [0x1f, 0x8b],                    // gzip
  [0x7f, 0x45, 0x4c, 0x46],        // ELF
  [0x4d, 0x5a],                    // PE/MZ
  [0xd0, 0xcf, 0x11, 0xe0],        // legacy Office
];

/**
 * True when a file's name does not mark it as a known binary format.
 *
 * Deliberately ignores FileReference.type: it is caller-supplied and arrives
 * from MCP input, so trusting it let a PDF labelled type:'text' through to be
 * read as UTF-8 and answered from mojibake. This is only a cheap first pass --
 * decodeAsText() inspects the actual bytes and is the real gate.
 */
export function isInlinableTextFile(file: FileReference): boolean {
  // basename() handles both separators, so no path parsing here.
  const name = basename(file.path).toLowerCase();
  const lastDot = name.lastIndexOf('.');

  // No extension (Dockerfile, LICENSE) or a leading-dot name (.gitignore) is
  // not a reason to reject: the byte check decides.
  if (lastDot <= 0) {
    return true;
  }

  return !BINARY_FILE_EXTENSIONS.has(name.slice(lastDot + 1));
}

/**
 * Decode raw bytes as text, or return undefined when they are not text.
 *
 * Works on the Buffer, and the BOM only selects a decoder -- it is never an
 * approval. Treating a BOM as proof let a binary with three bytes prepended
 * skip the magic, NUL and control-density checks entirely, and accepting a
 * UTF-16 BOM while still decoding as UTF-8 turned a legitimate document into
 * mojibake that the model answered as though it were prose.
 */
function decodeAsText(buffer: Buffer): string | undefined {
  if (buffer.length === 0) {
    return '';
  }

  let encoding: BufferEncoding = 'utf8';
  let body = buffer;

  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    body = buffer.subarray(3);
  } else if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    encoding = 'utf16le';
    body = buffer.subarray(2);
  } else if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    // Node cannot decode big-endian UTF-16; refuse rather than mangle it.
    return undefined;
  }

  // How far to search for a container signature depends on the encoding.
  //
  // For UTF-8, offset 0 is enough: a real PDF or ZIP starts with its
  // signature, and scanning further would reject prose that merely mentions
  // "%PDF-1.4" -- which a document about file formats legitimately does.
  //
  // A UTF-16 BOM is the evasion vector, because ASCII data behind one decodes
  // to plausible-looking code points and any padding shifts the signature past
  // a fixed offset. Genuine UTF-16 text cannot contain a contiguous ASCII
  // signature (its bytes are interleaved with 0x00 or script bytes), so a wide
  // scan there costs nothing and closes the hole.
  const magicWindow = encoding === 'utf16le' ? 4096 : 0;
  for (const magic of BINARY_MAGIC) {
    for (const region of [buffer, body]) {
      const limit = Math.min(magicWindow, region.length - magic.length);
      for (let offset = 0; offset <= limit; offset++) {
        if (magic.every((byte, i) => region[offset + i] === byte)) {
          return undefined;
        }
      }
    }
  }

  if (encoding === 'utf16le') {
    // An odd byte count cannot be UTF-16: decoding would silently drop the
    // last byte.
    if (body.length % 2 !== 0) {
      return undefined;
    }

    const text = body.toString('utf16le');

    // Validate the decoded code points, not the raw bytes: arbitrary binary
    // behind a UTF-16 BOM decodes to control characters and unpaired
    // surrogates rather than to NUL bytes.
    let control = 0;

    for (const char of text) {
      const code = char.codePointAt(0) ?? 0;
      if (code === 0 || (code >= 0xd800 && code <= 0xdfff)) {
        return undefined;
      }
      if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d && code !== 0x0c) {
        control++;
      }
    }

    if (text.length > 0 && control / text.length >= 0.02) {
      return undefined;
    }

    // No byte-ratio heuristic here, deliberately.
    //
    // An earlier version rejected content where both halves of a UTF-16 code
    // unit were printable ASCII, on the theory that this marks ASCII data
    // wearing a UTF-16 BOM. It does -- but it equally marks ordinary CJK text:
    // U+4E2D (中) is bytes 2D 4E, both printable. A normal Japanese document
    // measured 48% such units and was refused outright.
    //
    // Byte statistics cannot separate the two cases: ASCII pairs decode into
    // the same CJK ranges that genuine CJK text occupies. Container detection
    // above is the control that remains, and a crafted file that evades it
    // yields a wrong summary rather than anything executable -- a far smaller
    // cost than rejecting every CJK document.

    return text;
  }

  // UTF-8: every byte is checked, not just a prefix -- a text header followed
  // by a binary tail used to pass because only the first 8KB was sampled.
  let control = 0;
  for (const byte of body) {
    if (byte === 0) {
      return undefined;
    }
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0x0c) {
      control++;
    }
  }
  if (body.length > 0 && control / body.length >= 0.02) {
    return undefined;
  }

  const text = body.toString('utf8');

  // A fatal decode check: re-encoding a valid string round-trips. Mojibake
  // from invalid UTF-8 does not.
  if (!Buffer.from(text, 'utf8').equals(body)) {
    return undefined;
  }

  return text;
}

/**
 * Files that must never be inlined into a prompt.
 *
 * Inlining sends contents to Antigravity's servers, so a mistaken or
 * manipulated path turns "analyse this file" into credential exfiltration that
 * looks like normal operation. `processFiles` classifies .env as 'config' and
 * rejects it today, but this guard sits at the point of actual disclosure so
 * the protection does not depend on every caller filtering first -- and it
 * still covers names that pass a type filter, such as secrets.txt.
 */
const SECRET_FILE_PATTERNS = [
  /^\.env(\..*)?$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)$/i,
  /^credentials(\..*)?$/i,
  /^secrets?\.[a-z0-9]+$/i,
  /\.(pem|key|pfx|p12|keystore|jks)$/i,
];

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
  async execute(
    task: AntigravityTask,
    options: { workspaceRoot?: string } = {}
  ): Promise<LayerResult> {
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

        const prompt = this.extractPrompt(task, options.workspaceRoot);
        if (!prompt.trim()) {
          throw new Error('No prompt provided for Antigravity CLI execution');
        }

        // Check cache for search-enabled tasks (CGMB unique feature)
        if (task.useSearch !== false) {
          const cachedResult = await this.searchCache.get(prompt, 'antigravity');
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
          }, 'antigravity', duration);
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
   * Process files (basic support for text files)
   */
  /**
   * @param workspaceRoot Root the files must live under. Callers that received
   * the path from a human -- the CLI, where naming the file *is* the
   * authorisation -- may widen this. Callers handling untrusted input (MCP
   * requests) should pass their declared workingDirectory, or omit it to get
   * the process working directory.
   */
  async processFiles(
    files: FileReference[],
    prompt: string,
    workspaceRoot?: string
  ): Promise<MultimodalResult> {
    // One admission test, not two.
    //
    // This used to accept only type==='text' or a .txt/.md suffix, while
    // extractPrompt accepts anything that is not a known binary format and
    // decodes as text. The CLI sets type:'document' for `-f`, so
    // `cgmb gemini -f module.ts` failed here with "only supports text files"
    // even though the layer can read it perfectly well. Reusing the same
    // predicate keeps the two paths from disagreeing again.
    const textFiles = files.filter(isInlinableTextFile);

    if (textFiles.length === 0) {
      throw new Error(
        'None of the requested files are text. The Antigravity CLI layer cannot read binary ' +
        'formats; use the AI Studio layer for PDF, Office and image files.'
      );
    }

    logger.debug('Processing text files with Antigravity CLI', {
      fileCount: textFiles.length,
      promptLength: prompt.length,
    });

    const result = await this.execute(
      { type: 'multimodal', prompt, files: textFiles },
      ...(workspaceRoot === undefined ? [] : [{ workspaceRoot }])
    );

    return {
      content: result.data as string,
      success: true,
      files_processed: textFiles.map(f => f.path),
      processing_time: result.metadata?.duration ?? 0,
      workflow_used: 'analysis' as const,
      layers_involved: ['antigravity'] as const,
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

      const child = spawn(this.agyPath, args, {
        // stdin carries the prompt and is closed immediately: agy drains it to
        // EOF before producing output, so an idle pipe would hang forever.
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: workspaceDir,
        env: this.buildChildEnv(),
        ...(isWindows ? { windowsHide: true } : {}),
      });

      child.stdin.on('error', () => {
        // The child may exit before reading stdin; the close handler reports
        // the real failure.
      });
      child.stdin.end(prompt);

      let stdout = '';
      let stderr = '';
      let settled = false;

      // Remove the scratch directory once the child is gone, whatever the
      // outcome. Anything agy wrote there belongs to this request alone.
      const cleanupWorkspace = (): void => {
        try {
          rmSync(workspaceDir, { recursive: true, force: true });
        } catch (error) {
          logger.debug('Could not remove Antigravity workspace directory', {
            workspaceDir,
            error: (error as Error).message,
          });
        }
      };

      child.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr?.on('data', (data) => {
        stderr += data.toString();
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
  private extractPrompt(task: AntigravityTask, workspaceRootOverride?: string): string {
    const prompt = task.prompt ?? task.request ?? task.input ?? '';

    if (!task.files || task.files.length === 0) {
      return prompt;
    }

    // File contents must be inlined, not referenced by path.
    //
    // This used to pass only the prompt and drop task.files silently, so
    // `cgmb analyze` falling back from AI Studio asked the CLI to summarise
    // documents it had never been given. agy answered "which documents?" and
    // the caller reported "Analysis complete" -- a confident non-answer.
    // Paths cannot work either: the CLI runs in an empty scratch directory
    // with no access to the caller's files, by design.
    const sections: string[] = [];
    let used = 0;

    // Files must live under this root. Defaults to the process working
    // directory, which is the project the operator invoked CGMB from; MCP
    // callers should pass their declared workingDirectory instead.
    // The root is a code-level argument, never a field on the task.
    //
    // It used to be read from task.workspaceRoot -- but workflow steps spread
    // arbitrary caller-supplied input into the task, so an MCP caller could set
    // workspaceRoot to a drive root and read anything on the machine. The
    // control was bypassable by exactly the threat it existed to stop. Only
    // trusted code paths (the CLI's explicit -f, a server-validated
    // workingDirectory) may pass an override.
    const requestedRoot = workspaceRootOverride?.trim()
      ? workspaceRootOverride
      : process.cwd();

    let workspaceRoot: string;
    try {
      workspaceRoot = realpathSync(requestedRoot);
    } catch (error) {
      throw new Error(
        `Could not resolve the workspace root ${requestedRoot}: ${(error as Error).message}`
      );
    }

    for (const file of task.files) {
      // Resolve symlinks first: a link innocuously named notes.txt can point at
      // a credential file, and every check below would otherwise judge the link
      // rather than what is actually about to be transmitted.
      let resolvedPath: string;
      try {
        resolvedPath = realpathSync(file.path);
      } catch (error) {
        throw new Error(
          `Could not resolve ${file.path} for Antigravity CLI processing: ${(error as Error).message}`
        );
      }

      // Confine reads to the workspace root.
      //
      // The name denylist alone was never sufficient: it cannot enumerate every
      // credential file, and anything readable outside the workspace --
      // application_default_credentials.json, source trees, an unrelated
      // repository -- could be inlined and transmitted on the strength of a
      // caller-supplied absolute path. A prompt-injected MCP caller is exactly
      // the threat. Root confinement is the primary control; the denylist stays
      // as a second line for files inside the workspace.
      const relative = relativePath(workspaceRoot, resolvedPath);
      if (relative.startsWith('..') || isAbsolute(relative)) {
        throw new Error(
          `Refusing to send ${basename(file.path)} to the Antigravity CLI: it resolves to ` +
          `${resolvedPath}, outside the workspace root ${workspaceRoot}. ` +
          `Pass a workspaceRoot that contains the file if this is intended.`
        );
      }

      // Credentials are checked before file type so the refusal names the real
      // reason. A .env would otherwise be rejected merely as "not a text
      // format", which tells the operator nothing about why it matters.
      for (const candidate of [basename(file.path), basename(resolvedPath)]) {
        if (SECRET_FILE_PATTERNS.some(pattern => pattern.test(candidate))) {
          throw new Error(
            `Refusing to send ${candidate} to the Antigravity CLI: it matches a credential file pattern. ` +
            `File contents are transmitted to Antigravity's servers.`
          );
        }
      }

      // Only ever inline formats that are actually text.
      //
      // Reading a PDF or DOCX as UTF-8 yields mojibake, and the CLI answers it
      // as if it were a document -- a plausible, wrong summary reported as
      // success. LayerManager hands the original file list to this layer when
      // AI Studio fails, so binaries genuinely arrive here.
      if (!isInlinableTextFile(file)) {
        throw new Error(
          `The Antigravity CLI layer cannot read ${basename(file.path)}. ` +
          `Only plain-text formats can be inlined; use the AI Studio layer for PDF, Office and image files.`
        );
      }

      // One file descriptor, and every check bound to that handle.
      //
      // Two rounds of narrowing led here. Validating the path with realpathSync
      // and then re-opening it left a window in which a concurrent process
      // could swap the file -- or an ancestor directory -- for a symlink to a
      // secret: the name and root checks had passed against the old target
      // while open() followed the new one. Checking fstat and reading through
      // the same descriptor closes the fstat/read race, and re-deriving the
      // real path *from the open handle* closes the resolve/open race, because
      // that path describes the object actually opened.
      let fd: number;
      try {
        fd = openSync(resolvedPath, 'r');
      } catch (error) {
        throw new Error(
          `Could not read ${file.path} for Antigravity CLI processing: ${(error as Error).message}`
        );
      }

      let bytes: Buffer;
      try {
        const stats = fstatSync(fd);

        if (!stats.isFile()) {
          throw new Error(
            `${basename(file.path)} is not a regular file and will not be sent to the Antigravity CLI.`
          );
        }

        // Re-verify against what was actually opened, not what was resolved
        // earlier. A swap between resolve and open changes this result.
        const openedPath = realpathSync(resolvedPath);
        if (openedPath !== resolvedPath) {
          throw new Error(
            `${basename(file.path)} changed while it was being opened; refusing to send it.`
          );
        }

        const openedRelative = relativePath(workspaceRoot, openedPath);
        if (openedRelative.startsWith('..') || isAbsolute(openedRelative)) {
          throw new Error(
            `Refusing to send ${basename(file.path)}: it resolves to ${openedPath}, ` +
            `outside the workspace root ${workspaceRoot}.`
          );
        }

        if (SECRET_FILE_PATTERNS.some(pattern => pattern.test(basename(openedPath)))) {
          throw new Error(
            `Refusing to send ${basename(openedPath)} to the Antigravity CLI: it matches a ` +
            `credential file pattern.`
          );
        }

        if (stats.size > MAX_INLINED_FILE_BYTES) {
          throw new Error(
            `${basename(file.path)} is ${stats.size} bytes, over the ` +
            `${MAX_INLINED_FILE_BYTES}-byte limit for a single inlined file. ` +
            `Split the document or use the AI Studio layer.`
          );
        }

        // Read to EOF, one byte past the limit.
        //
        // readSync may return fewer bytes than requested before EOF -- normal
        // on network and FUSE filesystems -- so a single call could hand the
        // model the first fragment of a document and report success. Loop until
        // it returns 0.
        const buffer = Buffer.allocUnsafe(MAX_INLINED_FILE_BYTES + 1);
        let total = 0;
        for (;;) {
          const read = readSync(fd, buffer, total, buffer.length - total, total);
          if (read === 0) {
            break;
          }
          total += read;
          if (total >= buffer.length) {
            break;
          }
        }

        if (total > MAX_INLINED_FILE_BYTES) {
          throw new Error(
            `${basename(file.path)} grew past the ${MAX_INLINED_FILE_BYTES}-byte limit while being read.`
          );
        }

        if (total !== stats.size) {
          // Shrunk or grew mid-read: the content is not what was validated.
          throw new Error(
            `${basename(file.path)} changed size while being read ` +
            `(expected ${stats.size} bytes, read ${total}); refusing to send it.`
          );
        }

        bytes = Buffer.from(buffer.subarray(0, total));
      } finally {
        closeSync(fd);
      }

      {
        // A permitted name is not proof of text: inspect the actual bytes.
        // Answering mojibake produces a confident summary of noise.
        const decoded = decodeAsText(bytes);
        if (decoded === undefined) {
          throw new Error(
            `${basename(file.path)} is not text this layer can decode and will not be sent to the ` +
            `Antigravity CLI. Use the AI Studio layer for binary formats.`
          );
        }

        const content = decoded;

        if (content.length > MAX_INLINED_FILE_CHARS) {
          // Do not truncate silently: a summary or comparison built from part
          // of a document is wrong in a way the caller cannot see.
          throw new Error(
            `${basename(file.path)} is ${content.length} characters, over the ` +
            `${MAX_INLINED_FILE_CHARS}-character limit for a single inlined file. ` +
            `Split the document or use the AI Studio layer.`
          );
        }

        used += content.length;

        if (used > MAX_TOTAL_INLINED_CHARS) {
          // Likewise for the combined budget. Previously the loop logged a
          // warning and broke, so files silently never reached the model while
          // the caller still received a successful-looking answer.
          throw new Error(
            `The requested files total more than ${MAX_TOTAL_INLINED_CHARS} characters, ` +
            `which exceeds what one Antigravity CLI request can carry. ` +
            `Send fewer files per request.`
          );
        }

        sections.push(`--- FILE: ${basename(file.path)} ---\n${content}`);
      }
    }

    return `${prompt}\n\n${sections.join('\n\n')}`;
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
      const result = await this.execute({
        type: 'translation',
        prompt: translationPrompt,
        useSearch: false, // No web search needed for translation
        model: this.DEFAULT_MODEL
      });

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
      logger.error('Translation failed, using original text', {
        error: error instanceof Error ? error.message : String(error),
        sourceLang,
        length: text.length,
      });

      // Fallback to original text if translation fails
      return text;
    }
  }
}
