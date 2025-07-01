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
        version: '1.0.9',
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
            name: 'cgmb',
            description: '🎯 **USE WHEN PROMPT CONTAINS "CGMB" KEYWORD** - Claude-Gemini Multimodal Bridge unified processor. When users mention "CGMB" in their prompt, use this tool for: • Intelligent Web Search (current events, trends) • Advanced Image/Document Analysis • Multimodal Content Processing • Multi-layer AI orchestration. Handles all CGMB requests automatically with optimal routing. Examples: "CGMB analyze this image", "CGMB search latest AI news", "CGMB process this document"',
            inputSchema: {
              type: 'object',
              properties: {
                prompt: {
                  type: 'string',
                  description: 'User prompt (must contain CGMB keyword for optimal processing)',
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
            description: '🎨 **For structured CGMB multimodal requests** - AI-powered multimodal content processor with intelligent web search, image analysis, and document processing. Use when prompt contains "CGMB" + specific multimodal requirements. Claude-Gemini Multimodal Bridge features: • Intelligent Web Search: Current events, trends • Advanced Image Analysis: Process images, diagrams, screenshots • Smart Document Processing: PDFs, text files, code files. Examples: "CGMB analyze the latest AI security trends", "CGMB summarize this PDF document"',
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
            description: '📄 **For document-focused CGMB requests** - Advanced document analysis for PDFs, text files, code files, and more. Use when prompt contains "CGMB" + document analysis requests. Claude-Gemini Multimodal Bridge automatically summarizes, compares, extracts key information, or translates content with intelligent processing. Examples: "CGMB analyze this contract", "CGMB compare these documents"',
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
            description: '🔄 **For complex CGMB workflow requests** - Orchestrate multi-step AI workflows combining intelligent web search, document analysis, image processing, and content generation. Use when prompt contains "CGMB" + complex workflow requests. Claude-Gemini Multimodal Bridge is perfect for comprehensive research, analysis, and content creation tasks. Examples: "CGMB create a comprehensive report", "CGMB analyze and compare multiple sources"',
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
   * Handle unified CGMB requests - the main entry point for CGMB keyword triggers
   */
  private async handleCGMBUnified(args: unknown): Promise<CallToolResult> {
    return safeExecute(
      async () => {
        // Import PromptAnalyzer
        const { PromptAnalyzer } = await import('../utils/PromptAnalyzer.js');
        
        // Validate basic structure
        if (!args || typeof args !== 'object' || !('prompt' in args)) {
          throw new Error('Invalid arguments: prompt is required');
        }
        
        const { prompt, files = [], options = {} } = args as any;
        
        if (typeof prompt !== 'string' || !prompt.trim()) {
          throw new Error('Invalid prompt: must be a non-empty string');
        }

        // Analyze the prompt and determine optimal processing
        const hasCGMBKeyword = PromptAnalyzer.detectCGMBKeyword(prompt);
        const workflow = PromptAnalyzer.determineOptimalWorkflow(prompt, files);
        const suggestions = PromptAnalyzer.generateProcessingSuggestions(prompt);
        
        logger.info('CGMB unified handler processing request', {
          hasCGMBKeyword,
          workflow: workflow.workflow,
          priority: workflow.priority,
          useSearch: workflow.useSearch,
          recommendedTool: suggestions.recommendedTool,
          confidence: suggestions.confidence
        });

        // Process the request using LayerManager
        const result = await this.layerManager.processMultimodal(
          prompt,
          files || [],
          workflow.workflow,
          {
            quality_level: workflow.priority,
            layer_priority: 'adaptive',
            execution_mode: 'adaptive',
            ...options
          }
        );

        // Enhanced response with CGMB keyword acknowledgment
        const responsePrefix = hasCGMBKeyword 
          ? '🎯 **CGMB Activated** - Claude-Gemini Multimodal Bridge processing:\n\n'
          : '🤖 Multimodal processing completed:\n\n';

        // Lightweight response for fast processing
        const isLight = result.metadata?.optimization === 'fast-path-bypass';
        
        if (isLight) {
          const mainResult = Array.isArray(result.results) ? result.results[0] : Object.values(result.results || {})[0];
          return {
            content: [
              {
                type: 'text',
                text: responsePrefix + (mainResult?.data || 'Processing completed successfully')
              }
            ]
          };
        }

        // Full response for complex workflows
        const responseText = responsePrefix + 
          (result.summary || 'Processing completed') +
          (suggestions.suggestions.length > 0 ? 
            '\n\n💡 **Processing Notes:**\n' + suggestions.suggestions.map(s => `• ${s}`).join('\n') : '');

        return {
          content: [
            {
              type: 'text',
              text: responseText
            }
          ]
        };
      },
      {
        operationName: 'cgmb_unified_process',
        timeout: this.config.claude.timeout,
      }
    );
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
        check: () => this.layerManager.getClaudeLayer().isAvailable(),
      },
      {
        name: 'Gemini CLI',
        check: () => this.layerManager.getGeminiLayer().isAvailable(),
      },
      {
        name: 'AI Studio MCP',
        check: () => this.layerManager.getAIStudioLayer().isAvailable(),
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