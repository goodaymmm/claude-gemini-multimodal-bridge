import { lstatSync, realpathSync } from 'fs';
import { delimiter, isAbsolute, relative, resolve as resolvePath } from 'path';
import { z } from 'zod';
import { PDF_MODES } from '../utils/pdfText.js';

// ===================================
// Core Types and Schemas
// ===================================

// Layer Types
//
// The search layer is named 'antigravity' after the CLI it drives. 'gemini' is
// retained as a deprecated alias so existing MCP clients, saved configs and
// scripts keep working; normalizeLayerName() maps it onto the canonical name at
// every entry point. Removing it outright would reject requests that were valid
// one release earlier.
export const LayerTypeSchema = z.enum([
  'claude', 'antigravity', 'gemini', 'aistudio', 'workflow', 'tool', 'orchestrator',
]);
export type LayerType = z.infer<typeof LayerTypeSchema>;

// Target Layer Types for direct routing
// `claude` was missing here while LayerTypeSchema had it, so a request naming
// it failed validation, fell through to the legacy shape with targetLayer
// undefined, and was routed to whichever layer the analyser preferred --
// measured: the search layer answered a request that asked for Claude.
export const TargetLayerSchema = z.enum(['antigravity', 'gemini', 'aistudio', 'claude', 'adaptive']);
export type TargetLayer = z.infer<typeof TargetLayerSchema>;

/**
 * Narrow an unknown value to one of a literal union, by membership.
 *
 * `union.includes(value)` does not typecheck when `value` is wider than the
 * union, and the usual escape was `includes(value as any)` followed by a second
 * `as any` to store the result. Both casts silence the checker rather than
 * satisfying it: nothing then stops an unrelated string from being written into
 * a field typed as the union. This does the check the casts were standing in
 * for, and narrows on the way out.
 */
export function isOneOf<T extends string>(union: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (union as readonly string[]).includes(value);
}

/**
 * Map the deprecated 'gemini' layer name onto its canonical replacement.
 *
 * Accepts an arbitrary string so it can sit directly on untrusted MCP input;
 * anything else is returned unchanged for the caller's own validation to reject.
 */
export function normalizeLayerName<T extends string>(layer: T): T | 'antigravity' {
  return layer === 'gemini' ? 'antigravity' : layer;
}
export const ExecutionModeSchema = z.enum(['sequential', 'parallel', 'adaptive']);
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;
export const QualityLevelSchema = z.enum(['fast', 'balanced', 'quality']);
export type QualityLevel = z.infer<typeof QualityLevelSchema>;
export const WorkflowTypeSchema = z.enum(['analysis', 'conversion', 'extraction', 'generation']);
export type WorkflowType = z.infer<typeof WorkflowTypeSchema>;

// Analysis Types
export type AnalysisType = 'content' | 'comparative' | 'thematic' | 'sentiment' | 'trend' | 'statistical' | 'comprehensive' | 'contextual' | 'summarization' | 'extraction';

// File Types
export const FileTypeSchema = z.enum([
  'image', 'audio', 'pdf', 'document', 'text', 'video'
]);
export type FileType = z.infer<typeof FileTypeSchema>;

export const FileReferenceSchema = z.object({
  path: z.string(),
  type: FileTypeSchema,
  size: z.number().optional(),
  encoding: z.string().optional(),
  content: z.string().optional(), // base64 for small files
});
export type FileReference = z.infer<typeof FileReferenceSchema>;

/**
 * Every file a task refers to, whichever key it used.
 *
 * The codebase names the same thing two ways: multimodal work carries `files`
 * as FileReference objects, document analysis passes `documents` as bare path
 * strings. Nearly every guard and router read only `files`, so a
 * `documents`-carrying task was treated as text -- routed to layers that cannot
 * read files, passed through the search layer's file guard, and missed by the
 * routing capability filter. Reading both here is what makes those checks agree.
 *
 * Bare strings are normalised to type 'document', which is what the document
 * path means by construction.
 */
export function taskFileRefs(task: unknown): FileReference[] {
  const source = task as { files?: unknown; documents?: unknown } | null | undefined;

  const candidates: unknown[] = [
    ...(Array.isArray(source?.files) ? source.files : []),
    ...(Array.isArray(source?.documents) ? source.documents : []),
  ];

  const refs: FileReference[] = [];

  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      if (candidate !== '') {
        refs.push({ path: candidate, type: 'document' });
      }
      continue;
    }

    const path = (candidate as { path?: unknown } | null | undefined)?.path;
    if (typeof path !== 'string' || path === '') {
      continue;
    }

    const type = (candidate as { type?: unknown }).type;
    refs.push({
      ...(candidate as FileReference),
      path,
      type: isOneOf(FileTypeSchema.options, type) ? type : 'document',
    });
  }

  return refs;
}

// Processing Options
export const ProcessingOptionsSchema = z.object({
  /**
   * @deprecated Never read by anything, and no longer advertised in the MCP
   * tool schema (1.3.0). Still accepted so callers that send it are not
   * refused; it has no effect. Use the `cgmb` tool's targetLayer to choose a
   * layer.
   */
  layer_priority: z.enum(['claude', 'antigravity', 'gemini', 'aistudio', 'adaptive']).optional(),
  execution_mode: z.enum(['sequential', 'parallel', 'adaptive']).optional(),
  output_format: z.string().optional(),
  quality_level: z.enum(['fast', 'balanced', 'quality']).optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().positive().optional(),
  timeout: z.number().positive().optional(),
  use_cache: z.boolean().optional(),
  // Additional properties for workflow processing
  depth: z.enum(['shallow', 'medium', 'deep']).optional(),
  extractMetadata: z.boolean().optional(),
  structured: z.boolean().optional(),
  requiresGrounding: z.boolean().optional(),
  parallelProcessing: z.boolean().optional(),
  batchMode: z.boolean().optional(),
  detailed: z.boolean().optional(),
  extractionType: z.string().optional(),
  outputFormat: z.string().optional(), // Note: keeping both output_format and outputFormat for compatibility
  preserveQuality: z.boolean().optional(),
  // How local PDFs reach the model: their extracted text, or the uploaded file.
  // Carried to the AI Studio MCP server, which decides; see utils/pdfText.ts.
  pdf_mode: z.enum(PDF_MODES).optional(),
});
export type ProcessingOptions = z.infer<typeof ProcessingOptionsSchema>;

// Tool Input Schemas
export const MultimodalProcessArgsSchema = z.object({
  prompt: z.string().min(1),
  workingDirectory: z.string().optional(),
  files: z.array(FileReferenceSchema),
  workflow: z.enum(['analysis', 'conversion', 'extraction', 'generation']),
  options: ProcessingOptionsSchema.optional(),
});
export type MultimodalProcessArgs = z.infer<typeof MultimodalProcessArgsSchema>;

