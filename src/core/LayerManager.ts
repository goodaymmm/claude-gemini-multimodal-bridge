import { readFileSync, statSync } from 'fs';
import { basename } from 'path';
import { ClaudeCodeLayer } from '../layers/ClaudeCodeLayer.js';
import { AntigravityCLILayer } from '../layers/AntigravityCLILayer.js';
import { AIStudioLayer } from '../layers/AIStudioLayer.js';
import { logger } from '../utils/logger.js';
import { safeExecute } from '../utils/errorHandler.js';
import {
  allowedRoots,
  CGMBError,
  checkAgainstRoots,
  Config,
  errorForLog,
  ExecutionPlan,
  FileReference,
  isWithinRoots,
  LayerResult,
  LayerType,
  ProcessingOptions,
  shownPath,
  WorkflowResult,
  WorkflowStep,
  WorkflowType,
  WorkloadAnalysis,
} from './types.js';
import { taskFileRefs } from './types.js';
import { normalizeLayerName } from './types.js';
import {
  hasAudioGenerationIntent,
  hasCodeIntent,
  hasImageGenerationIntent,
  hasReasoningIntent,
  hasSearchIntent,
  hasWorkflowIntent,
  type RouteKind,
  urlKind,
} from './routing.js';

/**
 * Names that must not be transmitted to Google, checked at the AI Studio
 * boundary.
 *
 * Deliberately a name check and nothing more. The workspace-confinement and
 * canonicalisation machinery this replaces refused legitimate paths outside the
 * working directory -- `cgmb analyze ~/docs/report.pdf` is the product's main
 * use, not an attack -- and needed a trusted-context argument threaded through
 * every routing method to work at all. A denylist costs neither: no ordinary
 * request analyses a .env, so nothing legitimate is lost.
 *
 * Matched on the basename only. A symlink pointing at a credential file is out
 * of scope by design: resolving it is what dragged in realpath, TOCTOU handling
 * and the identity checks that made the previous version untenable.
 */
const CREDENTIAL_FILE_PATTERNS = [
  /^\.env(\..*)?$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)$/i,
  /^credentials(\..*)?$/i,
  /^secrets?\.[a-z0-9]+$/i,
  /\.(pem|key|pfx|p12|keystore|jks)$/i,
];

/**
 * Refuse a task that names anything credential-shaped.
 *
 * Goes through taskFileRefs so it sees both the `files` and `documents` keys --
 * see that function for why the codebase has two.
 */
export function assertNoCredentialFiles(task: unknown): void {
  for (const file of taskFileRefs(task)) {
    // basename() handles both separators, so no path parsing is needed here.
    //
    // Both names are checked. Since 6262c4b `path` is the realpath the roots
    // check verified and `givenPath` is the name the caller used; a symlink
    // can make either one credential-shaped while the other is not
    // (`.env -> config/dev.vars`, or `notes.txt -> .env`), and a file is
    // refused when either name matches.
    const names = [basename(file.path)];
    if (file.givenPath && basename(file.givenPath) !== names[0]) {
      names.push(basename(file.givenPath));
    }
    const name = names.find(candidate => CREDENTIAL_FILE_PATTERNS.some(pattern => pattern.test(candidate)));
    if (name !== undefined) {
      throw new CGMBError(
        `Refusing to process ${name}: it matches a credential file pattern, and the AI Studio ` +
        `layer transmits file contents to Google.`,
        'CREDENTIAL_FILE_REFUSED'
      );
    }
  }
}

// ===================================
// Layer Manager - Orchestrates all three layers
// ===================================

export interface ExecutionOptions {
  executionMode: 'sequential' | 'parallel' | 'adaptive';
  timeout?: number;
  maxRetries?: number;
}

/**
 * Task complexity and routing analysis
 */
interface TaskAnalysis {
  complexity: 'low' | 'medium' | 'high';
  hasFiles: boolean;
  fileTypes: string[];
  needsCurrentInfo: boolean;
  isGenerationTask: boolean;
  isCodeRelated: boolean;
  estimatedTokens: number;
  preferredLayer: LayerType;
  reasoning: string;
}

/**
 * Where a request goes, decided once by LayerManager.decideRoute() and acted on
 * by executeRoute() (or, for URLs and multi-file work, by the caller).
 */
export interface RouteDecision {
  kind: RouteKind;
  /** The layer that answers first. For 'web_and_files' the URL half; the files go to AI Studio. */
  layer: LayerType;
  reason: string;
  /** PDF / image / audio URLs found in the request. */
  fileUrls: string[];
  /** Web page URLs found in the request. */
  webUrls: string[];
}

/** A task handed to executeRoute(): the prompt, the files, and anything a layer reads. */
export interface RoutedTask {
  prompt?: string;
  instructions?: string;
  request?: string;
  type?: string;
  files?: unknown;
  documents?: unknown;
  options?: Record<string, unknown>;
  [key: string]: unknown;
}

/** What decideRoute() looks at. */
export interface RouteInput {
  prompt: string;
  /** Local files (not URLs). */
  files?: readonly FileReference[];
  /** URLs found in the prompt or passed as files. */
  urls?: readonly string[];
  /** A caller that already knows it wants a search passes 'search'. */
  taskType?: string;
}

/**
 * How much source code the Claude layer is given inline.
 *
 * Claude Code runs headless in CGMB's own package directory, where its
 * permissions allow reading CGMB's sources and nothing of the user's -- so a
 * code file has to travel in the prompt. 200 KB is roughly 50k tokens: a large
 * module or a handful of small ones. Above it the files go to AI Studio, which
 * reads them through the File API path like any other document.
 */
export const CLAUDE_INLINE_MAX_BYTES = 200 * 1024;
const CLAUDE_INLINE_MAX_FILES = 10;

/** Local paths written into a prompt (Windows and POSIX, absolute or ./relative). */
const EMBEDDED_PATH = /(?:[A-Za-z]:\\[^\s"'<>|]+\.[a-zA-Z0-9]+|\/(?!https?:)[^\s"'<>|]+\.[a-zA-Z0-9]+|\.\.?\/[^\s"'<>|]+\.[a-zA-Z0-9]+)/i;

/**
 * What a step reference looks like: `@`, a step id, then optionally a dotted
 * path into its published output -- `@s1`, `@s1.output`, `@s1.output.items`.
 *
 * Anything else that happens to start with `@` -- `@scope/pkg`, `@here is the
 * text`, an e-mail handle -- is ordinary input. It used to be read as a
 * reference too: it became a `_stepMissing` marker in place of the text, and
 * the whole string went to a warn log.
 */
const STEP_REFERENCE = /^@([A-Za-z0-9_-]+)((?:\.[A-Za-z0-9_-]+)*)$/;

/** Mark a result as answered by a fallback layer, so the caller can say so. */
function markFallback(result: LayerResult, from: LayerType, reason: string): LayerResult {
  if (result.metadata?.fallback_from) {
    return result;
  }
  return {
    ...result,
    metadata: {
      ...result.metadata,
      fallback_from: normalizeLayerName(from) as 'claude' | 'antigravity' | 'aistudio',
      fallback_reason: reason,
    },
  };
}

/** Why the Claude layer cannot take these files: it reads source code inline only. */
function claudeCannotRead(count: number): CGMBError {
  return new CGMBError(
    `The Claude layer cannot read files (${count} attached). It reads source code files only ` +
    `(up to ${CLAUDE_INLINE_MAX_FILES} files, ${CLAUDE_INLINE_MAX_BYTES / 1024} KB in total). ` +
    'Send other file work to the aistudio layer, or omit the layer to let CGMB route it.',
    'LAYER_CANNOT_READ_FILES'
  );
}

export class LayerManager {
  private claudeLayer: ClaudeCodeLayer | null = null;
  private antigravityLayer: AntigravityCLILayer | null = null;
  private aiStudioLayer: AIStudioLayer | null = null;
  private config: Config;
  private layerInitialized: {
    claude: boolean;
    antigravity: boolean;
    aistudio: boolean;
  } = {
    claude: false,
    antigravity: false,
    aistudio: false
  };

  // Promise cache for async layer initialization
  private claudeLayerPromise: Promise<ClaudeCodeLayer> | null = null;
  private antigravityLayerPromise: Promise<AntigravityCLILayer> | null = null;
  private aiStudioLayerPromise: Promise<AIStudioLayer> | null = null;

  constructor(config: Config) {
    this.config = config;
    // Layers are now created on-demand (lazy loading)
  }

  /**
   * Get Claude layer with lazy initialization
   */
  public getClaudeLayer(): ClaudeCodeLayer {
    if (!this.claudeLayer) {
      logger.info('Lazy initializing Claude Code layer');
      this.claudeLayer = new ClaudeCodeLayer(this.config?.claude?.code_path);
      if (!this.layerInitialized.claude) {
        // Initialize only when first accessed
        this.claudeLayer.initialize().then(() => {
          this.layerInitialized.claude = true;
          logger.info('Claude Code layer initialized via lazy loading');
        }).catch(error => {
          logger.error('Failed to initialize Claude Code layer', { error: errorForLog(error) });
        });
      }
    }
    return this.claudeLayer;
  }

  /**
   * Get Antigravity layer with lazy initialization
   */
  public getAntigravityLayer(): AntigravityCLILayer {
    if (!this.antigravityLayer) {
      logger.info('Lazy initializing Antigravity CLI layer');
      this.antigravityLayer = new AntigravityCLILayer();
      // Antigravity layer doesn't require initialization for fast path
    }
    return this.antigravityLayer;
  }

  /**
   * @deprecated Renamed to getAntigravityLayer(). Kept because LayerManager is
   * a public export and this method was public before the Antigravity rename --
   * removing it outright breaks compilation for TypeScript consumers and throws
   * TypeError for JavaScript ones. Returns the same instance; scheduled for
   * removal in the next major release.
   */
  public getGeminiLayer(): AntigravityCLILayer {
    return this.getAntigravityLayer();
  }

  /**
   * @deprecated Renamed to getAntigravityLayerAsync(). See getGeminiLayer().
   * Returns the same shared initialization promise.
   */
  public async getGeminiLayerAsync(): Promise<AntigravityCLILayer> {
    return this.getAntigravityLayerAsync();
  }

  /**
   * Get AI Studio layer with lazy initialization
   */
  public getAIStudioLayer(): AIStudioLayer {
    if (!this.aiStudioLayer) {
      logger.info('Lazy initializing AI Studio layer');
      // Pass AntigravityCLILayer reference for translation functionality
      this.aiStudioLayer = new AIStudioLayer(this.getAntigravityLayer());
      if (!this.layerInitialized.aistudio) {
        // Initialize only when first accessed
        this.aiStudioLayer.initialize().then(() => {
          this.layerInitialized.aistudio = true;
          logger.info('AI Studio layer initialized via lazy loading');
        }).catch(error => {
          logger.error('Failed to initialize AI Studio layer', { error: errorForLog(error) });
        });
      }
    }
    return this.aiStudioLayer;
  }

