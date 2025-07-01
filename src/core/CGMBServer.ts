import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  CallToolResult,
  ErrorCode,
  ListToolsRequestSchema,
  ListToolsResult,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

import { LayerManager } from './LayerManager.js';
import { logger } from '../utils/logger.js';
import { safeExecute } from '../utils/errorHandler.js';
import {
  CGMBError,
  DocumentAnalysisArgs,
  DocumentAnalysisArgsSchema,
  MultimodalProcessArgs,
  MultimodalProcessArgsSchema,
  WorkflowDefinitionArgs,
  WorkflowDefinitionArgsSchema,
  EnhancedCGMBRequest,
  EnhancedCGMBRequestSchema,
  WorkflowResult,
} from './types.js';
import { Config, ConfigSchema } from './types.js';

// ===================================
// Claude-Gemini Multimodal Bridge Server
// ===================================

export class CGMBServer {
  private server: Server;
  private layerManager: LayerManager;
  private config: Config;
  private initialized = false;

  constructor(config?: Partial<Config>) {
    // Initialize server with metadata
    this.server = new Server(
      {
        name: 'claude-gemini-multimodal-bridge',
        version: '1.0.0',
        description: 'CGMB - AI multimodal processor with intelligent web search, file analysis, and content generation. Claude-Gemini Multimodal Bridge for seamless AI integration.'
      },
      {
        capabilities: {
          tools: {},
          resources: {},
          prompts: {},
        },
      }
    );

    // Parse and validate configuration
    this.config = ConfigSchema.parse({
      ...this.getDefaultConfig(),
      ...config,
    });

    this.layerManager = new LayerManager(this.config);
    this.setupErrorHandling();
    this.registerTools();
  }

  /**
   * Initialize the server and all layers
   */
  public async initialize(): Promise<void> {
    try {
      logger.info('Initializing CGMB Server...');

      // Verify dependencies
      await this.verifyDependencies();

      // Initialize all layers
      await this.layerManager.initializeLayers();

      this.initialized = true;
      logger.info('CGMB Server initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize CGMB Server', error as Error);
      throw new CGMBError(
        'Server initialization failed',
        'INIT_ERROR',
        undefined,
        { originalError: error }
      );
    }
  }