export const DocumentAnalysisArgsSchema = z.object({
  // At least one document. An empty array used to satisfy this schema, run the
  // whole analysis workflow over nothing, and come back "analysis complete".
  documents: z.array(z.string().min(1)).min(1),
  workingDirectory: z.string().optional(),
  analysis_type: z.enum(['summary', 'comparison', 'extraction', 'translation']),
  output_requirements: z.string().optional(),
  options: ProcessingOptionsSchema.optional(),
  // Additional properties for compatibility
  analysisType: z.enum(['summary', 'comparison', 'extraction', 'translation']).optional(),
  extractImages: z.boolean().optional(),
  extractStructuredData: z.boolean().optional(),
  requiresGrounding: z.boolean().optional(),
  depth: z.enum(['shallow', 'medium', 'deep']).optional(),
  summaryLength: z.string().optional(),
  dataTypes: z.array(z.string()).optional(),
  comparisonType: z.string().optional(),
});
export type DocumentAnalysisArgs = z.infer<typeof DocumentAnalysisArgsSchema>;

export const DocumentAnalysisResultSchema = z.object({
  success: z.boolean(),
  analysis_type: z.enum(['summary', 'comparison', 'extraction', 'translation']),
  content: z.string(),
  documents_processed: z.array(z.string()),
  processing_time: z.number(),
  insights: z.array(z.string()).optional(),
  metadata: z.object({
    total_duration: z.number(),
    tokens_used: z.number().optional(),
    cost: z.number().optional(),
    quality_score: z.number().optional(),
  }),
  error: z.string().optional(),
});
export type DocumentAnalysisResult = z.infer<typeof DocumentAnalysisResultSchema>;

// Workflow Definitions
export const WorkflowStepSchema = z.object({
  id: z.string(),
  layer: z.enum(['claude', 'antigravity', 'gemini', 'aistudio']),
  action: z.string(),
  input: z.record(z.string(), z.any()),
  dependsOn: z.array(z.string()).optional(),
  timeout: z.number().optional(),
  retries: z.number().optional(),
});
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;

export const ExecutionPlanSchema = z.object({
  steps: z.array(WorkflowStepSchema),
  dependencies: z.record(z.string(), z.array(z.string())).optional(),
  fallbackStrategies: z.record(z.string(), z.object({
    replace: z.string(),
    with: WorkflowStepSchema,
  })).optional(),
  timeout: z.number().optional(),
});
export type ExecutionPlan = z.infer<typeof ExecutionPlanSchema>;

export const WorkflowDefinitionArgsSchema = z.object({
  workflow_definition: ExecutionPlanSchema,
  input_data: z.record(z.string(), z.any()),
  execution_mode: z.enum(['sequential', 'parallel', 'adaptive']).optional(),
  options: ProcessingOptionsSchema.optional(),
});
export type WorkflowDefinitionArgs = z.infer<typeof WorkflowDefinitionArgsSchema>;

// Results
export const LayerResultSchema = z.object({
  success: z.boolean(),
  data: z.any().optional(),
  error: z.string().optional(),
  metadata: z.object({
    layer: z.enum(['claude', 'antigravity', 'gemini', 'aistudio']),
    duration: z.number(),
    tokens_used: z.number().optional(),
    cost: z.number().optional(),
    model: z.string().optional(),
    fast_mode: z.boolean().optional(),
    optimization: z.string().optional(),
    retry_attempt: z.number().optional(),
    // Set when the layer the request was routed to failed (or, for Claude
    // Code, is not available) and this result came from a fallback layer.
    fallback_from: z.enum(['claude', 'antigravity', 'aistudio']).optional(),
    fallback_reason: z.string().optional(),
  }),
});
export type LayerResult = z.infer<typeof LayerResultSchema>;

export const WorkflowResultSchema = z.object({
  success: z.boolean(),
  results: z.union([z.record(z.string(), LayerResultSchema), z.array(LayerResultSchema)]),
  summary: z.string().optional(),
  metadata: z.object({
    total_duration: z.number(),
    steps_completed: z.number(),
    steps_failed: z.number(),
    total_cost: z.number().optional(),
    workflow: z.string().optional(),
    execution_mode: z.string().optional(),
    layers_used: z.array(z.string()).optional(),
    optimization: z.string().optional(),
  }),
});
export type WorkflowResult = z.infer<typeof WorkflowResultSchema>;

// Layer Interfaces
export interface LayerInterface {
  initialize(): Promise<void>;
  isAvailable(): Promise<boolean>;
  canHandle(task: any): boolean;
  execute(task: any): Promise<LayerResult>;
  getCapabilities(): string[];
  getCost(task: any): number;
  getEstimatedDuration(task: any): number;
  // Optional methods
  translateToEnglish?(text: string, sourceLang: string): Promise<string>;
}