  /**
   * Get Claude layer with guaranteed initialization (async)
   */
  public async getClaudeLayerAsync(): Promise<ClaudeCodeLayer> {
    if (!this.claudeLayerPromise) {
      this.claudeLayerPromise = (async () => {
        if (!this.claudeLayer) {
          logger.info('Async initializing Claude Code layer');
          this.claudeLayer = new ClaudeCodeLayer(this.config?.claude?.code_path);
        }
        if (!this.layerInitialized.claude) {
          await this.claudeLayer.initialize();
          this.layerInitialized.claude = true;
          logger.info('Claude Code layer initialized (async)');
        }
        return this.claudeLayer;
      })();
    }
    return this.claudeLayerPromise;
  }

  /**
   * Get Antigravity layer with guaranteed initialization (async)
   */
  public async getAntigravityLayerAsync(): Promise<AntigravityCLILayer> {
    if (!this.antigravityLayerPromise) {
      this.antigravityLayerPromise = (async () => {
        if (!this.antigravityLayer) {
          logger.info('Async initializing Antigravity CLI layer');
          this.antigravityLayer = new AntigravityCLILayer();
        }
        if (!this.layerInitialized.antigravity) {
          await this.antigravityLayer.initialize();
          this.layerInitialized.antigravity = true;
          logger.info('Antigravity CLI layer initialized (async)');
        }
        return this.antigravityLayer;
      })();
    }
    return this.antigravityLayerPromise;
  }

  /**
   * Get AI Studio layer with guaranteed initialization (async)
   */
  public async getAIStudioLayerAsync(): Promise<AIStudioLayer> {
    if (!this.aiStudioLayerPromise) {
      this.aiStudioLayerPromise = (async () => {
        if (!this.aiStudioLayer) {
          logger.info('Async initializing AI Studio layer');
          // Ensure Antigravity layer is initialized first (needed for translation).
          // Use what the getter returns rather than re-reading the field and
          // asserting it: the getter is what guarantees the layer exists.
          const antigravity = await this.getAntigravityLayerAsync();
          this.aiStudioLayer = new AIStudioLayer(antigravity);
        }
        if (!this.layerInitialized.aistudio) {
          await this.aiStudioLayer.initialize();
          this.layerInitialized.aistudio = true;
          logger.info('AI Studio layer initialized (async)');
        }
        return this.aiStudioLayer;
      })();
    }
    return this.aiStudioLayerPromise;
  }

  /**
   * Fast processing for simple prompts (reference implementation style)
   * Bypasses heavy layer initialization and routing overhead
   */
  public async processSimpleFast(
    prompt: string,
    files?: FileReference[]
  ): Promise<LayerResult> {
    logger.info('Fast simple processing', {
      promptLength: prompt.length,
      hasFiles: !!files?.length,
      mode: 'fast'
    });

    try {
      // Use simplified execution directly on Antigravity layer (with async initialization)
      const antigravityLayer = await this.getAntigravityLayerAsync();
      const result = await antigravityLayer.execute({
        type: 'text_processing',
        prompt,
        files: files ?? [],
        useSearch: true // Enable search by default for current information
      });

      logger.info('Fast processing completed', {
        duration: result.metadata?.duration,
        success: result.success
      });

      return result;
    } catch (error) {
      logger.error('Fast processing failed', { error: errorForLog(error) });
      throw error;
    }
  }

  /**
   * Describe a task for routing and fallback decisions.
   *
   * preferredLayer comes from decideRoute() -- the one routing rule -- unless
   * the caller named a layer. This used to carry a priority chain of its own
   * whose "Priority 6: Complex reasoning or code -> Claude Code" could never be
   * reached: Priority 5 (`task.useSearch !== false`) was true for every task
   * that did not set useSearch, which is all of them.
   */
  public analyzeTask(task: any, userPreferredLayer?: LayerType): TaskAnalysis {
    const prompt = task.prompt || task.request || task.input || task.instructions || '';

    // Both keys, not just `files`. A document-analysis task carries `documents`,
    // so hasFiles was false for it: routing treated it as text, and the
    // capability filter in getFallbackOrder never fired -- which is how a
    // file-carrying request reached layers that cannot read files.
    const files = taskFileRefs(task);
    const fileTypes = files.map((f: FileReference) => f.type || this.detectFileType(f.path));
    const hasFiles = files.length > 0;
    const complexity = this.assessComplexity(prompt, files, task);
    const decision = this.decideRoute({ prompt, files, taskType: task.type });

    return {
      complexity,
      hasFiles,
      fileTypes,
      needsCurrentInfo: hasSearchIntent(prompt),
      isGenerationTask: hasImageGenerationIntent(prompt) || hasAudioGenerationIntent(prompt),
      isCodeRelated: hasCodeIntent(prompt) || decision.kind === 'code_files',
      estimatedTokens: Math.ceil(prompt.length / 4) + files.length * 100,
      preferredLayer: userPreferredLayer ?? decision.layer,
      reasoning: userPreferredLayer
        ? `User explicitly requested ${userPreferredLayer} layer`
        : decision.reason,
    };
  }

  /**
   * The routing rule: which layer a request goes to.
   *
   * The one place this is decided, for the MCP `cgmb` tool, the
   * `cgmb_multimodal_process` tool and the CLI. In order, first match wins:
   *
   *   1. URLs      PDF / image / audio URL -> AI Studio (with any local files);
   *                web page URL -> Antigravity; web page URL plus files ->
   *                both, the URL to Antigravity and the files to AI Studio.
   *   2. Files     source code only, small enough to inline -> Claude Code;
   *                anything else -> AI Studio.
   *   3. Image or audio generation wording -> AI Studio.
   *   4. Search or current-information wording -> Antigravity (it has the web).
   *   5. Reasoning or code wording -> Claude Code.
   *   6. Long (1,000+ characters) or multi-step wording, or a path the caller
   *      could not resolve -> the analysis workflow (Claude, AI Studio, Claude).
   *   7. Anything else -- a short question with none of the signals above, such
   *      as "Who wrote Hamlet?" -- -> Antigravity, the README's layer for
   *      information. It answers with web search, which is also what keeps a
   *      plain factual answer current.
   *
   * Generation and search sit above reasoning on purpose: "explain today's
   * news" needs the web before it needs reasoning, and "create audio saying
   * ..." is a request for audio whatever the words in it.
   */
  public decideRoute(input: RouteInput): RouteDecision {
    const prompt = input.prompt ?? '';
    const files = input.files ?? [];
    const urls = input.urls ?? [];
    const decision = (kind: RouteKind, layer: LayerType, reason: string, fileUrls: string[] = [], webUrls: string[] = []): RouteDecision =>
      ({ kind, layer, reason, fileUrls, webUrls });

    if (urls.length > 0) {
      const fileUrls = urls.filter(url => urlKind(url) !== 'web');
      const webUrls = urls.filter(url => urlKind(url) === 'web');
      if (webUrls.length === 0) {
        return decision('file_url', 'aistudio', 'PDF, image or audio URL - AI Studio reads the file', fileUrls, webUrls);
      }
      if (fileUrls.length === 0 && files.length === 0) {
        return decision('web_url', 'antigravity', 'Web page URL - Antigravity CLI reads the page', fileUrls, webUrls);
      }
      return decision('web_and_files', 'antigravity',
        'Web page URL plus files - Antigravity CLI reads the page, AI Studio reads the files', fileUrls, webUrls);
    }

    if (files.length > 0) {
      if (this.canInlineForClaude(files) !== null) {
        return decision('code_files', 'claude', 'Source code files - Claude Code for code analysis');
      }
      return decision('files', 'aistudio', 'Files - AI Studio reads images, audio and documents');
    }

    if (hasImageGenerationIntent(prompt)) {
      return decision('image_generation', 'aistudio', 'Image generation - AI Studio');
    }
    if (hasAudioGenerationIntent(prompt)) {
      return decision('audio_generation', 'aistudio', 'Audio generation - AI Studio');
    }
    if (input.taskType === 'search' || hasSearchIntent(prompt)) {
      return decision('search', 'antigravity', 'Search or current information - Antigravity CLI');
    }
    if (hasCodeIntent(prompt) || hasReasoningIntent(prompt)) {
      return decision('reasoning', 'claude', 'Reasoning or code - Claude Code');
    }
    if (prompt.length >= 1000 || hasWorkflowIntent(prompt) || EMBEDDED_PATH.test(prompt)) {
      return decision('workflow', 'claude', 'Long or multi-step request - analysis workflow led by Claude Code');
    }
    return decision('plain', 'antigravity', 'Short question with no reasoning, code or generation signal - Antigravity CLI');
  }

  /** What a URL points at: 'pdf', 'image', 'audio' or 'web'. */
  public detectUrlType(url: string): 'pdf' | 'image' | 'audio' | 'web' {
    return urlKind(url);
  }

  /** True when a file is source code (by extension). */
  private isSourceCodeFile(filePath: string): boolean {
    return this.detectFileType(filePath) === 'code';
  }

  /**
   * The realpaths of the files when every file is source code and together
   * they fit inline; null otherwise.
   *
   * Only source code: config, data and markup files are documents as far as
   * the README is concerned, and a credential-shaped name (.env, *.pem) is not
   * code in the first place.
   *
   * The paths returned are the ones checked against the roots and sized here:
   * inlineCodeFiles reads exactly these, rather than resolving the names
   * again (which could reach another file by then).
   */
  private canInlineForClaude(files: readonly FileReference[]): string[] | null {
    if (files.length === 0 || files.length > CLAUDE_INLINE_MAX_FILES) {
      return null;
    }
    // Classified by the name the caller used, not the symlink target's.
    if (!files.every(file => this.isSourceCodeFile(shownPath(file)))) {
      return null;
    }
    const resolved: string[] = [];
    let total = 0;
    for (const file of files) {
      // The roots check first, on the path as given: a stat outside the roots
      // would route an existing file differently from a missing one, and the
      // two routes answer differently. Anything not plainly inside goes to AI
      // Studio, which refuses it with the one message for both.
      const verdict = checkAgainstRoots(file.path, allowedRoots());
      if (verdict.kind !== 'inside') {
        return null;
      }
      try {
        total += statSync(verdict.resolved).size;
      } catch {
        // A file that cannot be stat'ed goes to AI Studio, which reports why.
        return null;
      }
      resolved.push(verdict.resolved);
    }
    return total <= CLAUDE_INLINE_MAX_BYTES ? resolved : null;
  }

  /**
   * Refuse a layer that cannot read the files it would be given.
   *
   * Only AI Studio reads files; Claude reads source code, inlined into its
   * prompt; the search layer reads none. Sending files anywhere else returned
   * an answer about a document nobody opened -- the MCP `targetLayer` path
   * refused that, the CLI `--layer` path did not.
   */
  public assertLayerCanReadFiles(layer: LayerType, files: readonly FileReference[]): void {
    if (files.length === 0) {
      return;
    }
    const target = normalizeLayerName(layer);
    if (target === 'aistudio') {
      return;
    }
    if (target === 'claude') {
      if (this.canInlineForClaude(files) !== null) {
        return;
      }
      throw claudeCannotRead(files.length);
    }
    throw new CGMBError(
      `The ${target} layer cannot read files (${files.length} attached). ` +
      'Send file work to the aistudio layer, or omit the layer to let CGMB route it.',
      'LAYER_CANNOT_READ_FILES'
    );
  }