  /**
   * Start the server
   */
  public async start(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }

    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    
    logger.info('CGMB Server started and listening...');
  }

  /**
   * Stop the server gracefully
   */
  public async stop(): Promise<void> {
    try {
      logger.info('Stopping CGMB Server...');
      
      // Close the server connection
      if (this.server) {
        await this.server.close();
      }
      
      // Cleanup resources if needed
      // (Add any additional cleanup logic here)
      
      logger.info('CGMB Server stopped successfully');
    } catch (error) {
      logger.error('Error stopping CGMB Server', error as Error);
      throw error;
    }
  }

  /**
   * Register all MCP tools
   */
  private registerTools(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async (): Promise<ListToolsResult> => {
      return {
        tools: [
          {
            name: 'cgmb_get_layer_requirements',
            description: '📋 Get formatting requirements and capabilities for each AI layer. Use this to understand how to format data for optimal processing by Gemini CLI or AI Studio.',
            inputSchema: {
              type: 'object',
              properties: {},
              additionalProperties: false
            },
          },
          {
            name: 'cgmb',
            description: '🎯 **USE WHEN PROMPT CONTAINS "CGMB" KEYWORD** - Claude-Gemini Multimodal Bridge. Intelligently routes to Gemini CLI (web search, analysis) or AI Studio (multimodal processing) based on your request. Simply include "CGMB" in your prompt. Examples: "CGMB analyze this image", "CGMB search latest AI news", "CGMB process this document"',
            inputSchema: {
              type: 'object',
              properties: {
                prompt: {
                  type: 'string',
                  description: 'User prompt (must contain CGMB keyword for optimal processing)',
                },
                targetLayer: {
                  type: 'string',
                  enum: ['gemini', 'aistudio', 'adaptive'],
                  description: 'Target layer for direct routing (optional)',
                },
                preformatted: {
                  type: 'boolean',
                  description: 'Whether the data is already formatted for the target layer',
                  default: false,
                },
                formattedData: {
                  type: 'object',
                  description: 'Pre-formatted data for layers (when preformatted=true)',
                  properties: {
                    geminiFormat: {
                      type: 'object',
                      properties: {
                        stdin: { type: 'string' },
                        args: { type: 'array', items: { type: 'string' } }
                      }
                    },
                    aistudioFormat: {
                      type: 'object',
                      properties: {
                        apiData: { type: 'object' },
                        files: { type: 'array', items: { type: 'string' } }
                      }
                    }
                  }
                },
                files: {
                  type: 'array',
                  description: 'Optional files to process',
                  items: {
                    type: 'object',
                    properties: {
                      path: { type: 'string', description: 'File path' },
                      type: {
                        type: 'string',
                        enum: ['image', 'audio', 'pdf', 'document', 'text', 'video'],
                        description: 'File type',
                      },
                    },
                    required: ['path', 'type'],
                  },
                  default: [],
                },
                options: {
                  type: 'object',
                  description: 'Processing options',
                  properties: {
                    priority: {
                      type: 'string',
                      enum: ['fast', 'balanced', 'quality'],
                      description: 'Processing priority',
                      default: 'balanced',
                    },
                  },
                  default: {},
                },
              },
              required: ['prompt'],
            },
          },
          {
            name: 'cgmb_multimodal_process',
            description: '🎨 **For structured CGMB requests** - Multimodal processor for images, documents, and web search. Use for specific workflow requirements with CGMB. Examples: "CGMB analyze PDF", "CGMB process images"',
            inputSchema: {
              type: 'object',
              properties: {
                prompt: {
                  type: 'string',
                  description: 'Processing instructions for the multimodal content',
                },
                files: {
                  type: 'array',
                  description: 'Array of files to process',
                  items: {
                    type: 'object',
                    properties: {
                      path: { type: 'string', description: 'File path' },
                      type: {
                        type: 'string',
                        enum: ['image', 'audio', 'pdf', 'document', 'text', 'video'],
                        description: 'File type',
                      },
                    },
                    required: ['path', 'type'],
                  },
                },
                workflow: {
                  type: 'string',
                  enum: ['analysis', 'conversion', 'extraction', 'generation'],
                  description: 'Type of workflow to execute',
                },
                options: {
                  type: 'object',
                  description: 'Processing options',
                  properties: {
                    layer_priority: {
                      type: 'string',
                      enum: ['claude', 'gemini', 'aistudio', 'adaptive'],
                      description: 'Preferred layer for processing',
                    },
                    execution_mode: {
                      type: 'string',
                      enum: ['sequential', 'parallel', 'adaptive'],
                      description: 'How to execute the workflow',
                    },
                    quality_level: {
                      type: 'string',
                      enum: ['fast', 'balanced', 'quality'],
                      description: 'Quality vs speed preference',
                    },
                  },
                },
              },
              required: ['prompt', 'files', 'workflow'],
            },
          },
          {
            name: 'cgmb_document_analysis',
            description: '📄 **For document CGMB requests** - Document analysis for PDFs, text files, code files. Use with CGMB for document-specific tasks. Examples: "CGMB analyze contract", "CGMB compare documents"',
            inputSchema: {
              type: 'object',
              properties: {
                documents: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'List of document paths to analyze',
                },
                analysis_type: {
                  type: 'string',
                  enum: ['summary', 'comparison', 'extraction', 'translation'],
                  description: 'Type of analysis to perform',
                },
                output_requirements: {
                  type: 'string',
                  description: 'Specific requirements for the output format',
                },
              },
              required: ['documents', 'analysis_type'],
            },
          },
          {
            name: 'cgmb_workflow_orchestration',
            description: '🔄 **For complex CGMB workflows** - Multi-step AI workflows combining web search, document analysis, and content generation. Use with CGMB for complex tasks. Examples: "CGMB create comprehensive report", "CGMB analyze multiple sources"',
            inputSchema: {
              type: 'object',
              properties: {
                workflow_definition: {
                  type: 'object',
                  description: 'Complete workflow definition',
                  properties: {
                    steps: {
                      type: 'array',
                      description: 'Workflow steps',
                      items: { type: 'object' },
                    },
                  },
                },
                input_data: {
                  type: 'object',
                  description: 'Input data for the workflow',
                },
                execution_mode: {
                  type: 'string',
                  enum: ['sequential', 'parallel', 'adaptive'],
                  description: 'Execution strategy',
                },
              },
              required: ['workflow_definition', 'input_data'],
            },
          },
        ],
      };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
      const { name, arguments: args } = request.params;

      try {
        logger.info(`Tool called: ${name}`, { args });

        let result: CallToolResult;

        switch (name) {
          case 'cgmb_get_layer_requirements':
            result = await this.handleGetLayerRequirements();
            break;
          case 'cgmb': // Main unified CGMB tool
            result = await this.handleCGMBUnified(args);
            break;
          case 'cgmb_multimodal_process':
          case 'multimodal_process': // Backward compatibility
            result = await this.handleMultimodalProcess(args);
            break;
          case 'cgmb_document_analysis':
          case 'document_analysis': // Backward compatibility
            result = await this.handleDocumentAnalysis(args);
            break;
          case 'cgmb_workflow_orchestration':
          case 'workflow_orchestration': // Backward compatibility
            result = await this.handleWorkflowOrchestration(args);
            break;
          default:
            throw new McpError(
              ErrorCode.MethodNotFound,
              `Unknown tool: ${name}`
            );
        }

        logger.info(`Tool completed: ${name}`, {
          success: !result.isError,
          contentLength: result.content.length,
        });

        return result;
      } catch (error) {
        logger.error(`Tool failed: ${name}`, error as Error);
        
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: 'text',
              text: `Error executing ${name}: ${errorMessage}`,
            },
          ],
          isError: true,
        };
      }
    });
  }

  /**
   * Handle get layer requirements request
   */
  private async handleGetLayerRequirements(): Promise<CallToolResult> {
    const requirements = {
      gemini: {
        format: 'Text prompts via stdin with optional command-line arguments',
        requirements: [
          'Text-based prompts for search and analysis',
          'Web search queries for current information',
          'No file upload capability - text only'
        ],
        capabilities: [
          'Real-time web search',
          'Current information retrieval',
          'Fast text processing',
          'Natural language understanding'
        ],
        example: {
          stdin: 'What are the latest AI trends in 2024?',
          args: []
        },
        limitations: [
          'No direct file processing',
          'Text-only input/output',
          'Search results depend on web availability'
        ]
      },
      aistudio: {
        format: 'JSON API format with base64-encoded files',
        requirements: [
          'Multimodal files (images, PDFs, documents)',
          'Generation tasks (images, audio, video)',
          'Complex document analysis'
        ],
        capabilities: [
          'Image generation with Imagen 3',
          'Video generation with Veo 2',
          'Document processing (PDF, DOCX, etc.)',
          'Multimodal analysis',
          'File format conversion'
        ],
        example: {
          apiData: {
            prompt: 'Analyze this document and extract key points',
            model: 'gemini-2.0-flash-exp',
            generationConfig: {
              temperature: 0.7,
              maxOutputTokens: 16384
            }
          },
          files: ['base64_encoded_file_content...']
        },
        limitations: [
          'File size limits (100MB total)',
          'API quota restrictions',
          'Processing time for large files'
        ]
      },
      adaptive: {
        format: 'Automatic selection based on task requirements',
        requirements: [
          'Any type of request',
          'CGMB automatically determines best layer'
        ],
        capabilities: [
          'Intelligent routing',
          'Optimal layer selection',
          'Fallback strategies',
          'Combined layer processing'
        ],
        example: {
          prompt: 'CGMB analyze this document and search for related information',
          files: [{ path: 'document.pdf', type: 'pdf' }]
        }
      }
    };

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(requirements, null, 2)
        }
      ]
    };
  }

  /**
   * Handle unified CGMB requests - format conversion and delegation to LayerManager
   */
  private async handleCGMBUnified(args: unknown): Promise<CallToolResult> {
    return safeExecute(
      async () => {
        logger.info('CGMB unified handler starting', { 
          args: typeof args === 'object' ? JSON.stringify(args).substring(0, 200) : args 
        });

        // Parse enhanced request
        const request = this.parseEnhancedRequest(args);
        
        // Check if data is preformatted by Claude Code
        if (request.preformatted && request.formattedData) {
          logger.info('Using preformatted data from Claude Code', {
            targetLayer: request.targetLayer,
            hasGeminiFormat: !!request.formattedData.geminiFormat,
            hasAistudioFormat: !!request.formattedData.aistudioFormat
          });
          
          // Direct routing with preformatted data
          const result = await this.processPreformattedRequest(request);
          return this.formatResponse(result, true);
        }
        
        // Fallback to original processing for backward compatibility
        logger.info('Using standard processing (not preformatted)');
        
        // 1. Input validation and normalization
        const normalizedRequest = this.validateAndNormalize(args);
        logger.info('Request normalized', {
          hasCGMB: normalizedRequest.hasCGMB,
          promptLength: normalizedRequest.prompt.length,
          filesCount: normalizedRequest.files.length
        });
        
        // 2. Convert to format that each layer can understand
        const convertedRequest = this.convertForLayers(
          normalizedRequest.prompt,
          normalizedRequest.files,
          normalizedRequest.options
        );
        logger.info('Request converted for layers', {
          workflow: convertedRequest.workflow,
          optionsKeys: Object.keys(convertedRequest.options)
        });
        
        // 3. Delegate to LayerManager for intelligent routing
        logger.info('Calling LayerManager.processMultimodal...');
        const result = await this.layerManager.processMultimodal(
          convertedRequest.prompt,
          convertedRequest.files,
          convertedRequest.workflow,
          convertedRequest.options
        );
        logger.info('LayerManager.processMultimodal completed', {
          success: result.success,
          hasResults: !!result.results,
          hasSummary: !!result.summary
        });

        // 4. Format unified response
        const response = this.formatResponse(result, normalizedRequest.hasCGMB);
        logger.info('Response formatted', {
          contentLength: (response.content?.[0] as any)?.text?.length || 0
        });
        
        return response;
      },
      {
        operationName: 'cgmb_unified_process',
        timeout: this.config.claude.timeout,
      }
    );
  }

  /**
   * Parse enhanced CGMB request
   */
  private parseEnhancedRequest(args: unknown): EnhancedCGMBRequest {
    try {
      return EnhancedCGMBRequestSchema.parse(args);
    } catch (error) {
      // Fallback for backward compatibility
      logger.debug('Failed to parse as enhanced request, using basic format');
      const basicArgs = args as any;
      return {
        prompt: basicArgs.prompt || '',
        targetLayer: undefined,
        preformatted: false,
        formattedData: undefined,
        files: basicArgs.files || [],
        options: basicArgs.options || {}
      };
    }
  }

  /**
   * Process preformatted request from Claude Code
   */
  private async processPreformattedRequest(request: EnhancedCGMBRequest): Promise<WorkflowResult> {
    const targetLayer = request.targetLayer || 'adaptive';
    
    if (targetLayer === 'gemini' && request.formattedData?.geminiFormat) {
      // Direct execution on Gemini layer
      logger.info('Executing preformatted request on Gemini layer');
      const result = await this.layerManager.getGeminiLayer().executeFast({
        type: 'text_processing',
        prompt: request.formattedData.geminiFormat.stdin,
        files: [],
        useSearch: true,
        args: request.formattedData.geminiFormat.args
      });
      
      return {
        success: result.success,
        results: [result],
        metadata: {
          workflow: 'analysis',
          execution_mode: 'direct',
          total_duration: result.metadata?.duration || 0,
          steps_completed: 1,
          steps_failed: 0,
          layers_used: ['gemini'],
          optimization: 'preformatted-direct'
        }
      };
    }
    
    if (targetLayer === 'aistudio' && request.formattedData?.aistudioFormat) {
      // Direct execution on AI Studio layer
      logger.info('Executing preformatted request on AI Studio layer');
      // Implementation for AI Studio direct execution
      // This would use the preformatted API data
    }
    
    // Fallback to adaptive routing
    return this.layerManager.processMultimodal(
      request.prompt,
      request.files || [],
      'analysis',
      request.options
    );
  }

  /**
   * Validate and normalize input from Claude Code
   */
  private validateAndNormalize(args: unknown): {
    prompt: string;
    files: any[];
    options: any;
    hasCGMB: boolean;
  } {
    // Basic validation
    if (!args || typeof args !== 'object' || !('prompt' in args)) {
      throw new Error('Invalid arguments: prompt is required');
    }
    
    const { prompt, files = [], options = {} } = args as any;
    
    if (typeof prompt !== 'string' || !prompt.trim()) {
      throw new Error('Invalid prompt: must be a non-empty string');
    }

    // Simple CGMB keyword detection
    const hasCGMB = prompt.toLowerCase().includes('cgmb');

    return {
      prompt: prompt.trim(),
      files: Array.isArray(files) ? files : [],
      options: typeof options === 'object' ? options : {},
      hasCGMB
    };
  }

  /**
   * Convert input to formats that Claude Code, Gemini CLI, and AI Studio can understand
   */
  private convertForLayers(prompt: string, files: any[], options: any): {
    prompt: string;
    files: any[];
    workflow: 'analysis' | 'conversion' | 'extraction' | 'generation';
    options: any;
  } {
    // Format for each layer:
    // - Claude Code: text prompt + file references
    // - Gemini CLI: stdin-compatible, escaped arguments
    // - AI Studio: API format, base64 encoded files

    // Determine workflow (simple logic)
    let workflow: 'analysis' | 'conversion' | 'extraction' | 'generation' = 'analysis';
    const lowerPrompt = prompt.toLowerCase();
    if (lowerPrompt.includes('generat') || lowerPrompt.includes('creat')) {
      workflow = 'generation';
    } else if (lowerPrompt.includes('convert') || lowerPrompt.includes('transform')) {
      workflow = 'conversion';
    } else if (lowerPrompt.includes('extract') || lowerPrompt.includes('取得')) {
      workflow = 'extraction';
    }

    // Prepare files for processing
    const processedFiles = files.map(file => ({
      path: file.path || '',
      type: file.type || 'document',
      ...file
    }));

    // Merge options with defaults
    const processedOptions = {
      layer_priority: 'adaptive',
      execution_mode: 'adaptive',
      quality_level: 'balanced',
      ...options
    };

    return {
      prompt,
      files: processedFiles,
      workflow,
      options: processedOptions
    };
  }

  /**
   * Format unified response for Claude Code
   */
  private formatResponse(result: any, hasCGMB: boolean): CallToolResult {
    const prefix = hasCGMB ? '🎯 **CGMB**: ' : '';
    
    // Handle fast processing
    if (result.metadata?.optimization === 'fast-path-bypass') {
      const mainResult = Array.isArray(result.results) 
        ? result.results[0] 
        : Object.values(result.results || {})[0];
      
      return {
        content: [{
          type: 'text',
          text: prefix + (mainResult?.data || 'Processing completed')
        }]
      };
    }

    // Handle full processing
    return {
      content: [{
        type: 'text',
        text: prefix + (result.summary || result.content || 'Processing completed')
      }]
    };
  }

  /**
   * Handle multimodal processing requests
   */
  private async handleMultimodalProcess(args: unknown): Promise<CallToolResult> {
    return safeExecute(
      async () => {
        const validatedArgs = MultimodalProcessArgsSchema.parse(args);
        
        const result = await this.layerManager.processMultimodal(
          validatedArgs.prompt,
          validatedArgs.files,
          validatedArgs.workflow,
          validatedArgs.options
        );

        // Lightweight response for fast processing (reference implementation style)
        const isLight = result.metadata?.optimization === 'fast-path-bypass';
        
        if (isLight) {
          // Minimal response like reference implementation
          const mainResult = Array.isArray(result.results) ? result.results[0] : Object.values(result.results || {})[0];
          return {
            content: [
              {
                type: 'text',
                text: mainResult?.data || 'Processing completed'
              }
            ]
          };
        }

        // Full response for complex workflows
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      },
      {
        operationName: 'multimodal_process',
        timeout: this.config.claude.timeout,
      }
    );
  }

  /**
   * Handle document analysis requests
   */
  private async handleDocumentAnalysis(args: unknown): Promise<CallToolResult> {
    return safeExecute(
      async () => {
        const validatedArgs = DocumentAnalysisArgsSchema.parse(args);
        
        const result = await this.layerManager.analyzeDocuments(
          validatedArgs.documents,
          validatedArgs.analysis_type,
          validatedArgs.output_requirements,
          validatedArgs.options
        );

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      },
      {
        operationName: 'document_analysis',
        timeout: this.config.claude.timeout,
      }
    );
  }

  /**
   * Handle workflow orchestration requests
   */
  private async handleWorkflowOrchestration(args: unknown): Promise<CallToolResult> {
    return safeExecute(
      async () => {
        const validatedArgs = WorkflowDefinitionArgsSchema.parse(args);
        
        const result = await this.layerManager.executeWorkflow(
          validatedArgs.workflow_definition,
          validatedArgs.input_data,
          {
            executionMode: validatedArgs.execution_mode ?? 'adaptive',
            timeout: 600000, // 10 minutes for complex workflows
          }
        );

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      },
      {
        operationName: 'workflow_orchestration',
        timeout: 600000, // 10 minutes
      }
    );
  }

  /**
   * Verify all required dependencies
   */
  private async verifyDependencies(): Promise<void> {
    const checks = [
      {
        name: 'Claude Code',
        check: async () => {
          try {
            const layer = this.layerManager.getClaudeLayer();
            return await layer.isAvailable();
          } catch {
            return false;
          }
        },
      },
      {
        name: 'Gemini CLI',
        check: async () => {
          try {
            const layer = this.layerManager.getGeminiLayer();
            return await layer.isAvailable();
          } catch {
            return false;
          }
        },
      },
      {
        name: 'AI Studio MCP',
        check: async () => {
          try {
            const layer = this.layerManager.getAIStudioLayer();
            return await layer.isAvailable();
          } catch {
            return false;
          }
        },
      },
    ];

    const results = await Promise.allSettled(
      checks.map(async ({ name, check }) => {
        try {
          const available = await check();
          return { name, available, error: null };
        } catch (error) {
          return { name, available: false, error };
        }
      })
    );

    const failures = results
      .map((result, index) => ({ ...checks[index], result }))
      .filter(({ result }) => 
        result.status === 'rejected' || 
        (result.status === 'fulfilled' && !result.value.available)
      );

    if (failures.length > 0) {
      logger.warn('Some dependencies are not available:', failures);
      // Note: We continue with partial functionality rather than failing completely
    }

    logger.info('Dependency verification completed', {
      totalChecks: checks.length,
      failures: failures.length,
      available: checks.length - failures.length,
    });
  }

  /**
   * Setup global error handling
   */
  private setupErrorHandling(): void {
    process.on('unhandledRejection', (reason, promise) => {
      logger.error('Unhandled Rejection at:', { promise, reason });
    });

    process.on('uncaughtException', (error) => {
      logger.error('Uncaught Exception:', error);
      process.exit(1);
    });
  }

  /**
   * Get default configuration
   */
  private getDefaultConfig(): Config {
    return {
      gemini: {
        api_key: process.env.GEMINI_API_KEY ?? '',
        model: process.env.GEMINI_MODEL ?? 'gemini-2.5-pro',
        timeout: parseInt(process.env.GEMINI_TIMEOUT ?? '60000'),
        max_tokens: parseInt(process.env.GEMINI_MAX_OUTPUT_TOKENS ?? '16384'),
        temperature: parseFloat(process.env.GEMINI_TEMPERATURE ?? '0.2'),
      },
      claude: {
        code_path: process.env.CLAUDE_CODE_PATH ?? '/usr/local/bin/claude',
        timeout: parseInt(process.env.REQUEST_TIMEOUT ?? '300000'),
      },
      aistudio: {
        enabled: process.env.AISTUDIO_MCP_ENABLED !== 'false',
        max_files: parseInt(process.env.GEMINI_MAX_FILES ?? '10'),
        max_file_size: parseInt(process.env.GEMINI_MAX_TOTAL_FILE_SIZE ?? '100'),
      },
      cache: {
        enabled: process.env.ENABLE_CACHING !== 'false',
        ttl: parseInt(process.env.CACHE_TTL ?? '3600'),
      },
      logging: {
        level: this.validateLogLevel(process.env.LOG_LEVEL) ?? 'info',
        file: process.env.LOG_FILE,
      },
    };
  }

  /**
   * Validate log level to ensure it matches Zod schema
   */
  private validateLogLevel(level?: string): 'error' | 'warn' | 'info' | 'debug' {
    const validLevels = ['error', 'warn', 'info', 'debug'] as const;
    
    if (!level) {return 'info';}
    
    // Handle non-standard level names
    const lowerLevel = level.toLowerCase();
    if (lowerLevel === 'verbose') {return 'debug';}
    
    return validLevels.includes(lowerLevel as any) ? lowerLevel as any : 'info';
  }
}