// MCP Tool Result
export interface ToolResult {
  content: Array<{
    type: 'text' | 'image' | 'resource';
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError?: boolean;
}

// Configuration
export const ConfigSchema = z.object({
  /**
   * Search-layer settings, kept under the pre-rename key.
   *
   * Nothing reads `model` or `api_key`: the Antigravity CLI authenticates over
   * OAuth and picks its model from ANTIGRAVITY_MODEL, so neither field reaches
   * a request. They stay because Config is a public type -- callers construct
   * `new LayerManager(config)` -- and dropping required fields would break
   * them. Treat the values as inert.
   */
  gemini: z.object({
    api_key: z.string(),
    // Lazy: AI_MODELS is declared further down this module.
    model: z.string().default(() => AI_MODELS.GEMINI_FLASH),
    timeout: z.number().default(60000),
    max_tokens: z.number().default(16384),
    temperature: z.number().default(0.2),
  }),
  claude: z.object({
    code_path: z.string().default('claude'),
    timeout: z.number().default(300000),
  }),
  aistudio: z.object({
    enabled: z.boolean().default(true),
    max_files: z.number().default(10),
    max_file_size: z.number().default(100), // MB
  }),
  cache: z.object({
    enabled: z.boolean().default(true),
    ttl: z.number().default(3600),
  }),
  logging: z.object({
    level: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
    file: z.string().optional(),
  }),
});
export type Config = z.infer<typeof ConfigSchema>;

/**
 * The config a tool uses when it constructs its own LayerManager.
 *
 * Five call sites -- cli, ClaudeProxy, documentAnalysis, multimodalProcess and
 * workflowOrchestrator -- each carried a byte-identical copy of this literal,
 * including a hardcoded model string. Nothing reads that string, so the copies
 * could drift from reality without anyone noticing, while looking authoritative
 * enough to send someone editing them when a model needed changing.
 * (documentAnalysis and workflowOrchestrator have since been deleted: nothing
 * imported either of them.)
 */
export function defaultLayerConfig(): Config {
  return ConfigSchema.parse({
    // Inert; see the ConfigSchema comment. Named through AI_MODELS anyway so a
    // reader is not left wondering whether this string is live.
    gemini: { api_key: '', model: AI_MODELS.GEMINI_FLASH },
    claude: { code_path: 'claude' },
    aistudio: { enabled: true, max_files: 10, max_file_size: 100 },
    cache: { enabled: true, ttl: 3600 },
    logging: { level: 'info' as const },
  });
}

// Error Types
export class CGMBError extends Error {
  constructor(
    message: string,
    public code: string,
    public layer?: LayerType,
    public details?: Record<string, any>
  ) {
    super(message);
    this.name = 'CGMBError';
  }
}

export class LayerError extends CGMBError {
  constructor(message: string, layer: LayerType, details?: Record<string, any>) {
    super(message, 'LAYER_ERROR', layer, details);
    this.name = 'LayerError';
  }
}

export class WorkflowError extends CGMBError {
  constructor(message: string, details?: Record<string, any>) {
    super(message, 'WORKFLOW_ERROR', undefined, details);
    this.name = 'WorkflowError';
  }
}

// Analysis Types for Advanced Processing
// 'ocr' is an alias for 'extract_text' with enhanced text extraction focus
export const ImageAnalysisTypeSchema = z.enum(['detailed', 'technical', 'extract_text', 'ocr']);
export type ImageAnalysisType = z.infer<typeof ImageAnalysisTypeSchema>;

export const ImageAnalysisResultSchema = z.object({
  type: ImageAnalysisTypeSchema,
  description: z.string(),
  extracted_text: z.string().optional(),
  technical_details: z.record(z.string(), z.any()).optional(),
  confidence: z.number().min(0).max(1).optional(),
  // OCR-specific fields
  text_blocks: z.array(z.object({
    text: z.string(),
    bounding_box: z.object({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    }).optional(),
    confidence: z.number().optional(),
  })).optional(),
});
export type ImageAnalysisResult = z.infer<typeof ImageAnalysisResultSchema>;

export const MultimodalResultSchema = z.object({
  content: z.string(),
  success: z.boolean(),
  files_processed: z.array(z.string()),
  processing_time: z.number(),
  workflow_used: WorkflowTypeSchema,
  layers_involved: z.array(LayerTypeSchema),
  metadata: z.object({
    total_duration: z.number(),
    quality_level: QualityLevelSchema.optional(),
    tokens_used: z.number().optional(),
    cost: z.number().optional(),
  }),
  error: z.string().optional(),
});
export type MultimodalResult = z.infer<typeof MultimodalResultSchema>;

// Grounding context for the Antigravity CLI (search) layer
export const GroundingContextSchema = z.object({
  files: z.array(z.string()).optional(),
  useSearch: z.boolean().default(false),
  searchQuery: z.string().optional(),
  context: z.string().optional(),
});
export type GroundingContext = z.infer<typeof GroundingContextSchema>;

export const GroundedResultSchema = z.object({
  content: z.string(),
  sources: z.array(z.string()).optional(),
  grounded: z.boolean(),
  search_used: z.boolean(),
});
export type GroundedResult = z.infer<typeof GroundedResultSchema>;

// Task Analysis for Adaptive Execution
export const WorkloadAnalysisSchema = z.object({
  requiresComplexReasoning: z.boolean(),
  requiresMultimodalProcessing: z.boolean(),
  requiresGrounding: z.boolean(),
  estimatedComplexity: z.enum(['low', 'medium', 'high']),
  recommendedLayer: z.enum(['claude', 'antigravity', 'gemini', 'aistudio']),
  confidence: z.number().min(0).max(1),
});
export type WorkloadAnalysis = z.infer<typeof WorkloadAnalysisSchema>;

// Reasoning Task for Claude Code Layer
export const ReasoningTaskSchema = z.object({
  prompt: z.string(),
  context: z.string().optional(),
  depth: z.enum(['shallow', 'medium', 'deep']).optional(),
  domain: z.string().optional(),
});
export type ReasoningTask = z.infer<typeof ReasoningTaskSchema>;

export const ReasoningResultSchema = z.object({
  reasoning: z.string(),
  conclusion: z.string(),
  confidence: z.number().min(0).max(1),
  steps: z.array(z.string()).optional(),
});
export type ReasoningResult = z.infer<typeof ReasoningResultSchema>;

// ===================================
// Layer Requirements and Formatting Types
// ===================================

// Layer requirement information
export const LayerRequirementsSchema = z.object({
  format: z.string(),
  requirements: z.array(z.string()),
  capabilities: z.array(z.string()),
  example: z.record(z.string(), z.any()),
  limitations: z.array(z.string()).optional()
});
export type LayerRequirements = z.infer<typeof LayerRequirementsSchema>;

/**
 * Preformatted data for a layer (`formattedData` on the cgmb tool).
 *
 * This must accept exactly what the cgmb tool's JSON schema advertises,
 * `geminiFormat: { prompt, args }`. It used to require `stdin` instead, so a
 * call shaped per the schema failed here, fell back to the legacy request
 * shape and lost its targetLayer without a word. `stdin` is still read as a
 * deprecated spelling of `prompt`; with neither, the request's own prompt is
 * used. See preformattedPrompt().
 */
export const GeminiFormatSchema = z.object({
  prompt: z.string().optional(),
  /** @deprecated Older spelling of `prompt`. */
  stdin: z.string().optional(),
  args: z.array(z.string()).optional(),
});
export type GeminiFormat = z.infer<typeof GeminiFormatSchema>;

export const FormattedLayerDataSchema = z.object({
  geminiFormat: GeminiFormatSchema.optional(),
  /**
   * @deprecated Never implemented, and no longer in the tool's JSON schema.
   * Still accepted (in any shape) so older callers are not refused; a request
   * carrying it is routed normally, with a warning.
   */
  aistudioFormat: z.record(z.string(), z.unknown()).optional(),
});
export type FormattedLayerData = z.infer<typeof FormattedLayerDataSchema>;

/** The prompt a preformatted geminiFormat carries, falling back to the request's. */
export function preformattedPrompt(format: GeminiFormat, fallback: string): string {
  return format.prompt ?? format.stdin ?? fallback;
}

// Enhanced CGMB request with preformatting support
export const EnhancedCGMBRequestSchema = z.object({
  prompt: z.string(),
  workingDirectory: z.string().optional(),
  targetLayer: TargetLayerSchema.optional(),
  preformatted: z.boolean().optional(),
  formattedData: FormattedLayerDataSchema.optional(),
  files: z.array(FileReferenceSchema).optional(),
  options: ProcessingOptionsSchema.optional()
});
export type EnhancedCGMBRequest = z.infer<typeof EnhancedCGMBRequestSchema>;

/**
 * Older clients that predate the enhanced request shape.
 *
 * Everything is optional -- that is the whole point of the fallback -- but the
 * fields that are present still have to be the right shape. The previous
 * fallback cast the arguments to `any` and read `files` straight off them, so a
 * request that failed the schema above was handed on entirely unvalidated:
 * `files` could be a string, a number, or objects with no path at all, and the
 * failure surfaced somewhere further down as a confusing type error.
 *
 * passthrough() keeps unknown keys rather than stripping them, so a newer
 * client talking to this path does not silently lose fields.
 */
export const LegacyCGMBRequestSchema = z.object({
  prompt: z.string().optional(),
  files: z.array(FileReferenceSchema).optional(),
  options: ProcessingOptionsSchema.optional(),
}).passthrough();

// ===================================
// Media Generation Types and Schemas
// ===================================

// Media Generation Types
export const GenerationTypeSchema = z.enum(['image', 'video', 'audio', 'music']);
export type GenerationType = z.infer<typeof GenerationTypeSchema>;

// Image Generation Options
export const ImageGenOptionsSchema = z.object({
  width: z.number().min(64).max(4096).optional(),
  height: z.number().min(64).max(4096).optional(),
  aspectRatio: z.enum(['1:1', '16:9', '9:16', '4:3', '3:4']).optional(),
  style: z.enum(['photorealistic', 'artistic', 'cartoon', 'sketch', 'abstract']).optional(),
  quality: z.enum(['draft', 'standard', 'high', 'ultra']).optional(),
  model: z.enum(['imagen-3', 'imagen-2']).default('imagen-3'),
  seed: z.number().optional(),
  guidance: z.number().min(1).max(20).optional(),
  steps: z.number().min(10).max(100).optional(),
  numberOfImages: z.number().min(1).max(4).optional(),
  personGeneration: z.enum(['ALLOW', 'BLOCK']).optional(),
});
export type ImageGenOptions = z.infer<typeof ImageGenOptionsSchema>;

// Video Generation Options  
export const VideoGenOptionsSchema = z.object({
  width: z.number().min(256).max(2048).optional(),
  height: z.number().min(256).max(2048).optional(),
  duration: z.number().min(1).max(30).optional(), // seconds
  fps: z.enum(['24', '30', '60']).default('30'),
  quality: z.enum(['draft', 'standard', 'high']).optional(),
  model: z.enum(['veo-2', 'video-generation']).default('veo-2'),
  motion: z.enum(['static', 'slow', 'medium', 'fast']).optional(),
  seed: z.number().optional(),
});
export type VideoGenOptions = z.infer<typeof VideoGenOptionsSchema>;

// Audio Generation Options
export const AudioGenOptionsSchema = z.object({
  voice: z.enum(['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer', 'Kore', 'Puck']).optional(),
  language: z.string().optional(),
  speed: z.number().min(0.25).max(4).optional(),
  format: z.enum(['mp3', 'wav', 'flac']).default('mp3'),
  quality: z.enum(['standard', 'hd']).optional(),
  model: z.enum(['text-to-speech', 'voice-synthesis']).default('text-to-speech'),
});
export type AudioGenOptions = z.infer<typeof AudioGenOptionsSchema>;

// Media Generation Results
export const MediaGenResultSchema = z.object({
  success: z.boolean(),
  generationType: GenerationTypeSchema,
  outputPath: z.string(),
  originalPrompt: z.string(),
  metadata: z.object({
    duration: z.number(),
    fileSize: z.number(),
    format: z.string(),
    dimensions: z.object({
      width: z.number(),
      height: z.number(),
    }).optional(),
    model: z.string(),
    settings: z.record(z.string(), z.any()),
    cost: z.number().optional(),
    voice: z.string().optional(),
    responseText: z.string().optional(),
    translation: z.object({
      detectedLanguage: z.string(),
      languageName: z.string(),
      originalPrompt: z.string().optional(),
      translatedPrompt: z.string().optional(),
      wasTranslated: z.boolean(),
    }).optional(),
  }),
  media: z.object({
    type: z.enum(['image', 'audio', 'video']),
    data: z.string().optional(),
    metadata: z.record(z.string(), z.any()).optional(),
  }).optional(),
  downloadUrl: z.string().optional(),
  error: z.string().optional(),
});
export type MediaGenResult = z.infer<typeof MediaGenResultSchema>;

// Advanced Audio Analysis
export const AudioAnalysisResultSchema = z.object({
  transcription: z.string(),
  language: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  sentiment: z.enum(['positive', 'negative', 'neutral']).optional(),
  emotions: z.array(z.string()).optional(),
  speakers: z.array(z.object({
    id: z.string(),
    confidence: z.number(),
    segments: z.array(z.object({
      start: z.number(),
      end: z.number(),
      text: z.string(),
    })),
  })).optional(),
  metadata: z.object({
    duration: z.number(),
    sampleRate: z.number().optional(),
    channels: z.number().optional(),
    format: z.string(),
  }),
});
export type AudioAnalysisResult = z.infer<typeof AudioAnalysisResultSchema>;

// Media Generation Arguments
export const MediaGenerationArgsSchema = z.object({
  prompt: z.string().min(1),
  type: GenerationTypeSchema,
  options: z.record(z.string(), z.any()).optional(),
  outputPath: z.string().optional(),
  downloadAfterGeneration: z.boolean().default(true),
});
export type MediaGenerationArgs = z.infer<typeof MediaGenerationArgsSchema>;

// ===================================
// Authentication Types and Schemas
// ===================================

// Authentication Status
export const AuthStatusSchema = z.object({
  isAuthenticated: z.boolean(),
  method: z.enum(['oauth', 'api_key', 'session']),
  expiresAt: z.date().optional(),
  userInfo: z.object({
    email: z.string().optional(),
    quotaRemaining: z.number().optional(),
    planType: z.string().optional(),
  }).optional(),
});
export type AuthStatus = z.infer<typeof AuthStatusSchema>;

// Authentication Result
export const AuthResultSchema = z.object({
  success: z.boolean(),
  status: AuthStatusSchema,
  error: z.string().optional(),
  requiresAction: z.boolean().default(false),
  actionInstructions: z.string().optional(),
});
export type AuthResult = z.infer<typeof AuthResultSchema>;

// Verification Result
export const VerificationResultSchema = z.object({
  overall: z.boolean(),
  services: z.record(z.string(), AuthResultSchema),
  recommendations: z.array(z.string()),
});
export type VerificationResult = z.infer<typeof VerificationResultSchema>;

// Enhanced error codes for authentication
export enum AuthErrorCode {
  NOT_AUTHENTICATED = 'NOT_AUTHENTICATED',
  AUTH_EXPIRED = 'AUTH_EXPIRED', 
  INVALID_CREDENTIALS = 'INVALID_CREDENTIALS',
  QUOTA_EXCEEDED = 'QUOTA_EXCEEDED',
  AUTH_METHOD_NOT_SUPPORTED = 'AUTH_METHOD_NOT_SUPPORTED',
  OAUTH_FLOW_FAILED = 'OAUTH_FLOW_FAILED',
  API_KEY_INVALID = 'API_KEY_INVALID',
  AUTH_SETUP_REQUIRED = 'AUTH_SETUP_REQUIRED'
}

// Enhanced layer error with auth context
export class AuthenticationError extends LayerError {
  constructor(
    message: string,
    layer: LayerType,
    code: AuthErrorCode,
    authContext?: {
      method?: string;
      instructions?: string;
      canRetry?: boolean;
    }
  ) {
    super(message, layer, { 
      authError: true, 
      code, 
      authContext 
    });
    this.name = 'AuthenticationError';
  }
}

// Setup Result for Interactive Setup
export const SetupResultSchema = z.object({
  success: z.boolean(),
  servicesConfigured: z.array(z.string()),
  errors: z.array(z.string()),
  nextSteps: z.array(z.string()).optional(),
});
export type SetupResult = z.infer<typeof SetupResultSchema>;

// System Capabilities
export const SystemCapabilitiesSchema = z.object({
  claudeCode: z.boolean(),
  geminiCLI: z.boolean(),
  aiStudio: z.boolean(),
  lastChecked: z.date(),
});
export type SystemCapabilities = z.infer<typeof SystemCapabilitiesSchema>;

// ===================================
// Proxy System Types
// ===================================

// Request Analysis
export const RequestAnalysisSchema = z.object({
  canEnhance: z.boolean(),
  requiredCapabilities: z.array(z.enum(['claude', 'antigravity', 'gemini', 'aistudio'])),
  fallbackToOriginal: z.boolean(),
  enhancementType: z.enum(['multimodal', 'grounding', 'reasoning', 'passthrough']),
  confidence: z.number().min(0).max(1),
  priority: z.enum(['low', 'medium', 'high']).optional(),
  estimatedComplexity: z.enum(['simple', 'moderate', 'complex']).optional(),
});
export type RequestAnalysis = z.infer<typeof RequestAnalysisSchema>;

// Enhancement Plan
export const EnhancementPlanSchema = z.object({
  enhance: z.boolean(),
  type: z.enum(['multimodal', 'grounding', 'reasoning', 'passthrough']),
  layers: z.array(z.enum(['claude', 'antigravity', 'gemini', 'aistudio'])),
  confidence: z.number().min(0).max(1),
  fallbackStrategy: z.object({
    enabled: z.boolean(),
    fallbackTo: z.array(z.enum(['claude', 'antigravity', 'gemini', 'aistudio'])),
  }).optional(),
  estimatedDuration: z.number().optional(),
});
export type EnhancementPlan = z.infer<typeof EnhancementPlanSchema>;

// Claude Request
export const ClaudeRequestSchema = z.object({
  args: z.array(z.string()),
  originalCommand: z.string(),
  workingDirectory: z.string().optional(),
  environment: z.record(z.string(), z.string()).optional(),
  timestamp: z.date().default(() => new Date()),
});
export type ClaudeRequest = z.infer<typeof ClaudeRequestSchema>;

// Claude Response
export const ClaudeResponseSchema = z.object({
  success: z.boolean(),
  output: z.string().optional(),
  error: z.string().optional(),
  exitCode: z.number().optional(),
  enhanced: z.boolean().default(false),
  metadata: z.object({
    executionTime: z.number(),
    enhancementUsed: z.string().optional(),
    layersInvolved: z.array(z.string()).optional(),
    cost: z.number().optional(),
  }).optional(),
});
export type ClaudeResponse = z.infer<typeof ClaudeResponseSchema>;

// Available Capabilities
export const AvailableCapabilitiesSchema = z.object({
  claudeCode: z.object({
    available: z.boolean(),
    version: z.string().optional(),
    authenticated: z.boolean(),
    path: z.string().optional(),
  }),
  geminiCLI: z.object({
    available: z.boolean(),
    version: z.string().optional(),
    authenticated: z.boolean(),
    path: z.string().optional(),
  }),
  aiStudio: z.object({
    available: z.boolean(),
    authenticated: z.boolean(),
    mcpServerAvailable: z.boolean(),
  }),
  lastChecked: z.date(),
});
export type AvailableCapabilities = z.infer<typeof AvailableCapabilitiesSchema>;

// ===================================
// Additional Types for Workflow Processing
// ===================================

// Multimodal File
export const MultimodalFileSchema = z.object({
  path: z.string(),
  type: FileTypeSchema,
  size: z.number().optional(),
  encoding: z.string().optional(),
  content: z.string().optional(),
  name: z.string().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
});
export type MultimodalFile = z.infer<typeof MultimodalFileSchema>;

// Multimodal Process Result
export const MultimodalProcessResultSchema = z.object({
  success: z.boolean(),
  content: z.string(),
  files_processed: z.array(z.string()),
  processing_time: z.number(),
  workflow_used: WorkflowTypeSchema,
  layers_involved: z.array(LayerTypeSchema),
  metadata: z.object({
    total_duration: z.number(),
    tokens_used: z.number().optional(),
    cost: z.number().optional(),
    quality_level: QualityLevelSchema.optional(),
  }),
  error: z.string().optional(),
});
export type MultimodalProcessResult = z.infer<typeof MultimodalProcessResultSchema>;

// Workflow Definition
export const WorkflowDefinitionSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  steps: z.array(WorkflowStepSchema),
  dependencies: z.record(z.string(), z.array(z.string())).optional(),
  fallbackStrategies: z.record(z.string(), z.object({
    replace: z.string(),
    with: WorkflowStepSchema,
  })).optional(),
  timeout: z.number().optional(),
  phases: z.array(z.array(z.string())).optional(), // For parallel execution phases
  parallel: z.boolean().optional(), // Allow parallel execution
  continueOnError: z.boolean().optional(), // Continue workflow on step failure
});
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;