  /**
   * Put source files into a prompt for the Claude layer.
   *
   * The same boundary as AI Studio: the contents leave the machine, so only
   * files under the directories the AI Studio server may read
   * (CGMB_ALLOWED_ROOTS) are inlined, credential-shaped names are refused, and
   * binary files are refused rather than sent as noise.
   *
   * `resolved` is what canInlineForClaude returned: the realpaths it checked
   * against the roots. They are read as they are -- checked against the roots
   * once more, but not resolved again.
   *
   * `shown` names them, index for index: the paths as the caller gave them
   * (shownPath). The `File:` header and the "not a text file" error use these,
   * never the realpath -- a link inside the roots does not reveal where it
   * points.
   */
  private async inlineCodeFiles(prompt: string, resolved: readonly string[], shown: readonly string[]): Promise<string> {
    const roots = allowedRoots();
    const sections: string[] = [];
    let total = 0;

    for (const [index, realPath] of resolved.entries()) {
      if (!isWithinRoots(realPath, roots.real)) {
        throw claudeCannotRead(resolved.length);
      }
      const name = shown[index];
      if (name === undefined) {
        throw claudeCannotRead(resolved.length);
      }
      const content = readFileSync(realPath, 'utf8');
      if (content.includes('\u0000')) {
        throw new CGMBError(`${basename(name)} is not a text file; the Claude layer reads source code only.`, 'LAYER_CANNOT_READ_FILES');
      }
      total += Buffer.byteLength(content, 'utf8');
      if (total > CLAUDE_INLINE_MAX_BYTES) {
        throw new CGMBError(
          `The code files exceed the ${CLAUDE_INLINE_MAX_BYTES / 1024} KB the Claude layer is given inline. ` +
          'Send them to the aistudio layer, or fewer at a time.',
          'LAYER_CANNOT_READ_FILES'
        );
      }
      const longestFence = Math.max(0, ...(content.match(/`+/g) ?? []).map(run => run.length));
      const fence = '`'.repeat(Math.max(3, longestFence + 1));
      sections.push(`File: ${name}\n${fence}\n${content}${content.endsWith('\n') ? '' : '\n'}${fence}`);
    }

    return `${prompt}\n\n` +
      `The ${resolved.length === 1 ? 'file below is' : `${resolved.length} files below are`} attached to this request. ` +
      'Their full contents are included here; answer from them.\n\n' +
      sections.join('\n\n');
  }

  /**
   * Carry out a route decision for the routes that end in one layer.
   *
   * Fallback, where there is one, is the CLI's (getFallbackOrder): a text
   * request that fails on its layer moves to the next one that can answer it,
   * a file request never moves to a layer that cannot read the file, and a
   * generation request does not fall back at all -- the other layers cannot
   * make an image, and an answer in its place would be an unrelated one. When
   * every layer fails, the error names each of them.
   */
  public async executeRoute(decision: RouteDecision, task: RoutedTask): Promise<LayerResult> {
    const prompt = task.prompt || task.instructions || task.request || '';
    const files = taskFileRefs(task);
    const options = task.options ?? {};

    logger.info('Routing decision', { route: decision.kind, layer: decision.layer, reason: decision.reason });

    switch (decision.kind) {
      case 'image_generation':
        return this.executeWithLayer('aistudio', { type: 'image_generation', action: 'generate_image', prompt, files: [] });

      case 'audio_generation':
        return this.executeWithLayer('aistudio', { type: 'audio_generation', action: 'generate_audio', prompt, files: [] });

      case 'search':
      case 'plain':
        return this.executeTextWithFallback('antigravity', {
          type: decision.kind === 'search' ? 'search' : 'text_processing',
          prompt,
          files: [],
          options,
          useSearch: true,
        });

      case 'reasoning':
      case 'workflow':
        return this.executeTextWithFallback('claude', { type: 'text_processing', prompt, files: [], options });

      case 'code_files':
        return this.executeCodeFilesOnClaude({ ...task, prompt, files, options }, { fallback: true });

      default:
        try {
          const result = await this.executeWithLayer(decision.layer, task);
          if (result.success === false) {
            throw new Error(result.error ?? `The ${decision.layer} layer returned no result`);
          }
          return result;
        } catch (error) {
          logger.warn('Primary layer execution failed, attempting fallback', {
            primaryLayer: decision.layer,
            error: errorForLog(error),
          });
          return this.executeWithFallback(task, decision.layer, error as Error);
        }
    }
  }

  /**
   * Run a text-only request on `primary`, falling back as the CLI does.
   *
   * Claude Code is optional: when it is not installed or not signed in, the
   * request goes to the Antigravity CLI instead, with an info line on stderr.
   */
  private async executeTextWithFallback(primary: 'claude' | 'antigravity', task: RoutedTask): Promise<LayerResult> {
    if (primary === 'claude') {
      try {
        await this.getClaudeLayerAsync();
      } catch (error) {
        const reason = (error as Error).message;
        logger.info('Claude Code is not available; answering with the Antigravity CLI instead', { reason });
        const result = await this.executeTextWithFallback('antigravity', { ...task, useSearch: true });
        return markFallback(result, 'claude', `Claude Code is not available: ${reason}`);
      }
    }

    try {
      const result = await this.executeWithLayer(primary, task);
      if (result.success === false) {
        throw new Error(result.error ?? `The ${primary} layer returned no result`);
      }
      return result;
    } catch (error) {
      logger.warn(`The ${primary} layer failed; trying the next layer`, { error: errorForLog(error) });
      return this.executeWithFallback(task, primary, error as Error);
    }
  }

  /**
   * Answer about source code files with Claude Code, their text inlined.
   *
   * With `fallback`, a Claude that is unavailable or fails hands the original
   * files to AI Studio -- the only other layer that can read them. Without it
   * (an explicit layer choice) the failure is the answer.
   */
  private async executeCodeFilesOnClaude(task: RoutedTask, { fallback }: { fallback: boolean }): Promise<LayerResult> {
    const files = taskFileRefs(task);
    const prompt = task.prompt || task.instructions || task.request || 'Review this code.';

    // Checked on the original task: the inlined one carries no file list.
    assertNoCredentialFiles(task);

    if (fallback) {
      try {
        await this.getClaudeLayerAsync();
      } catch (error) {
        const reason = (error as Error).message;
        logger.info('Claude Code is not available; sending the code files to AI Studio instead', { reason });
        const result = await this.executeWithLayer('aistudio', task);
        if (result.success === false) {
          throw new Error(`Claude Code is not available (${reason}), and the aistudio layer failed: ${result.error ?? 'no result'}`);
        }
        return markFallback(result, 'claude', `Claude Code is not available: ${reason}`);
      }
    }

    // Resolved once, here: the files read are the files checked and sized.
    const resolved = this.canInlineForClaude(files);
    if (resolved === null) {
      throw claudeCannotRead(files.length);
    }
    const inlined = await this.inlineCodeFiles(prompt, resolved, files.map(shownPath));
    const claudeTask = { type: 'text_processing', prompt: inlined, files: [], options: task.options ?? {} };

    if (!fallback) {
      return this.executeWithLayer('claude', claudeTask);
    }
    try {
      const result = await this.executeWithLayer('claude', claudeTask);
      if (result.success === false) {
        throw new Error(result.error ?? 'The claude layer returned no result');
      }
      return result;
    } catch (error) {
      logger.warn('The claude layer failed on code files; trying AI Studio', { error: errorForLog(error) });
      return this.executeWithFallback(task, 'claude', error as Error);
    }
  }

  /**
   * Execute a task on the layer the router picks, or on the one the caller
   * named (task.options.preferredLayer, the CLI's --layer).
   *
   * A named layer that cannot read the attached files is an error, as it is
   * for the MCP tool's targetLayer.
   */
  public async executeWithOptimalLayer(
    task: any
  ): Promise<LayerResult> {
    const requested: unknown = task.options?.preferredLayer;
    const files = taskFileRefs(task);

    if (typeof requested === 'string' && requested !== '' && requested !== 'auto' && requested !== 'adaptive') {
      const layer = normalizeLayerName(requested) as LayerType;
      this.assertLayerCanReadFiles(layer, files);

      logger.info('Executing on the requested layer', { layer, fileCount: files.length });

      if (layer === 'claude' && files.length > 0) {
        return this.executeCodeFilesOnClaude(task, { fallback: true });
      }
      try {
        return await this.executeWithLayer(layer, task);
      } catch (error) {
        logger.warn('Primary layer execution failed, attempting fallback', {
          primaryLayer: layer,
          error: errorForLog(error),
        });
        return await this.executeWithFallback(task, layer, error as Error);
      }
    }

    const prompt: string = task.prompt || task.request || task.input || task.instructions || '';
    const decision = this.decideRoute({ prompt, files, taskType: task.type });

    logger.info('Optimal layer analysis completed', {
      route: decision.kind,
      preferredLayer: decision.layer,
      reasoning: decision.reason,
      hasFiles: files.length > 0,
    });

    return this.executeRoute(decision, task);
  }

  /**
   * Run a route on Claude with code files, without fallback. Used when a layer
   * was named explicitly (the MCP tool's targetLayer).
   */
  public async executeCodeFilesOnClaudeDirect(task: RoutedTask): Promise<LayerResult> {
    return this.executeCodeFilesOnClaude(task, { fallback: false });
  }

  /**
   * Execute task with specific layer
   */
  public async executeWithLayer(
    layerType: LayerType,
    task: any
  ): Promise<LayerResult> {
    // Checked before routing, for every layer.
    //
    // AI Studio is where the disclosure would happen -- its MCP server
    // readFileSync()s whatever path it is handed and sends the bytes to Google,
    // and unlike a local read the user never sees that leave. But guarding only
    // that branch made the refusal depend on routing: the analysis workflow
    // runs claude -> aistudio -> claude, so a request naming a credential file
    // was handed to the Claude layer twice before anything objected. Claude
    // never reads task.files, so nothing was disclosed, but the refusal should
    // not be contingent on which step happens to run first.
    assertNoCredentialFiles(task);

    switch (layerType) {
      case 'claude':
        const claudeLayer = await this.getClaudeLayerAsync();
        return await claudeLayer.execute(task);

      case 'gemini': // deprecated alias
      case 'antigravity':
        const antigravityLayer = await this.getAntigravityLayerAsync();
        return await antigravityLayer.execute(task);

      case 'aistudio':
        const aiStudioLayer = await this.getAIStudioLayerAsync();
        return await aiStudioLayer.execute(task);

      default:
        throw new Error(`Unknown layer type: ${layerType}`);
    }
  }

  /**
   * Execute with fallback strategy.
   *
   * Every layer tried is named in the error when all of them fail, with the
   * reason it failed: "All layers failed" alone did not say which layer to fix.
   * A successful fallback is marked (metadata.fallback_from), so a caller can
   * tell the answer did not come from the layer the request was meant for.
   */
  private async executeWithFallback(
    task: any,
    failedLayer: LayerType,
    primaryError?: Error
  ): Promise<LayerResult> {
    const fallbackOrder = this.getFallbackOrder(failedLayer, task);
    const primaryReason = primaryError?.message ?? 'failed';
    const failures: string[] = [];
    const textOnly = taskFileRefs(task).length === 0;

    for (const layerType of fallbackOrder) {
      try {
        // Ensure layer is initialized before attempting execution
        await this.ensureLayerInitialized(layerType);

        // Verify layer is actually ready
        if (!this.layerInitialized[layerType as keyof typeof this.layerInitialized]) {
          logger.warn(`Skipping ${layerType} - layer not initialized`, {
            originalLayer: failedLayer,
          });
          failures.push(`${layerType}: not initialized`);
          continue;
        }

        logger.info('Attempting fallback execution', {
          layer: layerType,
          originalLayer: failedLayer,
        });

        // A text request on AI Studio is answered as text. Its general path
        // guesses generation from the wording ("picture" + "make"), and a
        // search prompt that happens to say both would come back as an image.
        const fallbackTask = layerType === 'aistudio' && textOnly
          ? { ...task, action: 'answer_text' }
          : task;
        const result = await this.executeWithLayer(layerType, fallbackTask);
        if (result.success === false) {
          throw new Error(result.error ?? 'no result');
        }
        return markFallback(result, failedLayer, primaryReason);
      } catch (error) {
        logger.warn('Fallback layer also failed', {
          layer: layerType,
          error: errorForLog(error),
        });
        failures.push(`${layerType}: ${(error as Error).message}`);
        continue;
      }
    }

    if (fallbackOrder.length === 0) {
      // Reached when the task carries files and no remaining layer can read
      // them. Naming that explicitly beats "Fallbacks: " with an empty list.
      throw new Error(
        `The ${failedLayer} layer failed (${primaryReason}) and no fallback layer can process files. ` +
        `Only the AI Studio layer reads file contents; the search and Claude layers ` +
        `would answer from the prompt alone.`
      );
    }

    throw new Error(
      `The ${failedLayer} layer failed (${primaryReason}), and so did every fallback layer -- ` +
      failures.join('; ')
    );
  }

  /**
   * Layers that actually read task.files.
   *
   * Only AI Studio does. The Antigravity layer refuses them outright, and
   * ClaudeCodeLayer declares `files` on its task type but never reads it -- it
   * builds the prompt and nothing else. Falling back to either for a
   * file-carrying task produces an answer about documents that were never
   * opened, returned as success.
   */
  private static readonly FILE_CAPABLE_LAYERS: ReadonlySet<LayerType> = new Set(['aistudio']);

  /**
   * Get fallback order based on failed layer and task characteristics
   */
  private getFallbackOrder(failedLayer: LayerType, task: any): LayerType[] {
    const analysis = this.analyzeTask(task);

    const order = ((): LayerType[] => {
      switch (failedLayer) {
        case 'claude':
          // If Claude fails, try Gemini for search or AI Studio for files
          return analysis.hasFiles ? ['aistudio', 'antigravity'] : ['antigravity', 'aistudio'];

        case 'gemini': // deprecated alias
        case 'antigravity':
          // If Gemini fails, prefer AI Studio, then Claude for complex tasks only
          return analysis.complexity === 'high' ? ['aistudio', 'claude'] : ['aistudio', 'claude'];

        case 'aistudio':
          // If AI Studio fails, prefer Gemini for search, then Claude for complex tasks
          return analysis.complexity === 'high' ? ['antigravity', 'claude'] : ['antigravity', 'claude'];

        default:
          return ['aistudio', 'antigravity', 'claude'];
      }
    })();

    if (!analysis.hasFiles) {
      return order;
    }

    // Fallback for a file-carrying task must be capability-aware.
    //
    // executeWithFallback catches each layer's error and moves on, so the
    // Antigravity layer's refusal was swallowed and the task slid to Claude,
    // which answers from the prompt alone -- "Analysis complete" for a document
    // nobody read. Dropping incapable layers here makes the loop run out and
    // report the real failure instead.
    const capable = order.filter(layer => LayerManager.FILE_CAPABLE_LAYERS.has(layer));

    if (capable.length < order.length) {
      logger.debug('Dropped file-incapable layers from the fallback order', {
        failedLayer,
        considered: order,
        usable: capable,
      });
    }

    return capable;
  }

  /**
   * Ensure layer is properly initialized
   */
  private async ensureLayerInitialized(layerType: LayerType): Promise<void> {
    if (layerType in this.layerInitialized && !this.layerInitialized[layerType as keyof typeof this.layerInitialized]) {
      switch (layerType) {
        case 'claude':
          await this.getClaudeLayer().initialize();
          this.layerInitialized.claude = true;
          break;
        case 'aistudio':
          await this.getAIStudioLayer().initialize();
          this.layerInitialized.aistudio = true;
          break;
        case 'gemini': // deprecated alias
        case 'antigravity':
          await this.getAntigravityLayer().initialize();
          this.layerInitialized.antigravity = true;
          break;
      }
    }
  }

  /**
   * Detect file type from path
   * Public method for external access from CLI and other components
   */
  public detectFileType(path: string): string {
    const ext = path.toLowerCase().split('.').pop() || '';
    
    // Code files - prioritize for Claude Code layer
    if (['ts', 'js', 'jsx', 'tsx', 'py', 'java', 'cpp', 'c', 'cs', 'go', 'rs', 'rb', 'php', 'swift', 'kt', 'scala', 'clj', 'r', 'sh', 'bash', 'zsh', 'ps1'].includes(ext)) {return 'code';}
    
    // Configuration and data files - also good for Claude Code
    if (['json', 'yaml', 'yml', 'toml', 'ini', 'conf', 'env', 'dockerfile', 'makefile', 'cmake', 'gradle', 'package-lock.json', 'yarn.lock'].includes(ext)) {return 'config';}
    
    // Markup and template files - Claude Code can analyze these well
    if (['html', 'xml', 'svg', 'vue', 'svelte', 'handlebars', 'hbs', 'mustache', 'pug', 'ejs', 'liquid'].includes(ext)) {return 'markup';}
    
    // Stylesheet files
    if (['css', 'scss', 'sass', 'less', 'stylus'].includes(ext)) {return 'stylesheet';}
    
    // Database and SQL files
    if (['sql', 'sqlite', 'db'].includes(ext)) {return 'database';}
    
    // Media files - AI Studio is optimal
    if (['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'tiff', 'ico', 'svg'].includes(ext)) {return 'image';}
    if (['mp3', 'wav', 'm4a', 'flac', 'aac', 'ogg', 'wma'].includes(ext)) {return 'audio';}
    if (['mp4', 'mov', 'avi', 'webm', 'mkv', 'flv', 'wmv', '3gp'].includes(ext)) {return 'video';}
    
    // Document files - AI Studio for OCR and analysis
    if (['pdf'].includes(ext)) {return 'pdf';}
    if (['doc', 'docx', 'odt', 'rtf', 'pages'].includes(ext)) {return 'document';}
    if (['xls', 'xlsx', 'ods', 'csv', 'numbers'].includes(ext)) {return 'spreadsheet';}
    if (['ppt', 'pptx', 'odp', 'keynote'].includes(ext)) {return 'presentation';}
    
    // Text files - can be analyzed by any layer
    if (['txt', 'md', 'rst', 'log', 'readme', 'license', 'changelog'].includes(ext)) {return 'text';}
    
    return 'unknown';
  }

  /**
   * Assess task complexity
   */
  private assessComplexity(prompt: string, files: FileReference[], task: any): 'low' | 'medium' | 'high' {
    let score = 0;
    
    // Prompt length factor
    if (prompt.length > 2000) {score += 3;}
    else if (prompt.length > 500) {score += 2;}
    else if (prompt.length > 100) {score += 1;}
    
    // File count factor
    if (files.length > 5) {score += 3;}
    else if (files.length > 2) {score += 2;}
    else if (files.length > 0) {score += 1;}
    
    // Task type factor
    if (task.type === 'workflow' || task.action === 'orchestrate') {score += 3;}
    if (task.type === 'analysis' && files.length > 0) {score += 2;}
    
    // Complexity keywords
    const complexKeywords = [
      'analyze', 'compare', 'evaluate', 'synthesize', 'optimize',
      'complex', 'detailed', 'comprehensive', 'thorough', 'in-depth'
    ];
    
    const lowerPrompt = prompt.toLowerCase();
    const complexityMatches = complexKeywords.filter(keyword => lowerPrompt.includes(keyword)).length;
    score += complexityMatches;
    
    if (score >= 6) {return 'high';}
    if (score >= 3) {return 'medium';}
    return 'low';
  }

  /**
   * Initialize all layers (now optional - layers are initialized on demand)
   */
  public async initializeLayers(): Promise<void> {
    logger.info('Layer initialization is now on-demand. Skipping bulk initialization.');
    
    // This method is kept for backward compatibility but layers are now
    // initialized on first use for better performance
    logger.info('Layers will be initialized when first accessed');
  }

  /**
   * Process multimodal content using the optimal workflow
   */
  public async processMultimodal(
    prompt: string,
    files: FileReference[],
    workflow: WorkflowType,
    options?: ProcessingOptions
  ): Promise<WorkflowResult> {
    logger.info('LayerManager.processMultimodal called', {
      workflow,
      fileCount: files.length,
      promptLength: prompt.length,
      options: options ? Object.keys(options) : []
    });

    // One answer from one layer when the routing rule picks one.
    //
    // This was a "simple prompt" fast path that sent every file-less prompt
    // under 1,000 characters to the Antigravity CLI, whatever it asked -- so
    // "explain the difference between TCP and UDP" and "write a TypeScript
    // function" never reached Claude Code, which the README names for both.
    // decideRoute() is the same rule the MCP `cgmb` tool and the CLI use.
    if (workflow === 'analysis') {
      const decision = this.decideRoute({ prompt, files });
      if (['search', 'plain', 'reasoning', 'code_files'].includes(decision.kind)) {
        logger.info('Answering from one layer', { route: decision.kind, layer: decision.layer });
        const result = await this.executeRoute(decision, { prompt, files, options: options ?? {} });
        const layer = result.metadata?.layer ?? decision.layer;
        return {
          success: result.success,
          results: [result],
          metadata: {
            workflow: 'analysis',
            execution_mode: 'direct',
            total_duration: result.metadata?.duration || 0,
            steps_completed: result.success ? 1 : 0,
            steps_failed: result.success ? 0 : 1,
            layers_used: [layer],
            optimization: 'fast-path-bypass'
          }
        };
      }
    }

    // NEW: Fast path for single-file analysis - bypass 3-step workflow
    // This addresses WSL "1/3 success, 2/3 failed" issue by directly using AI Studio
    if (files.length > 0 && files.length <= 2 && workflow === 'analysis') {
      logger.info('Using single-file fast path for analysis', {
        fileCount: files.length,
        fileTypes: files.map(f => f.type || 'unknown')
      });

      try {
        // Routed through executeWithLayer so admission still applies.
        //
        // This called AIStudioLayer.execute() directly, so the workspace
        // confinement and credential-name checks added in the previous round
        // never ran for one- and two-file analyses -- the most common MCP
        // request. A file outside the workspace, or credentials.json, reached
        // the AI Studio MCP server and was sent onward. Placing the gate in
        // executeWithLayer only helps if every file-bearing path goes through it.
        const result = await this.executeWithLayer('aistudio', {
          type: 'multimodal_processing',
          action: 'analyze',
          prompt,
          files,
          options: options ?? {}
        });

        // Convert to WorkflowResult format
        return {
          success: result.success,
          results: [result],
          summary: result.success
            ? `File analysis completed successfully using AI Studio direct path.`
            : `File analysis failed: ${result.error || 'Unknown error'}`,
          metadata: {
            workflow: 'analysis',
            execution_mode: 'single-file-fast',
            total_duration: result.metadata?.duration || 0,
            steps_completed: result.success ? 1 : 0,
            steps_failed: result.success ? 0 : 1,
            layers_used: ['aistudio'],
            optimization: 'single-file-fast-path'
          }
        };
      } catch (error) {
        logger.warn('Single-file fast path failed, falling back to full workflow', {
          error: errorForLog(error),
          fileCount: files.length
        });
        // Continue to full workflow below
      }
    }

    // Create execution plan based on workflow type
    const executionPlan = await this.createWorkflowPlan(workflow, {
      prompt,
      files,
      options: options ?? {},
    });

    // Execute the workflow
    return this.executeWorkflow(
      executionPlan,
      { prompt, files },
      {
        executionMode: options?.execution_mode ?? 'adaptive',
        timeout: options?.timeout || 300000,
      }
    );
  }

  /**
   * Analyze documents using multi-layer approach
   */
  public async analyzeDocuments(
    documents: string[],
    analysisType: string,
    outputRequirements?: string,
    options?: ProcessingOptions
  ): Promise<WorkflowResult> {
    logger.info('Starting document analysis', {
      analysisType,
      documentCount: documents.length,
      outputRequirements,
    });

    const executionPlan: ExecutionPlan = {
      steps: [
        {
          id: 'preprocess',
          layer: 'claude',
          action: 'analyze_requirements',
          input: {
            documents,
            analysisType,
            outputRequirements,
          },
        },
        {
          id: 'document_processing',
          layer: 'aistudio',
          action: 'process_documents',
          input: {
            documents,
            analysisType,
            // The AI Studio layer reads `instructions` for this action. Without
            // it the request reached the model with nothing to ask.
            instructions: outputRequirements?.trim()
              ? outputRequirements
              : `Perform a ${analysisType} analysis of the attached documents.`,
            // Local text or upload, for each PDF; the server decides when unset.
            ...(options?.pdf_mode !== undefined && { pdf_mode: options.pdf_mode }),
          },
          dependsOn: ['preprocess'],
        },
        {
          id: 'synthesis',
          layer: 'claude',
          action: 'synthesize_analysis',
          input: {
            analysisResults: '@document_processing.output',
            requirements: outputRequirements,
          },
          dependsOn: ['document_processing'],
        },
      ],
      fallbackStrategies: {
        aistudio_unavailable: {
          replace: 'document_processing',
          with: {
            id: 'fallback_processing',
            layer: 'antigravity',
            action: 'analyze_documents',
            input: {
              documents,
              analysisType,
            },
          },
        },
      },
    };

    return this.executeWorkflow(executionPlan, { documents, analysisType }, {
      executionMode: options?.execution_mode ?? 'sequential',
      timeout: options?.timeout || 300000,
    });
  }

  /**
   * Execute a complete workflow across multiple layers
   */
  public async executeWorkflow(
    workflow: ExecutionPlan,
    inputData: Record<string, unknown>,
    options: ExecutionOptions
  ): Promise<WorkflowResult> {
    const startTime = Date.now();
    logger.info('Starting workflow execution', {
      stepsCount: workflow.steps.length,
      executionMode: options.executionMode,
    });

    // Checked before any step runs, and outside the try below so the caller
    // sees which step is wrong rather than "Workflow execution failed".
    this.validateWorkflowDependencies(workflow.steps);

    try {
      let results: Record<string, LayerResult>;

      switch (options.executionMode) {
        case 'sequential':
          results = await this.executeSequential(workflow, inputData, options);
          break;
        case 'parallel':
          results = await this.executeParallel(workflow, inputData, options);
          break;
        case 'adaptive':
          results = await this.executeAdaptive(workflow, inputData, options);
          break;
        default:
          throw new CGMBError(
            `Unknown execution mode: ${options.executionMode}`,
            'INVALID_EXECUTION_MODE'
          );
      }

      const totalDuration = Date.now() - startTime;
      const successful = Object.values(results).filter(r => r.success).length;
      const failed = Object.values(results).length - successful;

      logger.info('Workflow execution completed', {
        totalDuration,
        stepsCompleted: successful,
        stepsFailed: failed,
      });

      return {
        success: failed === 0,
        results,
        summary: this.generateWorkflowSummary(results),
        metadata: {
          total_duration: totalDuration,
          steps_completed: successful,
          steps_failed: failed,
          total_cost: this.calculateTotalCost(results),
        },
      };
    } catch (error) {
      const totalDuration = Date.now() - startTime;
      logger.error('Workflow execution failed', { error: errorForLog(error), totalDuration });
      
      throw new CGMBError(
        'Workflow execution failed',
        'WORKFLOW_EXECUTION_FAILED',
        undefined,
        { originalError: error, duration: totalDuration }
      );
    }
  }

  /**
   * Execute workflow steps sequentially
   */
  private async executeSequential(
    workflow: ExecutionPlan,
    inputData: Record<string, unknown>,
    options: ExecutionOptions
  ): Promise<Record<string, LayerResult>> {
    const results: Record<string, LayerResult> = {};
    const stepOutputs: Record<string, Record<string, unknown>> = {};
    const declaredSteps = this.declaredStepIds(workflow);

    // Sort steps by dependencies
    const sortedSteps = this.topologicalSort(workflow.steps);

    for (const step of sortedSteps) {
      try {
        // Prepare step input by resolving references
        const stepInput = this.resolveStepInput(step.input, stepOutputs, inputData, declaredSteps);
        
        // Execute step
        const result = await this.executeStep(step, stepInput, options);

        // A failed step must reach the fallback path.
        //
        // executeStep catches its own exceptions and returns success:false, so
        // the catch block below was only ever entered for errors it could not
        // handle -- meaning a declared fallback such as aistudio_unavailable
        // never ran, and later steps carried on with the failure as input.
        if (!result.success) {
          throw new CGMBError(
            result.error ?? `Step ${step.id} failed`,
            'STEP_FAILED',
            step.layer
          );
        }

        results[step.id] = result;

        if (result.data) {
          stepOutputs[step.id] = { output: result.data };
        }

        logger.debug(`Step ${step.id} completed`, {
          success: result.success,
          duration: result.metadata.duration,
        });
      } catch (error) {
        logger.error(`Step ${step.id} failed`, { error: errorForLog(error) });
        
        // Try fallback strategy if available
        const fallbackResult = await this.tryFallbackStrategy(
          step,
          workflow,
          error as Error,
          options
        );
        
        if (fallbackResult) {
          results[step.id] = fallbackResult;
          if (fallbackResult.success && fallbackResult.data) {
            stepOutputs[step.id] = { output: fallbackResult.data };
          }
        } else {
          results[step.id] = {
            success: false,
            error: (error as Error).message,
            metadata: {
              layer: step.layer,
              duration: 0,
            },
          };
        }
      }
    }

    return results;
  }

  /**
   * Execute independent workflow steps in parallel
   */
  private async executeParallel(
    workflow: ExecutionPlan,
    inputData: Record<string, unknown>,
    options: ExecutionOptions
  ): Promise<Record<string, LayerResult>> {
    const results: Record<string, LayerResult> = {};

    // What later steps see. Passing `results` straight in looked equivalent and
    // was not: a LayerResult has no `output`, so every `@step.output` reference
    // in a parallel workflow resolved to undefined and the downstream step ran
    // with no upstream data -- then reported success, because it returned
    // something of its own. Only sequential ever published the right shape.
    const stepOutputs: Record<string, Record<string, unknown>> = {};
    const declaredSteps = this.declaredStepIds(workflow);

    // Group steps by dependency level
    const dependencyLevels = this.groupStepsByDependencies(workflow.steps);

    for (const level of dependencyLevels) {
      const promises = level.map(async (step) => {
        try {
          const stepInput = this.resolveStepInput(step.input, stepOutputs, inputData, declaredSteps);
          const result = await this.executeStep(step, stepInput, options);
          return { stepId: step.id, result };
        } catch (error) {
          logger.error(`Step ${step.id} failed in parallel execution`, { error: errorForLog(error) });
          return {
            stepId: step.id,
            result: {
              success: false,
              error: (error as Error).message,
              metadata: {
                layer: step.layer,
                duration: 0,
              },
            },
          };
        }
      });

      const levelResults = await Promise.all(promises);
      levelResults.forEach(({ stepId, result }) => {
        results[stepId] = result;
        stepOutputs[stepId] = this.publishedOutput(result);
      });
    }

    return results;
  }

  /**
   * Execute workflow adaptively based on workload analysis
   */
  private async executeAdaptive(
    workflow: ExecutionPlan,
    inputData: Record<string, unknown>,
    options: ExecutionOptions
  ): Promise<Record<string, LayerResult>> {
    // Analyze the workload to determine the best execution strategy
    const analysis = await this.analyzeWorkload(workflow, inputData);
    
    logger.info('Adaptive execution analysis', analysis);

    if (analysis.requiresComplexReasoning) {
      // Use Claude-heavy sequential approach
      return this.executeSequential(workflow, inputData, options);
    } else if (analysis.estimatedComplexity === 'low') {
      // Use parallel execution for simple tasks
      return this.executeParallel(workflow, inputData, options);
    } else {
      // Use hybrid approach
      return this.executeHybrid(workflow, inputData, options, analysis);
    }
  }


  /**
   * Analyze workload to determine optimal execution strategy
   */
  private async analyzeWorkload(
    workflow: ExecutionPlan,
    inputData: Record<string, unknown>
  ): Promise<WorkloadAnalysis> {
    // Simple heuristic-based analysis
    // In a more sophisticated implementation, this could use ML models
    
    const hasMultimodalFiles = inputData.files && Array.isArray(inputData.files) && inputData.files.length > 0;
    const hasComplexPrompt = inputData.prompt && typeof inputData.prompt === 'string' && inputData.prompt.length > 1000;
    const multipleSteps = workflow.steps.length > 3;
    
    // Detect generation requests (especially image/video/audio generation)
    const isGenerationRequest = this.detectGenerationRequest(typeof inputData.prompt === 'string' ? inputData.prompt : '', workflow);
    const isImageGeneration = this.detectImageGeneration(typeof inputData.prompt === 'string' ? inputData.prompt : '', workflow);
    const isAudioGeneration = this.detectAudioGeneration(typeof inputData.prompt === 'string' ? inputData.prompt : '', workflow);
    
    // Detect document processing tasks
    const isDocumentProcessing = this.detectDocumentProcessing(typeof inputData.prompt === 'string' ? inputData.prompt : '', inputData.files);
    
    const requiresComplexReasoning = hasComplexPrompt || multipleSteps;
    const requiresMultimodalProcessing = hasMultimodalFiles || isGenerationRequest;
    const requiresGrounding = false || 
      (typeof inputData.prompt === 'string' && (
        inputData.prompt.toLowerCase().includes('search') ||
        inputData.prompt.toLowerCase().includes('latest') ||
        inputData.prompt.toLowerCase().includes('current') ||
        inputData.prompt.toLowerCase().includes('today') ||
        inputData.prompt.toLowerCase().includes('weather') ||
        inputData.prompt.toLowerCase().includes('news') ||
        inputData.prompt.toLowerCase().includes('stock') ||
        inputData.prompt.toLowerCase().includes('now') ||
        inputData.prompt.toLowerCase().includes('recent') ||
        inputData.prompt.toLowerCase().includes('update') ||
        // Japanese keyword detection for grounding tasks:
        // 検索 (search), 最新 (latest), 今日 (today), 天気 (weather)
        // ニュース (news), 株価 (stock price), 現在 (now)
        inputData.prompt.includes('検索') ||
        inputData.prompt.includes('最新') ||
        inputData.prompt.includes('今日') ||
        inputData.prompt.includes('天気') ||
        inputData.prompt.includes('ニュース') ||
        inputData.prompt.includes('株価') ||
        inputData.prompt.includes('現在')
      ));

    let estimatedComplexity: 'low' | 'medium' | 'high' = 'low';
    
    if (multipleSteps && hasMultimodalFiles) {
      estimatedComplexity = 'high';
    } else if (hasComplexPrompt || hasMultimodalFiles || multipleSteps || isGenerationRequest) {
      estimatedComplexity = 'medium';
    }

    // Determine recommended layer with generation priority
    let recommendedLayer: LayerType = 'antigravity'; // Default to the Antigravity CLI for simple prompts
    
    // Check if this is a simple prompt (no files, no generation, no complex reasoning)
    const isSimplePrompt = !hasMultimodalFiles && !isGenerationRequest && !requiresComplexReasoning && !multipleSteps;
    
    // HIGHEST PRIORITY: Web search goes to the Antigravity CLI
    if (requiresGrounding && !hasMultimodalFiles) {
      recommendedLayer = 'antigravity';
      logger.info('Routing to Antigravity CLI for web search', {
        prompt: typeof inputData.prompt === 'string' ? inputData.prompt.substring(0, 100) + '...' : 'No prompt',
        requiresGrounding: true
      });
    } else if (isImageGeneration || isAudioGeneration || isGenerationRequest) {
      recommendedLayer = 'aistudio';
      logger.info('Routing to AI Studio for generation task', {
        isImageGeneration,
        isAudioGeneration,
        prompt: typeof inputData.prompt === 'string' ? inputData.prompt.substring(0, 100) + '...' : 'No prompt'
      });
    } else if (isDocumentProcessing) {
      // Document processing goes to AI Studio (AI_MODELS.DOCUMENT_PROCESSING)
      recommendedLayer = 'aistudio';
      logger.info('Routing to AI Studio for document processing', {
        hasFiles: hasMultimodalFiles,
        prompt: typeof inputData.prompt === 'string' ? inputData.prompt.substring(0, 100) + '...' : 'No prompt'
      });
    } else if (requiresComplexReasoning) {
      recommendedLayer = 'claude';
    } else if (requiresMultimodalProcessing) {
      recommendedLayer = 'aistudio';
    } else if (isSimplePrompt) {
      // Simple prompts go to the Antigravity CLI
      recommendedLayer = 'antigravity';
      logger.info('Routing simple prompt to Antigravity CLI', {
        promptLength: typeof inputData.prompt === 'string' ? inputData.prompt.length : 0,
        hasFiles: hasMultimodalFiles,
        requiresGrounding
      });
    }

    logger.info('Workload analysis completed', {
      hasMultimodalFiles,
      hasComplexPrompt,
      multipleSteps,
      isGenerationRequest,
      isImageGeneration,
      isAudioGeneration,
      isDocumentProcessing,
      isSimplePrompt,
      requiresComplexReasoning,
      requiresMultimodalProcessing,
      requiresGrounding,
      estimatedComplexity,
      recommendedLayer,
      prompt: typeof inputData.prompt === 'string' ? inputData.prompt.substring(0, 200) + '...' : 'No prompt'
    });

    return {
      requiresComplexReasoning: !!requiresComplexReasoning,
      requiresMultimodalProcessing: !!requiresMultimodalProcessing,
      requiresGrounding: !!requiresGrounding,
      estimatedComplexity,
      recommendedLayer,
      confidence: 0.7, // Simple confidence score
    };
  }

  /**
   * Execute workflow using hybrid strategy
   */
  /**
   * What a finished step publishes for `@step.output` references.
   *
   * A failed step publishes its failure rather than nothing: resolveStepInput
   * turns `success: false` into an explicit marker for the downstream step, and
   * a step that published nothing at all was indistinguishable from one that
   * had not run -- so the reference silently resolved to the literal
   * `@step.output` string.
   */
  private publishedOutput(result: LayerResult): Record<string, unknown> {
    return result.success
      ? { output: result.data }
      : { success: false, error: result.error };
  }

  private async executeHybrid(
    workflow: ExecutionPlan,
    inputData: Record<string, unknown>,
    options: ExecutionOptions,
    analysis: WorkloadAnalysis
  ): Promise<Record<string, LayerResult>> {
    // Dependency order first, layer grouping second.
    //
    // Grouping by layer alone ignored dependsOn entirely: with a recommended
    // layer of aistudio, a Claude step landed in `medium` and a search step in
    // `low`, and medium runs first -- so a synthesis step declaring
    // dependsOn: ['search'] started before search had begun, and its
    // @step.output reference resolved against an empty map. The run then
    // reported success, because the step returned something of its own.
    //
    // Each dependency level is still grouped by layer inside itself, which is
    // what hybrid is for.
    const results: Record<string, LayerResult> = {};

    // Dependency references use `@step.output`, so every execution mode has to
    // publish the same shape. Only sequential did.
    const stepOutputs: Record<string, Record<string, unknown>> = {};
    const declaredSteps = this.declaredStepIds(workflow);

    for (const level of this.groupStepsByDependencies(workflow.steps)) {
      const stepGroups = this.groupStepsByRecommendedLayer(level, analysis);

      // Within a level, the recommended layer goes first; steps that share a
      // priority run together.
      for (const [_priority, steps] of Object.entries(stepGroups)) {
        const [first] = steps;

        if (steps.length === 1 && first) {
          const stepInput = this.resolveStepInput(first.input, stepOutputs, inputData, declaredSteps);
          const result = await this.executeStep(first, stepInput, options);
          results[first.id] = result;
          stepOutputs[first.id] = this.publishedOutput(result);
          continue;
        }

        const stepResults = await Promise.all(steps.map(async (step) => ({
          stepId: step.id,
          result: await this.executeStep(
            step,
            this.resolveStepInput(step.input, stepOutputs, inputData, declaredSteps),
            options
          ),
        })));

        stepResults.forEach(({ stepId, result }) => {
          results[stepId] = result;
          stepOutputs[stepId] = this.publishedOutput(result);
        });
      }
    }

    return results;
  }

  /**
   * Try fallback strategy for a failed step
   */
  private async tryFallbackStrategy(
    failedStep: WorkflowStep,
    workflow: ExecutionPlan,
    error: Error,
    options: ExecutionOptions
  ): Promise<LayerResult | null> {
    if (!workflow.fallbackStrategies) {
      return null;
    }

    // Look for applicable fallback strategies
    const strategyKey = `${failedStep.layer}_unavailable`;
    const strategy = workflow.fallbackStrategies[strategyKey];

    if (strategy?.replace !== failedStep.id) {
      return null;
    }

    // A file-carrying step cannot fall back to the Antigravity CLI layer.
    //
    // That layer takes a text prompt only, so it would answer from the prompt
    // alone -- summarising documents it was never given, and reporting success.
    // Failing loudly here surfaces the real problem (AI Studio was unavailable)
    // instead of substituting a fluent, unfounded answer.
    const fallbackLayer = normalizeLayerName(String(strategy.with.layer));
    // taskFileRefs so a step carrying `documents` counts too -- the
    // document-analysis workflow uses that key, and reading only `files` let its
    // fallback route to the search layer.
    const stepFiles = taskFileRefs(failedStep.input);
    if (fallbackLayer === 'antigravity' && stepFiles.length > 0) {
      throw new CGMBError(
        `Step ${failedStep.id} carries files and cannot fall back to the Antigravity CLI layer, ` +
        `which accepts a text prompt only. The AI Studio layer is required for file processing. ` +
        `Original failure: ${error.message}`,
        'FILE_FALLBACK_UNAVAILABLE'
      );
    }

    logger.info(`Attempting fallback strategy for step ${failedStep.id}`, {
      strategy: strategyKey,
      fallbackLayer: strategy.with.layer,
    });

    try {
      const fallbackInput = this.resolveStepInput(
        strategy.with.input,
        {},
        failedStep.input,
        this.declaredStepIds(workflow)
      );

      return await this.executeStep(strategy.with, fallbackInput, options);
    } catch (fallbackError) {
      logger.error(`Fallback strategy failed for step ${failedStep.id}`, { error: errorForLog(fallbackError) });
      return null;
    }
  }

  /**
   * Create workflow execution plan based on workflow type
   */
  private async createWorkflowPlan(
    workflowType: WorkflowType,
    context: { prompt: string; files: FileReference[]; options?: ProcessingOptions }
  ): Promise<ExecutionPlan> {
    switch (workflowType) {
      case 'analysis':
        return this.createAnalysisWorkflow(context);
      case 'conversion':
        return this.createConversionWorkflow(context);
      case 'extraction':
        return this.createExtractionWorkflow(context);
      case 'generation':
        return this.createGenerationWorkflow(context);
      default:
        throw new CGMBError(`Unknown workflow type: ${workflowType}`, 'INVALID_WORKFLOW_TYPE');
    }
  }

  /**
   * Create analysis workflow plan
   */
  private createAnalysisWorkflow(context: {
    prompt: string;
    files: FileReference[];
    options?: ProcessingOptions;
  }): ExecutionPlan {
    return {
      steps: [
        {
          id: 'preprocess',
          layer: 'claude',
          action: 'analyze_requirements',
          input: {
            prompt: context.prompt,
            files: context.files,
            analysisType: 'multimodal_analysis',
          },
        },
        {
          id: 'multimodal_analysis',
          layer: 'aistudio',
          action: 'process_multimodal',
          input: {
            files: context.files,
            instructions: context.prompt,
            options: context.options,
          },
          dependsOn: ['preprocess'],
        },
        {
          id: 'synthesis',
          layer: 'claude',
          action: 'synthesize_results',
          input: {
            analysis_results: '@multimodal_analysis.output',
            original_prompt: context.prompt,
          },
          dependsOn: ['multimodal_analysis'],
        },
      ],
      fallbackStrategies: {
        aistudio_unavailable: {
          replace: 'multimodal_analysis',
          with: {
            id: 'fallback_analysis',
            layer: 'antigravity',
            action: 'analyze_with_grounding',
            input: {
              prompt: context.prompt,
              files: context.files,
            },
          },
        },
      },
    };
  }

  /**
   * Create conversion workflow plan
   */
  private createConversionWorkflow(context: {
    prompt: string;
    files: FileReference[];
    options?: ProcessingOptions;
  }): ExecutionPlan {
    return {
      steps: [
        {
          id: 'format_analysis',
          layer: 'claude',
          action: 'analyze_conversion_requirements',
          input: {
            files: context.files,
            targetFormat: context.prompt,
          },
        },
        {
          id: 'file_conversion',
          layer: 'aistudio',
          action: 'convert_files',
          input: {
            files: context.files,
            conversion_instructions: context.prompt,
            options: context.options,
          },
          dependsOn: ['format_analysis'],
        },
        {
          id: 'quality_check',
          layer: 'antigravity',
          action: 'validate_conversion',
          input: {
            original_files: context.files,
            converted_results: '@file_conversion.output',
          },
          dependsOn: ['file_conversion'],
        },
      ],
    };
  }

  /**
   * Create extraction workflow plan
   */
  private createExtractionWorkflow(context: {
    prompt: string;
    files: FileReference[];
    options?: ProcessingOptions;
  }): ExecutionPlan {
    return {
      steps: [
        {
          id: 'extraction_planning',
          layer: 'claude',
          action: 'plan_extraction',
          input: {
            files: context.files,
            extraction_requirements: context.prompt,
          },
        },
        {
          id: 'data_extraction',
          layer: 'aistudio',
          action: 'extract_data',
          input: {
            files: context.files,
            extraction_plan: '@extraction_planning.output',
            options: context.options,
          },
          dependsOn: ['extraction_planning'],
        },
        {
          id: 'structure_data',
          layer: 'claude',
          action: 'structure_extracted_data',
          input: {
            raw_data: '@data_extraction.output',
            requirements: context.prompt,
          },
          dependsOn: ['data_extraction'],
        },
      ],
    };
  }

  /**
   * Create generation workflow plan
   */
  private createGenerationWorkflow(context: {
    prompt: string;
    files: FileReference[];
    options?: ProcessingOptions;
  }): ExecutionPlan {
    return {
      steps: [
        {
          id: 'content_analysis',
          layer: 'aistudio',
          action: 'analyze_source_content',
          input: {
            files: context.files,
            generation_goals: context.prompt,
          },
        },
        {
          id: 'generation_strategy',
          layer: 'claude',
          action: 'develop_generation_strategy',
          input: {
            content_analysis: '@content_analysis.output',
            requirements: context.prompt,
          },
          dependsOn: ['content_analysis'],
        },
        {
          id: 'content_generation',
          layer: 'aistudio',
          action: 'generate_content',
          input: {
            strategy: '@generation_strategy.output',
            source_files: context.files,
            prompt: context.prompt,
            options: {
              generation_type: 'auto_detect', // Will auto-detect image/video/audio from prompt
              priority_models: {
                image: 'imagen-3',
                video: 'veo-2', 
                audio: 'text-to-speech'
              }
            }
          },
          dependsOn: ['generation_strategy'],
        },
      ],
    };
  }

  /**
   * Utility methods
   */
  private getLayer(layerType: LayerType) {
    switch (layerType) {
      case 'claude':
        return this.getClaudeLayer();
      case 'gemini': // deprecated alias
      case 'antigravity':
        return this.getAntigravityLayer();
      case 'aistudio':
        return this.getAIStudioLayer();
      default:
        throw new CGMBError(`Unknown layer type: ${layerType}`, 'INVALID_LAYER_TYPE');
    }
  }

  /**
   * Get layer with async initialization (for use in async contexts)
   */
  private async getLayerAsync(layerType: LayerType) {
    switch (layerType) {
      case 'claude':
        return await this.getClaudeLayerAsync();
      case 'gemini': // deprecated alias
      case 'antigravity':
        return await this.getAntigravityLayerAsync();
      case 'aistudio':
        return await this.getAIStudioLayerAsync();
      default:
        throw new CGMBError(`Unknown layer type: ${layerType}`, 'INVALID_LAYER_TYPE');
    }
  }

  /**
   * Reject a plan whose dependsOn cannot be satisfied, before any step runs.
   *
   * Each execution mode used to find out on its own, differently: sequential
   * (topologicalSort) skipped a dependsOn naming no step and ran the step as if
   * it had no dependency, while parallel and hybrid (groupStepsByDependencies)
   * threw a generic DEPENDENCY_RESOLUTION_FAILED. So the same definition ran in
   * one mode and failed in another -- and in sequential mode the steps before
   * the bad one had already been paid for. One check here, ahead of every mode,
   * names the step and the id at fault.
   */
  private validateWorkflowDependencies(steps: WorkflowStep[]): void {
    const ids = new Set<string>();
    for (const step of steps) {
      if (ids.has(step.id)) {
        throw new CGMBError(
          `Invalid workflow: more than one step has the id "${step.id}". Step ids must be unique.`,
          'INVALID_WORKFLOW_DEPENDENCY'
        );
      }
      ids.add(step.id);
    }

    const known = [...ids].map(id => `"${id}"`).join(', ');
    for (const step of steps) {
      for (const depId of step.dependsOn ?? []) {
        if (depId === step.id) {
          throw new CGMBError(
            `Invalid workflow: step "${step.id}" lists itself in dependsOn.`,
            'INVALID_WORKFLOW_DEPENDENCY'
          );
        }
        if (!ids.has(depId)) {
          throw new CGMBError(
            `Invalid workflow: step "${step.id}" depends on "${depId}", which is not a step in this workflow ` +
            `(steps: ${known}).`,
            'INVALID_WORKFLOW_DEPENDENCY'
          );
        }
      }
    }

    // Every id is known now, so what is left to go wrong is a cycle. Walk the
    // graph keeping the current path, so the error can show the loop itself.
    const byId = new Map(steps.map(step => [step.id, step] as const));
    const done = new Set<string>();
    const path: string[] = [];
    const onPath = new Set<string>();

    const visit = (id: string): void => {
      if (done.has(id)) { return; }
      if (onPath.has(id)) {
        const loop = [...path.slice(path.indexOf(id)), id].map(s => `"${s}"`).join(' -> ');
        throw new CGMBError(
          `Invalid workflow: steps depend on each other in a cycle: ${loop}.`,
          'CIRCULAR_DEPENDENCY'
        );
      }
      path.push(id);
      onPath.add(id);
      for (const depId of byId.get(id)?.dependsOn ?? []) {
        visit(depId);
      }
      path.pop();
      onPath.delete(id);
      done.add(id);
    };

    for (const step of steps) {
      visit(step.id);
    }
  }

  private topologicalSort(steps: WorkflowStep[]): WorkflowStep[] {
    const sorted: WorkflowStep[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();

    const visit = (step: WorkflowStep) => {
      if (visiting.has(step.id)) {
        throw new CGMBError(`Circular dependency detected at step: ${step.id}`, 'CIRCULAR_DEPENDENCY');
      }
      
      if (visited.has(step.id)) {
        return;
      }

      visiting.add(step.id);

      // Visit dependencies first
      const dependencies = step.dependsOn ?? [];
      for (const depId of dependencies) {
        const depStep = steps.find(s => s.id === depId);
        // validateWorkflowDependencies has already refused an unknown id;
        // skipping one here is what used to run the step without its input.
        if (!depStep) {
          throw new CGMBError(
            `Step "${step.id}" depends on "${depId}", which is not a step in this workflow.`,
            'INVALID_WORKFLOW_DEPENDENCY'
          );
        }
        visit(depStep);
      }

      visiting.delete(step.id);
      visited.add(step.id);
      sorted.push(step);
    };

    for (const step of steps) {
      visit(step);
    }

    return sorted;
  }

  private groupStepsByDependencies(steps: WorkflowStep[]): WorkflowStep[][] {
    const levels: WorkflowStep[][] = [];
    const processed = new Set<string>();

    while (processed.size < steps.length) {
      const currentLevel = steps.filter(step => {
        if (processed.has(step.id)) {return false;}
        const dependencies = step.dependsOn ?? [];
        return dependencies.every(dep => processed.has(dep));
      });

      if (currentLevel.length === 0) {
        throw new CGMBError('Unable to resolve step dependencies', 'DEPENDENCY_RESOLUTION_FAILED');
      }

      levels.push(currentLevel);
      currentLevel.forEach(step => processed.add(step.id));
    }

    return levels;
  }

  private groupStepsByRecommendedLayer(
    steps: WorkflowStep[],
    analysis: WorkloadAnalysis
  ): Record<string, WorkflowStep[]> {
    // Typed by its exact keys rather than Record<string, ...>. With an index
    // signature, noUncheckedIndexedAccess makes every lookup possibly-undefined,
    // which is why each push needed an assertion -- even though the three keys
    // are initialised right here.
    const groups: { high: WorkflowStep[]; medium: WorkflowStep[]; low: WorkflowStep[] } = {
      high: [],
      medium: [],
      low: [],
    };

    steps.forEach(step => {
      if (step.layer === analysis.recommendedLayer) {
        groups.high.push(step);
      } else if (step.layer === 'claude') {
        groups.medium.push(step);
      } else {
        groups.low.push(step);
      }
    });

    return groups;
  }

  /** The step ids a workflow declares: the only names a reference may use. */
  private declaredStepIds(workflow: ExecutionPlan): ReadonlySet<string> {
    return new Set(workflow.steps.map(step => step.id));
  }

  private resolveStepInput(
    input: Record<string, unknown>,
    stepOutputs: Record<string, Record<string, unknown>>,
    baseInput: Record<string, unknown>,
    declaredSteps: ReadonlySet<string>
  ): Record<string, unknown> {
    const resolved: Record<string, unknown> = { ...baseInput };

    for (const [key, value] of Object.entries(input)) {
      resolved[key] = this.resolveNestedReferences(value, stepOutputs, declaredSteps, 0);
    }

    return resolved;
  }

  /**
   * Resolve `@step` references, at the top level and inside arrays and plain
   * objects.
   *
   * Only top-level values used to be resolved, so the shape synthesize_response
   * is built around -- `inputs: { search: '@search.output', ... }` -- reached
   * Claude as the literal reference strings. The value a reference resolves to
   * is passed through as it is (an object stays an object); it is the layer
   * that decides how to render it.
   *
   * A string is a reference only when the whole of it has the STEP_REFERENCE
   * shape and names a step this workflow declares. Everything else -- `@scope/pkg`,
   * `@here is the text`, `@s9` in a workflow with no step s9 -- is input and is
   * passed on untouched.
   */
  private resolveNestedReferences(
    value: unknown,
    stepOutputs: Record<string, Record<string, unknown>>,
    declaredSteps: ReadonlySet<string>,
    depth: number
  ): unknown {
    // Step inputs are small hand-written structures; the bound only guards
    // against something pathological arriving in one.
    if (depth > 8) {
      return value;
    }
    if (typeof value === 'string') {
      const reference = this.parseStepReference(value, declaredSteps);
      return reference ? this.resolveStepReference(reference, stepOutputs) : value;
    }
    if (Array.isArray(value)) {
      return value.map(item => this.resolveNestedReferences(item, stepOutputs, declaredSteps, depth + 1));
    }
    if (typeof value === 'object' && value !== null) {
      const proto: unknown = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        return value;
      }
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        out[key] = this.resolveNestedReferences(item, stepOutputs, declaredSteps, depth + 1);
      }
      return out;
    }
    return value;
  }

  /**
   * The step id and path of a `@step[.path]` reference, or null when `value` is
   * not one: not the STEP_REFERENCE shape, or naming no declared step.
   */
  private parseStepReference(
    value: string,
    declaredSteps: ReadonlySet<string>
  ): { stepId: string; path: string[] } | null {
    const match = STEP_REFERENCE.exec(value);
    const stepId = match?.[1];
    if (stepId === undefined || !declaredSteps.has(stepId)) {
      return null;
    }
    const path = match?.[2] ?? '';
    return { stepId, path: path === '' ? [] : path.slice(1).split('.') };
  }

  /**
   * What one step reference stands for.
   *
   * A reference that cannot be resolved -- its step failed, or has published
   * nothing -- is logged by step id and path only. The log used to carry the
   * whole value, which for anything starting with `@` could be arbitrary text.
   */
  private resolveStepReference(
    reference: { stepId: string; path: string[] },
    stepOutputs: Record<string, Record<string, unknown>>
  ): unknown {
    const { stepId, path: pathParts } = reference;
    const originalReference = `@${[stepId, ...pathParts].join('.')}`;
    // Own properties only: a step called "constructor" must not find
    // Object.prototype.constructor when it has published nothing.
    const stepOutput = Object.hasOwn(stepOutputs, stepId) ? stepOutputs[stepId] : undefined;

    const missing = (): Record<string, unknown> => {
      // Step output not found - could be a failed step or not yet executed
      logger.warn('Could not resolve step reference', {
        stepId,
        path: pathParts.join('.'),
        hint: 'The referenced step may have failed or not been executed'
      });
      // Provide context for downstream handling
      return {
        _stepMissing: true,
        _stepId: stepId,
        _originalReference: originalReference,
        _hint: 'Referenced step output not available - step may have failed or not executed'
      };
    };

    if (!stepOutput) {
      return missing();
    }

    // Check if the step result is a failed LayerResult (has success: false)
    const layerResult = stepOutput as { success?: boolean; error?: string; output?: unknown };
    if (layerResult.success === false) {
      // Previous step failed - provide context for downstream handling. Its
      // error was logged where it failed; this line names the reference only.
      logger.warn('Step reference points to a failed step', {
        stepId,
        path: pathParts.join('.'),
      });
      return {
        _stepFailed: true,
        _stepId: stepId,
        _error: layerResult.error || 'Previous step failed',
        _originalReference: originalReference
      };
    }

    let resolvedValue: unknown = stepOutput;
    for (const part of pathParts) {
      if (typeof resolvedValue === 'object' && resolvedValue !== null) {
        // Own properties only, as for the step id above: `@s1.__proto__` or
        // `@s1.output.constructor` must not walk into Object.prototype and
        // hand a step a function from the runtime.
        if (!Object.hasOwn(resolvedValue, part)) {
          return missing();
        }
        resolvedValue = (resolvedValue as Record<string, unknown>)[part];
      } else {
        resolvedValue = undefined;
        break;
      }
    }
    return resolvedValue;
  }

  private generateWorkflowSummary(results: Record<string, LayerResult>): string {
    const total = Object.keys(results).length;
    const successful = Object.values(results).filter(r => r.success).length;
    const failed = total - successful;

    if (failed === 0) {
      return `All ${total} workflow steps completed successfully.`;
    } else if (successful === 0) {
      return `All ${total} workflow steps failed.`;
    } else {
      return `${successful}/${total} workflow steps completed successfully, ${failed} failed.`;
    }
  }

  private calculateTotalCost(results: Record<string, LayerResult>): number {
    return Object.values(results).reduce((total, result) => {
      return total + (result.metadata.cost || 0);
    }, 0);
  }


  /**
   * Detect if request is for content generation
   */
  private detectGenerationRequest(prompt: string, workflow: ExecutionPlan): boolean {
    if (!prompt) {return false;}
    
    const generationKeywords = [
      'generate', 'create', 'make', 'produce', 'draw', 'design',
      '生成', '作成', '作る', '描く', 'つくる'
    ];
    
    const isWorkflowGeneration = workflow.steps.some(step => 
      step.action.includes('generate') || 
      step.action.includes('create') ||
      step.layer === 'aistudio'
    );
    
    const hasGenerationKeywords = generationKeywords.some(keyword => 
      prompt.toLowerCase().includes(keyword.toLowerCase())
    );
    
    return isWorkflowGeneration || hasGenerationKeywords;
  }

  /**
   * Detect if request is specifically for image generation
   */
  private detectImageGeneration(prompt: string, _workflow: ExecutionPlan): boolean {
    if (!prompt) {return false;}
    
    const imageKeywords = [
      'image', 'picture', 'photo', 'illustration', 'drawing', 'artwork',
      'visual', 'graphic', 'sketch', 'painting', 'render',
      '画像', '写真', 'イラスト', '絵', '図', 'ピクチャー'
    ];
    
    const generationKeywords = [
      'generate', 'create', 'make', 'produce', 'draw', 'design',
      '生成', '作成', '作る', '描く'
    ];
    
    const hasImageKeyword = imageKeywords.some(keyword => 
      prompt.toLowerCase().includes(keyword.toLowerCase())
    );
    
    const hasGenerationKeyword = generationKeywords.some(keyword => 
      prompt.toLowerCase().includes(keyword.toLowerCase())
    );
    
    return hasImageKeyword && hasGenerationKeyword;
  }


  /**
   * Detect if request is for audio generation
   */
  private detectAudioGeneration(prompt: string, _workflow: ExecutionPlan): boolean {
    if (!prompt) {return false;}
    
    const audioKeywords = [
      'audio', 'sound', 'music', 'voice', 'speech', 'narration',
      '音声', '音楽', 'サウンド', '声', 'ナレーション'
    ];
    
    const generationKeywords = [
      'generate', 'create', 'make', 'produce', 'synthesize',
      '生成', '作成', '作る', '合成'
    ];
    
    const hasAudioKeyword = audioKeywords.some(keyword => 
      prompt.toLowerCase().includes(keyword.toLowerCase())
    );
    
    const hasGenerationKeyword = generationKeywords.some(keyword => 
      prompt.toLowerCase().includes(keyword.toLowerCase())
    );
    
    return hasAudioKeyword && hasGenerationKeyword;
  }

  /**
   * Detect document processing requests
   */
  private detectDocumentProcessing(prompt: string, files: any): boolean {
    if (!prompt) {return false;}
    
    // Check for document-related keywords
    const documentKeywords = [
      'document', 'pdf', 'analyze', 'extract', 'summarize', 'compare',
      'text', 'file', 'content', 'read', 'process',
      'ドキュメント', '文書', '分析', '抽出', '要約'
    ];
    
    const hasDocumentKeyword = documentKeywords.some(keyword => 
      prompt.toLowerCase().includes(keyword.toLowerCase())
    );
    
    // Check if files include documents
    let hasDocumentFiles = false;
    if (files && Array.isArray(files)) {
      hasDocumentFiles = files.some((file: any) => {
        const fileExt = file.path?.toLowerCase() || '';
        return fileExt.endsWith('.pdf') || fileExt.endsWith('.docx') || 
               fileExt.endsWith('.doc') || fileExt.endsWith('.txt');
      });
    }
    
    return hasDocumentKeyword || hasDocumentFiles;
  }

  /**
   * Execute a single workflow step on the appropriate layer
   */
  private async executeStep(
    step: WorkflowStep,
    input: Record<string, unknown>,
    options: ExecutionOptions
  ): Promise<LayerResult> {
    const startTime = Date.now();
    
    logger.debug(`Executing step ${step.id} on ${step.layer} layer`, {
      stepId: step.id,
      layer: step.layer,
      action: step.action,
    });

    try {
      // Prepare the execution parameters
      const executionParams = {
        type: this.mapActionToTaskType(step.action),
        action: step.action,
        ...input,
      };

      // Execute the step with timeout
      // Route through executeWithLayer so the trusted root reaches the layer.
      // Calling layer.execute() directly here dropped the context, which meant
      // the confinement fell back to process.cwd() for every workflow step --
      // including the Antigravity quality check in conversion workflows and the
      // fallback used when AI Studio fails.
      const result = await safeExecute(
        () => this.executeWithLayer(step.layer, executionParams),
        {
          operationName: `execute-step-${step.id}`,
          layer: step.layer,
          timeout: options.timeout || 300000,
        }
      );

      const duration = Date.now() - startTime;

      // Validate that result contains meaningful data
      const isValidResult = this.validateStepResult(result, step);

      if (!isValidResult) {
        logger.warn(`Step ${step.id} returned empty or invalid result`, {
          stepId: step.id,
          layer: step.layer,
          resultType: typeof result,
          hasData: result !== null && result !== undefined,
        });

        return {
          success: false,
          error: 'Step returned empty or invalid result',
          data: result,
          metadata: {
            layer: step.layer,
            duration,
            model: step.action,
          },
        };
      }

      // Return the layer's own result, not a wrapper around it.
      //
      // executeWithLayer already returns a LayerResult. Re-wrapping it as
      // { success, data: result } meant dependent steps received the envelope
      // instead of the payload, and the response formatter could not unwrap
      // data.data -- so a multi-step workflow succeeded while emitting
      // "Processing completed" and handed the wrong object to the next model.
      // (Introduced when executeStep was routed through executeWithLayer to
      // carry the trusted workspace root.)
      return {
        ...result,
        metadata: {
          ...result.metadata,
          layer: step.layer,
          duration,
          model: step.action,
        },
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      
      logger.error(`Step ${step.id} failed on ${step.layer} layer`, {
        error: errorForLog(error),
        duration,
        stepId: step.id,
        layer: step.layer,
        action: step.action,
      });

      return {
        success: false,
        error: (error as Error).message,
        data: null,
        metadata: {
          layer: step.layer,
          duration,
          model: step.action,
        },
      };
    }
  }

  /**
   * Validate step result has meaningful content
   */
  private validateStepResult(result: unknown, step: WorkflowStep): boolean {
    // Null or undefined is invalid
    if (result === null || result === undefined) {
      return false;
    }

    // If result is a LayerResult, check its success and data
    if (typeof result === 'object' && 'success' in result) {
      const layerResult = result as { success: boolean; data?: unknown };
      if (!layerResult.success) {
        return false;
      }
      // Check if data exists and is not empty
      if (layerResult.data === null || layerResult.data === undefined) {
        return false;
      }
      if (typeof layerResult.data === 'object' && Object.keys(layerResult.data as object).length === 0) {
        return false;
      }
    }

    // For generation tasks, check for output path or data
    if (step.action.includes('generate')) {
      if (typeof result === 'object') {
        const r = result as Record<string, unknown>;
        return !!(r.outputPath ?? r.data ?? r.imageData ?? r.audioData ?? r.content);
      }
    }

    // For analysis tasks, check for content
    if (step.action.includes('analyze') || step.action.includes('process')) {
      if (typeof result === 'object') {
        const r = result as Record<string, unknown>;
        return !!(r.content ?? r.analysis ?? r.data ?? r.result);
      }
    }

    // For string results, check it's not empty
    if (typeof result === 'string') {
      return result.trim().length > 0;
    }

    // For object results, check it's not empty
    if (typeof result === 'object') {
      return Object.keys(result as object).length > 0;
    }

    // Other types are considered valid
    return true;
  }

  /**
   * Map workflow action to task type for layer execution
   */
  private mapActionToTaskType(action: string): string {
    // Map common workflow actions to appropriate task types
    const actionMap: Record<string, string> = {
      'analyze_requirements': 'text_processing',
      'process_multimodal': 'multimodal_processing',
      'synthesize_results': 'text_processing',
      'analyze_with_grounding': 'text_processing',
      'process_documents': 'document_processing',
      'extract_content': 'extraction',
      'convert_format': 'conversion',
      'analyze_source_content': 'content_analysis',
      'develop_generation_strategy': 'strategy_development',
      'generate_content': 'content_generation',
    };

    return actionMap[action] || 'text_processing';
  }
}