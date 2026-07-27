import { z } from 'zod';

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
export const TargetLayerSchema = z.enum(['antigravity', 'gemini', 'aistudio', 'adaptive']);
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
  input: z.record(z.any()),
  dependsOn: z.array(z.string()).optional(),
  timeout: z.number().optional(),
  retries: z.number().optional(),
});
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;

export const ExecutionPlanSchema = z.object({
  steps: z.array(WorkflowStepSchema),
  dependencies: z.record(z.array(z.string())).optional(),
  fallbackStrategies: z.record(z.object({
    replace: z.string(),
    with: WorkflowStepSchema,
  })).optional(),
  timeout: z.number().optional(),
});
export type ExecutionPlan = z.infer<typeof ExecutionPlanSchema>;

export const WorkflowDefinitionArgsSchema = z.object({
  workflow_definition: ExecutionPlanSchema,
  input_data: z.record(z.any()),
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
  }),
});
export type LayerResult = z.infer<typeof LayerResultSchema>;

export const WorkflowResultSchema = z.object({
  success: z.boolean(),
  results: z.union([z.record(LayerResultSchema), z.array(LayerResultSchema)]),
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
    model: z.string().default('gemini-2.5-pro'),
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
  technical_details: z.record(z.any()).optional(),
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

// Grounding Context for Gemini CLI
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
  example: z.record(z.any()),
  limitations: z.array(z.string()).optional()
});
export type LayerRequirements = z.infer<typeof LayerRequirementsSchema>;

// Formatted data for each layer
export const FormattedLayerDataSchema = z.object({
  geminiFormat: z.object({
    stdin: z.string(),
    args: z.array(z.string())
  }).optional(),
  aistudioFormat: z.object({
    apiData: z.record(z.any()),
    files: z.array(z.string()) // base64 encoded
  }).optional()
});
export type FormattedLayerData = z.infer<typeof FormattedLayerDataSchema>;

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
    settings: z.record(z.any()),
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
    metadata: z.record(z.any()).optional(),
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
  options: z.record(z.any()).optional(),
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
  services: z.record(AuthResultSchema),
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
  environment: z.record(z.string()).optional(),
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
  metadata: z.record(z.any()).optional(),
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
  dependencies: z.record(z.array(z.string())).optional(),
  fallbackStrategies: z.record(z.object({
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
  input_data: z.record(z.any()),
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
 * Choices below are the cheaper option wherever the newer generation is only
 * an upgrade rather than a fix -- 2.5 Flash is current, has a free tier, and
 * costs a fifth of 3.6 Flash on input.
 */
export const AI_MODELS = {
  // Image generation. 2.5 Flash Image bills $0.039/image against $0.067 for
  // 3.1 Flash Image, and both are current.
  IMAGE_GENERATION: 'gemini-2.5-flash-image',
  // The GA build of the same model the preview ID pointed at, at the same price.
  IMAGE_GENERATION_PRO: 'gemini-3-pro-image',

  // Audio generation. The only TTS models Google publishes are previews; this
  // is the generation its docs point at for speech.
  AUDIO_GENERATION: 'gemini-3.1-flash-tts-preview',

  // General purpose models
  GEMINI_FLASH: 'gemini-2.5-flash',
  GEMINI_FLASH_3: 'gemini-3-flash-preview',
  GEMINI_FLASH_3_PRO: 'gemini-3-pro-preview',

  // Document processing model with 1M token context
  DOCUMENT_PROCESSING: 'gemini-2.5-flash',

  /**
   * Image and multimodal understanding.
   *
   * Replaces the `gemini-2.0-flash-exp` that was hardcoded at six call sites.
   * Google's image-understanding guide demonstrates gemini-3.5-flash, but every
   * Gemini model takes image input and 2.5 Flash costs $0.30/$2.50 against
   * $1.50/$9.00 -- so the fix here is removing a model that no longer exists,
   * not moving generation.
   */
  MULTIMODAL_ANALYSIS: 'gemini-2.5-flash',

  // Default multimodal model
  MULTIMODAL_DEFAULT: 'gemini-2.5-flash'
} as const;

// Type for AI model values
export type AIModelName = typeof AI_MODELS[keyof typeof AI_MODELS];

// ===================================
// Antigravity CLI (agy) Models
// ===================================

/**
 * Models served by the Antigravity CLI (`agy`).
 *
 * IMPORTANT: this is a DIFFERENT catalogue from AI_MODELS above. AI_MODELS
 * targets the AI Studio / Gemini API and is unaffected by the CLI migration.
 * The authoritative source for the list below is the output of `agy models`;
 * never invent an ID. Verified against agy v1.1.7 on 2026-07-25.
 */
export const ANTIGRAVITY_MODELS = [
  'gemini-3.6-flash-high',
  'gemini-3.6-flash-medium',
  'gemini-3.6-flash-low',
  'gemini-3.5-flash-high',
  'gemini-3.5-flash-medium',
  'gemini-3.5-flash-low',
  'gemini-3.1-pro-high',
  'gemini-3.1-pro-low',
  'claude-sonnet-4-6',
  'claude-opus-4-6-thinking',
  'gpt-oss-120b-medium',
] as const;

export type AntigravityModelName = typeof ANTIGRAVITY_MODELS[number];

/** Default model for search / translation through the Antigravity CLI. */
export const DEFAULT_ANTIGRAVITY_MODEL: AntigravityModelName = 'gemini-3.6-flash-low';

/**
 * Model IDs that were valid for the retired Gemini CLI but do not exist in
 * Antigravity. Configs, .env files and saved CLI flags in the wild still carry
 * these, so they are mapped onto the default instead of being sent to `agy`,
 * which would reject them.
 */
export const RETIRED_GEMINI_CLI_MODEL_PATTERN = /^gemini-(1\.|2\.|pro|3-flash|3-pro)/i;