// Workflow Execution Plan
export const WorkflowExecutionPlanSchema = z.object({
  id: z.string(),
  workflow: WorkflowDefinitionSchema,
  input_data: z.record(z.string(), z.any()),
  execution_mode: ExecutionModeSchema,
  estimated_duration: z.number().optional(),
  estimated_cost: z.number().optional(),
  priority: z.enum(['low', 'medium', 'high']).optional(),
  created_at: z.date().default(() => new Date()),
});
export type WorkflowExecutionPlan = z.infer<typeof WorkflowExecutionPlanSchema>;

// Resource Estimate
export const ResourceEstimateSchema = z.object({
  estimated_duration: z.number(), // milliseconds
  estimated_cost: z.number().optional(), // USD
  estimated_tokens: z.number().optional(),
  complexity_score: z.number().min(0).max(10),
  recommended_execution_mode: ExecutionModeSchema,
  required_capabilities: z.array(z.enum(['claude', 'antigravity', 'gemini', 'aistudio'])),
});
export type ResourceEstimate = z.infer<typeof ResourceEstimateSchema>;

// ===================================
// AI Model Constants
// ===================================

/**
 * Model IDs for the AI Studio (Gemini API) layer.
 *
 * The live catalogue is the only authority: `GET /v1beta/models` is what the
 * API will actually accept, and a plausible-looking ID is not the same as an
 * existing one. `gemini-2.0-flash-exp` sat in this codebase as a default for
 * image and multimodal analysis long after Google shut the 2.0 Flash line
 * down; it is absent from the catalogue, so every call that used the default
 * would have been rejected.
 *
 * Being listed is not the same as being reachable, either. On 2026-09-18
 * Google limited the Gemini 2.5 models to accounts that had already been
 * using them (Gemini API release notes). They are not deprecated, but a
 * fresh API key is refused -- so a 2.5 default works for long-time users and
 * fails for everyone who installs CGMB today. Vertex AI, a separate platform,
 * is reported to retire the 2.5 line outright in October 2026.
 *
 * Google recommends gemini-3.5-flash-lite (or gemini-3.8-flash) for new
 * projects. 3.5 Flash-Lite is the default here: 1,048,576-token context, ~65K
 * output, and $0.30 in / $2.50 out per 1M tokens -- exactly what 2.5 Flash
 * cost, so moving off 2.5 changes nothing on the bill. 3.8 Flash ($0.75/$3.75
 * until 2026-12-31, then $1.50/$7.50) is an upgrade, not a fix.
 */
