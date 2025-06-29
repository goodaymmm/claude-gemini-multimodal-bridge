import { z } from 'zod';

// ===================================
// Core Types and Schemas
// ===================================

// Layer Types
export type LayerType = 'claude' | 'gemini' | 'aistudio';
export type ExecutionMode = 'sequential' | 'parallel' | 'adaptive';
export type QualityLevel = 'fast' | 'balanced' | 'quality';
export type WorkflowType = 'analysis' | 'conversion' | 'extraction' | 'generation';

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

// Processing Options
export const ProcessingOptionsSchema = z.object({
  layer_priority: z.enum(['claude', 'gemini', 'aistudio', 'adaptive']).optional(),
  execution_mode: z.enum(['sequential', 'parallel', 'adaptive']).optional(),
  output_format: z.string().optional(),
  quality_level: z.enum(['fast', 'balanced', 'quality']).optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().positive().optional(),
  timeout: z.number().positive().optional(),
  use_cache: z.boolean().optional(),
});
export type ProcessingOptions = z.infer<typeof ProcessingOptionsSchema>;

// Tool Input Schemas
export const MultimodalProcessArgsSchema = z.object({
  prompt: z.string().min(1),
  files: z.array(FileReferenceSchema),
  workflow: z.enum(['analysis', 'conversion', 'extraction', 'generation']),
  options: ProcessingOptionsSchema.optional(),
});
export type MultimodalProcessArgs = z.infer<typeof MultimodalProcessArgsSchema>;

export const DocumentAnalysisArgsSchema = z.object({
  documents: z.array(z.string().min(1)),
  analysis_type: z.enum(['summary', 'comparison', 'extraction', 'translation']),
  output_requirements: z.string().optional(),
  options: ProcessingOptionsSchema.optional(),
});
export type DocumentAnalysisArgs = z.infer<typeof DocumentAnalysisArgsSchema>;

// Workflow Definitions
export const WorkflowStepSchema = z.object({
  id: z.string(),
  layer: z.enum(['claude', 'gemini', 'aistudio']),
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
    layer: z.enum(['claude', 'gemini', 'aistudio']),
    duration: z.number(),
    tokens_used: z.number().optional(),
    cost: z.number().optional(),
    model: z.string().optional(),
  }),
});
export type LayerResult = z.infer<typeof LayerResultSchema>;

export const WorkflowResultSchema = z.object({
  success: z.boolean(),
  results: z.record(LayerResultSchema),
  summary: z.string().optional(),
  metadata: z.object({
    total_duration: z.number(),
    steps_completed: z.number(),
    steps_failed: z.number(),
    total_cost: z.number().optional(),
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
  gemini: z.object({
    api_key: z.string(),
    model: z.string().default('gemini-2.5-flash'),
    timeout: z.number().default(60000),
    max_tokens: z.number().default(16384),
    temperature: z.number().default(0.2),
  }),
  claude: z.object({
    code_path: z.string().default('/usr/local/bin/claude'),
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
export const ImageAnalysisTypeSchema = z.enum(['detailed', 'technical', 'extract_text']);
export type ImageAnalysisType = z.infer<typeof ImageAnalysisTypeSchema>;

export const ImageAnalysisResultSchema = z.object({
  type: ImageAnalysisTypeSchema,
  description: z.string(),
  extracted_text: z.string().optional(),
  technical_details: z.record(z.any()).optional(),
  confidence: z.number().min(0).max(1).optional(),
});
export type ImageAnalysisResult = z.infer<typeof ImageAnalysisResultSchema>;

export const MultimodalResultSchema = z.object({
  content: z.string(),
  files_processed: z.array(z.string()),
  processing_time: z.number(),
  tokens_used: z.number().optional(),
  model_used: z.string(),
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
  recommendedLayer: z.enum(['claude', 'gemini', 'aistudio']),
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
  requiredCapabilities: z.array(z.enum(['claude', 'gemini', 'aistudio'])),
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
  layers: z.array(z.enum(['claude', 'gemini', 'aistudio'])),
  confidence: z.number().min(0).max(1),
  fallbackStrategy: z.object({
    enabled: z.boolean(),
    fallbackTo: z.array(z.enum(['claude', 'gemini', 'aistudio'])),
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