export const AI_MODELS = {
  // Image generation. Google's named replacement for gemini-2.5-flash-image
  // (retiring 2027-03-15). About $0.034 per image; output is limited to 1K
  // resolution, aspectRatio options unchanged.
  IMAGE_GENERATION: 'gemini-3.1-flash-lite-image',

  // Audio generation. gemini-3.1-flash-tts-preview is now a legacy preview;
  // Google points migrations here. Unlike earlier TTS models, a unary
  // generateContent call returns a complete WAV file (audio/wav), not raw
  // PCM -- see utils/wavAudio.ts.
  AUDIO_GENERATION: 'gemini-3.8-flash-tts',

  // General purpose models
  GEMINI_FLASH: 'gemini-3.5-flash-lite',

  // Document processing; 1M-token context.
  DOCUMENT_PROCESSING: 'gemini-3.5-flash-lite',

  /**
   * Image and multimodal understanding.
   *
   * Replaces the `gemini-2.0-flash-exp` that was hardcoded at six call sites.
   * Every Gemini model takes image input, so this follows GEMINI_FLASH rather
   * than paying for a larger model.
   */
  MULTIMODAL_ANALYSIS: 'gemini-3.5-flash-lite',

  // Default multimodal model
  MULTIMODAL_DEFAULT: 'gemini-3.5-flash-lite'
} as const;

// Type for AI model values
export type AIModelName = typeof AI_MODELS[keyof typeof AI_MODELS];

// ===================================
// Antigravity CLI (agy) Models
// ===================================

/**
 * Models the Antigravity CLI (`agy`) has been reported to serve.
 *
 * IMPORTANT: this is a DIFFERENT catalogue from AI_MODELS above. AI_MODELS
 * targets the AI Studio / Gemini API and is unaffected by the CLI migration.
 *
 * This is a snapshot, not a contract. It copies one `agy models` listing
 * reported on agy 1.2.16 (pingdotgg/t3code#15378, October 2026). The catalogue
 * depends on the signed-in account and plan: another account on agy 1.3.3 in
 * the same issue still saw claude-sonnet-4-6 and claude-opus-4-6-thinking
 * instead of the 5.5 entries. Running `agy models` on the user's own machine is
 * the only authority, and slugs are not guaranteed to mean what they say
 * (antigravity-cli#687 reports `gemini-3.1-pro-high` resolving to 3.6 Flash on
 * 1.1.7).
 *
 * Informational only. Nothing validates a requested model against this list:
 * it exists to give AntigravityModelName (and so DEFAULT_ANTIGRAVITY_MODEL) a
 * type. Any other ID is passed through to `agy --model` unchanged, and agy
 * itself decides whether it is valid; only RETIRED_GEMINI_CLI_MODEL_PATTERN is
 * remapped. Do not add rejection logic based on this list.
 */
export const ANTIGRAVITY_MODELS = [
  'gemini-3.8-flash-high',
  'gemini-3.8-flash-medium',
  'gemini-3.8-flash-low',
  'gemini-3.7-flash-high',
  'gemini-3.7-flash-medium',
  'gemini-3.7-flash-low',
  'gemini-3.6-flash-high',
  'gemini-3.6-flash-medium',
  'gemini-3.6-flash-low',
  'gemini-3.1-pro-high',
  'gemini-3.1-pro-low',
  'claude-opus-5-5-low',
  'claude-opus-5-5-medium',
  'claude-opus-5-5-high',
  'claude-sonnet-5-5-low',
  'claude-sonnet-5-5-medium',
  'claude-sonnet-5-5-high',
  'gpt-oss-120b-medium',
] as const;

export type AntigravityModelName = typeof ANTIGRAVITY_MODELS[number];

/**
 * Default model for search / translation through the Antigravity CLI.
 *
 * The lowest Flash tier. It was in the agy 1.1.7 catalogue this file used to
 * carry and is still in the 1.2.16 listing above; override it with
 * ANTIGRAVITY_MODEL or `--model` if `agy models` on your machine says otherwise.
 */
export const DEFAULT_ANTIGRAVITY_MODEL: AntigravityModelName = 'gemini-3.6-flash-low';

/**
 * Model IDs that were valid for the retired Gemini CLI but do not exist in
 * Antigravity. Configs, .env files and saved CLI flags in the wild still carry
 * these, so they are mapped onto the default instead of being sent to `agy`,
 * which would reject them.
 */
export const RETIRED_GEMINI_CLI_MODEL_PATTERN = /^gemini-(1\.|2\.|pro|3-flash|3-pro)/i;

// ===================================
// Log hygiene
// ===================================
//
// Logger metadata goes to stderr (Claude Code's MCP log) and to LOG_FILE
// unredacted. Prompts, tool arguments and child-process output can carry
// signed-URL tokens, pasted secrets or personal data, so log lines describe
// them -- keys, lengths, counts, hosts -- instead of copying them.

/**
 * A URL with an authority anywhere in free text: a scheme, `://`, then
 * everything up to a space or quote. What urlsIn() finds, so what hostsOf()
 * reports hosts for.
 */
const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`]+/gi;

/** Where a token for redaction may start: not in the middle of a word, path, host or address. */
const TOKEN_START = String.raw`(?<![\w.\/\\@:+-])`;
/** The rest of a token: everything up to a space, a quote or an angle bracket. */
const TOKEN_REST = String.raw`[^\s"'<>\x60]`;

/**
 * What redactUrls() cuts, as three alternatives tried in this order:
 *
 *   1. `scheme:` and anything not a space -- `https://…`, `data:…`, `mailto:…`.
 *      The scheme is two characters or more, so a drive letter (`C:\x`) is not
 *      one, and what follows the colon may not start with a digit, so neither
 *      is a time (`at12:30`), a port (`localhost:3000`) or a `file.ts:10:5`
 *      position. `node:` is a Node.js module specifier in a stack frame
 *      (`node:internal/...`), not a URL, and is kept.
 *   2. A bare `host.tld/path…` -- a dotted name ending in a letters-only label,
 *      then a slash. Not after a slash, so `/srv/www/example.com/a.html` is a
 *      path and is left alone.
 *   3. A bare `host.tld?query` with no slash -- cut to `host.tld?…`.
 *   4. Any path-like token (one with a `/`) followed by a `?…` or `#…` tail.
 *
 * Every alternative starts at TOKEN_START, so nothing matches from the middle of
 * a file path or a word.
 */
const HOST_IN_TEXT = String.raw`(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}(?::\d{1,5})?`;
const REDACTABLE_IN_TEXT = new RegExp(
  `${TOKEN_START}(?:` +
    String.raw`(?!node:)(?<scheme>[a-z][a-z0-9+.-]+):(?<opaque>(?![\d\s])${TOKEN_REST}+)` +
    String.raw`|(?<host>${HOST_IN_TEXT})\/${TOKEN_REST}*` +
    String.raw`|(?<qhost>${HOST_IN_TEXT})\?${TOKEN_REST}+` +
    String.raw`|(?<path>[^\s"'<>\x60?#]*\/[^\s"'<>\x60?#]*)(?<tail>[?#])${TOKEN_REST}+` +
  ')',
  'gi'
);

/**
 * A credential after its label, as a header or a `key=value` pair carries it:
 * `Authorization: Bearer <token>`, `Bearer <token>`, `api_key=<value>`,
 * `token: <value>`. The label (and any quote or separator) is kept; the value
 * becomes `…`.
 *
 * Bearer and token values are cut only when they look like a credential --
 * see looksLikeSecret() -- so `token: 3 retries` and "the Bearer scheme" stay
 * as they are. An api key label is unambiguous, so any value after it is cut.
 */
const SECRET_CHARS = String.raw`[A-Za-z0-9._~+/=-]`;
const LABELLED_SECRET = new RegExp(
  String.raw`(?<bearer>\bbearer\s+)(?<bearerValue>${SECRET_CHARS}+)` +
  String.raw`|(?<apiKey>(?<![A-Za-z0-9])api[_-]?key["']?\s*[=:]\s*["']?)(?<apiKeyValue>[^\s"'<>,;&\x60]+)` +
  String.raw`|(?<token>(?<![A-Za-z0-9])token["']?\s*[=:]\s*["']?)(?<tokenValue>${SECRET_CHARS}+)`,
  'gi'
);

/**
 * Whether a Bearer or token value looks like a credential rather than a word:
 * eight characters or more, with a digit or one of `._~+/=` in it, or twenty
 * characters or more whatever they are.
 */
function looksLikeSecret(value: string): boolean {
  if (value.length >= 20) {
    return true;
  }
  return value.length >= 8 && /[\d._~+/=]/.test(value);
}

/** A path-like token: one with a `/`, up to a space, a quote or an angle bracket. */
const PATH_TOKEN_IN_TEXT = /[^\s"'<>`]*\/[^\s"'<>`]*/g;

/**
 * A path segment that looks like a token: twenty or more of `[A-Za-z0-9_-]`
 * with a digit and a letter among them, between slashes (or the token's ends).
 * A segment followed by `.` is a file name (`report_quarterly_final_v2.pdf`)
 * and a segment with no digit is a name (`claude-gemini-multimodal-bridge`);
 * neither is cut.
 */
const TOKEN_SEGMENT = /(?<=^|\/)(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{20,}(?=$|\/|[^A-Za-z0-9_.-])/g;

/** The host of an opaque `scheme:` URL such as `mailto:a@host.tld?…`, if it has one. */
const OPAQUE_HOST = /@((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63})(?=$|[/?#;,&])/i;

/**
 * The distinct hosts of some URLs, for log lines. A URL's path and query can
 * carry tokens or personal data, so URLs are never logged whole.
 */
export function hostsOf(urls: readonly string[]): string[] {
  return [...new Set(urls.map(u => {
    try {
      return new URL(u).host;
    } catch {
      return '(not a URL)';
    }
  }))];
}

/** Every URL with a `scheme://` authority in `text`, in order. */
export function urlsIn(text: string): string[] {
  return text.match(URL_IN_TEXT) ?? [];
}

/** One `scheme:rest` URL as its scheme and host. */
function redactSchemeUrl(scheme: string, rest: string): string {
  const lower = scheme.toLowerCase();
  if (lower === 'data') {
    // The payload is the content itself; there is no host to keep.
    return 'data:…';
  }
  if (rest.startsWith('//')) {
    try {
      const parsed = new URL(`${scheme}:${rest}`);
      return parsed.host ? `${parsed.protocol}//${parsed.host}/…` : `${parsed.protocol}//…`;
    } catch {
      return `${scheme}://…`;
    }
  }
  // An opaque URL (mailto:, tel:, urn:, ...). The part before an `@` is a
  // person, not a host; only the domain after it is kept.
  const host = OPAQUE_HOST.exec(rest)?.[1];
  return host ? `${scheme}:…@${host}` : `${scheme}:…`;
}

/**
 * `text` with every URL cut down to its scheme and host, every bare
 * `host.tld/path` cut down to its host, a bare `host.tld?query` to
 * `host.tld?…`, and the `?…` / `#…` tail of any other path-like token dropped
 * (see REDACTABLE_IN_TEXT). Also: the value after a credential label --
 * `Bearer`, `api_key=`, `token:` -- becomes `…` (LABELLED_SECRET), and in a
 * path-like token with no query, a segment that looks like a token becomes `…`
 * (TOKEN_SEGMENT).
 */
export function redactUrls(text: string): string {
  const unlabelled = text.replace(LABELLED_SECRET, (match: string, ...args: unknown[]) => {
    const groups = args[args.length - 1] as Partial<Record<
      'bearer' | 'bearerValue' | 'apiKey' | 'apiKeyValue' | 'token' | 'tokenValue', string
    >>;
    if (groups.bearer !== undefined && groups.bearerValue !== undefined) {
      return looksLikeSecret(groups.bearerValue) ? `${groups.bearer}…` : match;
    }
    if (groups.apiKey !== undefined) {
      return `${groups.apiKey}…`;
    }
    if (groups.token !== undefined && groups.tokenValue !== undefined) {
      return looksLikeSecret(groups.tokenValue) ? `${groups.token}…` : match;
    }
    return match;
  });

  const cut = unlabelled.replace(REDACTABLE_IN_TEXT, (match: string, ...args: unknown[]) => {
    const groups = args[args.length - 1] as Partial<Record<'scheme' | 'opaque' | 'host' | 'qhost' | 'path' | 'tail', string>>;
    if (groups.scheme !== undefined && groups.opaque !== undefined) {
      return redactSchemeUrl(groups.scheme, groups.opaque);
    }
    if (groups.host !== undefined) {
      return `${groups.host}/…`;
    }
    if (groups.qhost !== undefined) {
      return `${groups.qhost}?…`;
    }
    if (groups.path !== undefined && groups.tail !== undefined) {
      return `${groups.path}${groups.tail}…`;
    }
    return match;
  });

  // Only where there is no query: with one, the query is what was cut above.
  return cut.replace(PATH_TOKEN_IN_TEXT, token => /[?#]/.test(token) ? token : token.replace(TOKEN_SEGMENT, '…'));
}

/**
 * One line of child-process output fit for a log: the first non-empty line,
 * URLs reduced to hosts, at most `max` characters. Redaction runs before the
 * cut, so a truncated URL cannot leave half a token behind.
 */
export function firstLineForLog(text: string, max = 200): string {
  const line = text.split(/\r?\n/).map(l => l.trim()).find(l => l.length > 0) ?? '';
  const safe = redactUrls(line);
  return safe.length > max ? `${safe.slice(0, max)}…` : safe;
}

/**
 * A caught error as one line fit for a warn or error log: its message's first
 * line, redacted and capped as firstLineForLog() does. A failure message can
 * quote a signed URL, a path or a child process's output; the thrown error
 * keeps all of it for the caller.
 */
export function errorForLog(error: unknown): string {
  return firstLineForLog(error instanceof Error ? error.message : String(error));
}

/**
 * What an MCP tool call's arguments look like, without their contents: the
 * argument keys, the prompt's length, how many files, and the hosts of any
 * URLs anywhere in them.
 */
export function describeToolArgs(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { argsType: Array.isArray(args) ? 'array' : typeof args };
  }
  const source = args as Record<string, unknown>;
  const summary: Record<string, unknown> = { argKeys: Object.keys(source) };

  if (typeof source.prompt === 'string') {
    summary.promptLength = source.prompt.length;
  }
  const counted = ['files', 'documents'].filter(key => Array.isArray(source[key]));
  if (counted.length > 0) {
    summary.fileCount = counted.reduce((n, key) => n + (source[key] as unknown[]).length, 0);
  }
  if (typeof source.targetLayer === 'string' && TargetLayerSchema.safeParse(source.targetLayer).success) {
    summary.targetLayer = source.targetLayer;
  }

  let serialised = '';
  try {
    serialised = JSON.stringify(source) ?? '';
  } catch {
    // A cycle or a BigInt; there is nothing to scan.
  }
  const urls = urlsIn(serialised);
  if (urls.length > 0) {
    summary.urlCount = urls.length;
    summary.urlHosts = hostsOf(urls);
  }
  return summary;
}

// ===================================
// Which files may leave the machine
// ===================================
//
// The AI Studio MCP server (assertReadableRoot) and LayerManager (which files
// Claude may be given inline) share one notion of the allowed directories:
// the directory the process started in, plus CGMB_ALLOWED_ROOTS.

/** The allowed directories, in the two forms a path is compared against. */
export interface AllowedRoots {
  /** Each root through realpath: what a resolved file must sit inside. */
  readonly real: readonly string[];
  /**
   * Each root as configured (resolved, not through symlinks), plus its real
   * form: what a path *as given* must sit inside before anything on disk is
   * looked at.
   */
  readonly given: readonly string[];
}

/**
 * Resolve the allowed directories from the working directory and
 * CGMB_ALLOWED_ROOTS (delimiter-separated). An entry that does not exist is
 * skipped and reported to `onMissing`.
 */
export function resolveAllowedRoots(
  onMissing?: (entry: string) => void,
  env: NodeJS.ProcessEnv = process.env
): AllowedRoots {
  const cwd = process.cwd();
  const raw = [
    cwd,
    ...(env.CGMB_ALLOWED_ROOTS ?? '')
      .split(delimiter)
      .map(entry => entry.trim())
      .filter(entry => entry !== ''),
  ];

  const real: string[] = [];
  const given: string[] = [];
  const add = (list: string[], value: string): void => {
    if (!list.includes(value)) {
      list.push(value);
    }
  };
  for (const entry of raw) {
    try {
      const resolved = realpathSync(resolvePath(entry));
      add(real, resolved);
      add(given, resolvePath(entry));
      add(given, resolved);
    } catch {
      onMissing?.(entry);
    }
  }

  // The shell's name for the working directory, when it reaches the same
  // place: process.cwd() is the physical path, and a caller quoting a path
  // under $PWD (a symlinked home, macOS /tmp) means the same directory.
  const pwd = env.PWD;
  if (pwd && isAbsolute(pwd)) {
    try {
      if (realpathSync(pwd) === realpathSync(cwd)) {
        add(given, resolvePath(pwd));
      }
    } catch {
      // Not a directory any more; nothing to add.
    }
  }

  return { real, given };
}

/** True when `target` (absolute) is one of `roots` or inside one. */
export function isWithinRoots(target: string, roots: readonly string[]): boolean {
  return roots.some(root => {
    const rel = relative(root, target);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  });
}

/**
 * Where a caller-supplied path stands against the allowed directories.
 *
 *   - 'outside': the path as given is outside every root, or it resolves
 *     (through `..` or a symlink) to somewhere outside. Nothing on disk outside
 *     the roots was consulted to decide the first case, and the second is
 *     reported the same way, so a caller cannot tell an existing file outside
 *     the roots from a missing one.
 *   - 'missing': inside the roots, and nothing is there.
 *   - 'error': inside the roots, and it could not be resolved for another
 *     reason (`code`).
 *   - 'inside': the realpath, to read through -- resolving again later would
 *     reopen the gap this check closes.
 */
export type RootsVerdict =
  | { kind: 'inside'; resolved: string }
  | { kind: 'outside' }
  | { kind: 'missing' }
  | { kind: 'error'; code: string };

export function checkAgainstRoots(filePath: string, roots: AllowedRoots): RootsVerdict {
  const asGiven = resolvePath(filePath);
  if (!isWithinRoots(asGiven, roots.given)) {
    return { kind: 'outside' };
  }

  let resolved: string;
  try {
    resolved = realpathSync(asGiven);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown';
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      // A dangling link is something that is there; whether its target is
      // outside the roots is not this caller's to learn.
      try {
        lstatSync(asGiven);
        return { kind: 'outside' };
      } catch {
        return { kind: 'missing' };
      }
    }
    return { kind: 'error', code };
  }

  return isWithinRoots(resolved, roots.real) ? { kind: 'inside', resolved } : { kind: 'outside' };
}

let processRoots: AllowedRoots | undefined;

/** This process's allowed directories, resolved on first use. */
export function allowedRoots(): AllowedRoots {
  processRoots ??= resolveAllowedRoots();
  return processRoots;
}
