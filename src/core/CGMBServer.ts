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
import { createRequire } from 'module';

import { LayerManager, type RouteDecision } from './LayerManager.js';
import { extractUrls } from './routing.js';
import { logger } from '../utils/logger.js';
import { safeExecute } from '../utils/errorHandler.js';
import path from 'path';
import fsSync from 'fs';
import {
  CGMBError,
  // Commented out unused imports for safety - may be needed for future schema validation
  // DocumentAnalysisArgs,
  DocumentAnalysisArgsSchema,
  EnhancedCGMBRequest,
  EnhancedCGMBRequestSchema,
  // MultimodalProcessArgs,
  MultimodalProcessArgsSchema,
  // WorkflowDefinitionArgs,
  WorkflowDefinitionArgsSchema,
  WorkflowResult,
} from './types.js';
import { normalizeLayerName } from './types.js';
import { Config, ConfigSchema } from './types.js';
import { isOneOf } from './types.js';
import { LegacyCGMBRequestSchema, ProcessingOptionsSchema } from './types.js';
import { extractResultText, pickFinalResultText } from '../utils/workflowUtils.js';
import { LayerType } from './types.js';
import { AI_MODELS, DEFAULT_ANTIGRAVITY_MODEL } from './types.js';
import { describeToolArgs, firstLineForLog, hostsOf, preformattedPrompt, redactUrls } from './types.js';
import type { GeminiFormat } from './types.js';
import { PDF_MODES } from '../utils/pdfText.js';
import { AISTUDIO_MAX_FILE_BYTES } from '../layers/AIStudioLayer.js';

// Read version from package.json
const require = createRequire(import.meta.url);
const packageJson = require('../../package.json') as { version: string };
const VERSION = packageJson.version;

/** options.pdf_mode, as the three tools that take files describe it. */
const PDF_MODE_OPTION = {
  type: 'string',
  enum: [...PDF_MODES],
  description: 'How local PDFs reach the model. "auto" (default, or CGMB_PDF_MODE): send the text ' +
    'extracted locally when the PDF has a text layer, upload the file for Gemini to OCR when it does not. ' +
    '"local": always send the extracted text. "upload": always upload the file.',
};

// ===================================
// claude-gemini-multimodal-bridge Server
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
        version: VERSION,
        description: `claude-gemini-multimodal-bridge v${VERSION} - Enterprise-grade multi-layer AI integration with OAuth authentication, automatic translation, intelligent routing, and advanced multimodal processing for Claude Code.`
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
            description: '📋 **Layer Info Tool** - Get AI layer capabilities:\n' +
              '• Returns detailed JSON with each layer\'s:\n' +
              '  - Input formats and requirements\n' +
              '  - Capabilities and features\n' +
              '  - Limitations and quotas\n' +
              '• Layers: antigravity (text/search), claude (reasoning/code), aistudio (multimodal), adaptive',
            inputSchema: {
              type: 'object',
              properties: {},
              additionalProperties: false
            },
          },
          {
            name: 'cgmb',
            description: '🎯 **CGMB Universal AI Handler** - Processes all CGMB requests:\n' +
              '\n' +
              '📋 **Supported Commands** (auto-detected from prompt):\n' +
              '• chat/ask/tell → Interactive conversation\n' +
              '• search/look up/latest/news/today → Web search via Antigravity CLI\n' +
              '• explain/compare/why/design, write/fix/refactor code → Claude Code\n' +
              '• analyze/review/examine files → Document/file analysis via AI Studio (source code files → Claude Code)\n' +
              '• generate/create image → Image generation via AI Studio\n' +
              '• generate/create audio/speech → Audio generation via AI Studio\n' +
              '• process/handle files → Multimodal file processing\n' +
              '• compare/diff → Document comparison\n' +
              '• extract/get → Information extraction\n' +
              '• translate/convert → Translation/conversion\n' +
              '\n' +
              '🔧 **Features**:\n' +
              '• URL Detection: web pages are read by Antigravity CLI; PDF URLs are downloaded and read by AI Studio\n' +
              '• Path Resolution: ./relative → /absolute using workingDirectory\n' +
              '• File Validation: Checks existence and read permissions\n' +
              '• Smart Routing: Auto-selects optimal AI layer\n' +
              '• Error Context: Shows original + resolved paths\n' +
              '\n' +
              '📁 **File Support**:\n' +
              '• Documents: PDF (max 1000 pages), TXT, MD, HTML\n' +
              '• Images: PNG, JPG, GIF (analysis + generation)\n' +
              '• Audio: WAV, MP3 (analysis + generation)\n' +
              '• Code: JS, PY, TS, etc.\n' +
              '\n' +
              '💡 **Usage Examples**:\n' +
              '• "CGMB search for latest AI news"\n' +
              '• "CGMB analyze document.pdf"\n' +
              '• "CGMB analyze C:\\path\\to\\file.png"\n' +
              '• "CGMB analyze /path/to/file.pdf"\n' +
              '• "CGMB generate image of sunset"\n' +
              '• "CGMB create audio saying welcome"\n' +
              '\n' +
              '⚠️ **Usage Guidelines**:\n' +
              '• ✅ **Recommended Commands** (for normal use):\n' +
              '  - chat/search/analyze/generate-image/generate-audio\n' +
              '  - Example: "cgmb chat \'latest AI news\'"\n' +
              '• ⚠️ **Internal Commands** (usually not needed):\n' +
              '  - gemini/aistudio → Debug/test specific layers\n' +
              '  - Use recommended commands instead\n' +
              '\n' +
              '⚠️ **Important**: Always include "CGMB" keyword to trigger this tool',
            inputSchema: {
              type: 'object',
              properties: {
                prompt: {
                  type: 'string',
                  description: 'User prompt for AI processing (web search, analysis, multimodal tasks)',
                },
                workingDirectory: {
                  type: 'string',
                  description: 'Working directory context for relative path resolution (optional)',
                },
                targetLayer: {
                  type: 'string',
                  enum: ['antigravity', 'gemini', 'aistudio', 'claude', 'adaptive'],
                  description: 'Target layer for direct routing (optional). "gemini" is a deprecated alias for "antigravity". Omit or use "adaptive" to let CGMB choose.',
                },
                preformatted: {
                  type: 'boolean',
                  description: 'Whether the data is already formatted for the target layer',
                  default: false,
                },
                formattedData: {
                  type: 'object',
                  description: 'Pre-formatted data (used when preformatted=true and targetLayer is "antigravity"; ' +
                    'with any other targetLayer the request is routed to that layer as usual)',
                  properties: {
                    geminiFormat: {
                      type: 'object',
                      description: 'Sent to the Antigravity CLI as is',
                      properties: {
                        prompt: { type: 'string', description: 'Prompt text (defaults to the top-level prompt)' },
                        args: { type: 'array', items: { type: 'string' }, description: 'Extra CLI arguments' }
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
                    pdf_mode: PDF_MODE_OPTION,
                  },
                  default: {},
                },
              },
              required: ['prompt'],
            },
          },
          {
            name: 'cgmb_multimodal_process',
            description: '🎨 **Multimodal File Processor** - Specialized file handling:\n' +
              '• File Types: image, audio, pdf, document, text, video\n' +
              '• Workflows: analysis, conversion, extraction, generation\n' +
              '• Batch Mode: Process multiple files together\n' +
              '• Path Support: Relative (./file) and absolute (/path/file)\n' +
              '• Options: execution_mode, quality_level, pdf_mode\n' +
              'Auto-selected when multiple files specified or @file mentions',
            inputSchema: {
              type: 'object',
              properties: {
                prompt: {
                  type: 'string',
                  description: 'Processing instructions for the multimodal content',
                },
                workingDirectory: {
                  type: 'string',
                  description: 'Working directory context for relative path resolution (optional)',
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
                    pdf_mode: PDF_MODE_OPTION,
                  },
                },
              },
              required: ['prompt', 'files', 'workflow'],
            },
          },
          {
            name: 'cgmb_document_analysis',
            description: '📄 **Document Analysis Expert** - Deep document processing:\n' +
              '• Supported: PDF (max 50MB, 1000 pages), TXT, MD, DOCX\n' +
              '• PDFs: text read locally when the PDF has a text layer; scanned PDFs uploaded for OCR (options.pdf_mode)\n' +
              '• Analysis Types: summary, comparison, extraction, translation\n' +
              '• Batch PDFs: Automatic detection for multiple PDF processing\n' +
              '• Path Handling: Relative paths resolved with workingDirectory\n' +
              'Auto-selected for document-specific analysis requests',
            inputSchema: {
              type: 'object',
              properties: {
                documents: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'List of document paths to analyze',
                },
                workingDirectory: {
                  type: 'string',
                  description: 'Working directory context for relative path resolution (optional)',
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
                options: {
                  type: 'object',
                  description: 'Processing options',
                  properties: {
                    pdf_mode: PDF_MODE_OPTION,
                  },
                },
              },
              required: ['documents', 'analysis_type'],
            },
          },
          {
            name: 'cgmb_workflow_orchestration',
            description: '🔄 **Workflow Orchestrator** - Complex multi-step tasks:\n' +
              '• Modes: sequential, parallel, adaptive execution\n' +
              '• Multi-Layer: Combines all 3 AI layers as needed\n' +
              '• Dependencies: Define step relationships\n' +
              '• Use Cases: Research workflows, report generation, data pipelines\n' +
              'Auto-selected for complex multi-step requests',
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
        // Shape only: prompts and arguments can carry signed-URL tokens or
        // pasted secrets, and this line goes to stderr and LOG_FILE.
        logger.info(`Tool called: ${name}`, describeToolArgs(args));
        // The full text only at debug level (CGMB_DEBUG / LOG_LEVEL=debug),
        // and even there URLs keep only their host: query strings are where
        // signed-URL tokens live.
        logger.debug(`Tool call arguments: ${name}`, { args: redactUrls(JSON.stringify(args ?? {})) });

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
        const errorMessage = error instanceof Error ? error.message : String(error);
        // Error messages can quote child-process output or a full URL; the
        // caller gets the message, the log gets its first line with URLs cut
        // to hosts.
        logger.error(`Tool failed: ${name}`, { error: firstLineForLog(errorMessage) });
        if (error instanceof Error && error.stack) {
          logger.debug(`Tool failure stack: ${name}`, { stack: redactUrls(error.stack) });
        }
        
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
    // Model IDs are interpolated from the constants the layers actually send,
    // so this description cannot drift from them again. It used to advertise
    // Imagen 3 and Veo 2 -- neither is called, and video generation throws.
    const requirements = {
      // Keyed `gemini` for older clients; the target is `antigravity`
      // (`gemini` is its deprecated alias).
      gemini: {
        format: 'Text prompt, sent to the Antigravity CLI (targetLayer "antigravity"; "gemini" is a deprecated alias)',
        requirements: [
          'Text-based prompts for search and analysis',
          'Web search queries for current information',
          'No file upload capability - text only'
        ],
        capabilities: [
          'Real-time web search with grounding',
          'Current information retrieval',
          'Reading web pages given by URL',
          `Model: ${DEFAULT_ANTIGRAVITY_MODEL} by default (ANTIGRAVITY_MODEL overrides; see \`agy models\`)`
        ],
        example: {
          prompt: 'What changed in the latest Node.js release?',
          targetLayer: 'antigravity'
        },
        limitations: [
          'No direct file processing',
          'Text-only input/output',
          'Search results depend on web availability'
        ]
      },
      aistudio: {
        format: 'Prompt plus local file paths (files[]) or PDF URLs; CGMB reads and uploads the files itself',
        requirements: [
          'Multimodal files (images, PDFs, audio, documents)',
          'Generation tasks (images, speech)',
          'Document analysis'
        ],
        capabilities: [
          `Image generation (${AI_MODELS.IMAGE_GENERATION})`,
          `Speech generation, text to WAV (${AI_MODELS.AUDIO_GENERATION})`,
          `Image and multimodal analysis (${AI_MODELS.MULTIMODAL_ANALYSIS})`,
          `PDF and document analysis, including PDF URLs and scanned PDFs (${AI_MODELS.DOCUMENT_PROCESSING})`
        ],
        example: {
          prompt: 'Analyze this document and extract key points',
          files: [{ path: 'report.pdf', type: 'pdf' }],
          targetLayer: 'aistudio'
        },
        limitations: [
          'Video generation is not implemented',
          `Files up to ${AISTUDIO_MAX_FILE_BYTES / 1024 / 1024} MB each`,
          'Requires AI_STUDIO_API_KEY; subject to the API quota of that key',
          'Processing time grows with file size'
        ]
      },
      claude: {
        format: 'Text prompts; the layer builds its own prompt from the request',
        requirements: [
          'Text-based prompts for reasoning, code and synthesis',
          'Source code files only, inlined into the prompt (up to 10 files, 200 KB in total)',
          'Claude Code must be installed and signed in; without it these requests go to the Antigravity CLI',
        ],
        capabilities: [
          'Complex reasoning: explain, compare, why, design, review',
          'Code: write, fix, refactor, review source files',
          'Synthesis across earlier workflow steps',
          'Workflow orchestration',
        ],
        example: {
          prompt: 'Explain the trade-offs between these two designs',
          targetLayer: 'claude',
        },
        limitations: [
          'Reads source code only; use the aistudio layer for documents and media',
          'Each call starts a fresh headless session',
        ],
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
        // The arguments themselves were logged by the tool dispatcher, as a
        // shape (keys, lengths, hosts); never their text.
        logger.debug('CGMB unified handler starting');

        // Parse enhanced request
        const request = this.parseEnhancedRequest(args);
        
        // Preformatted data is a shortcut for one case only: a geminiFormat
        // payload for the Antigravity CLI. Every other combination -- another
        // targetLayer, adaptive, or the never-implemented aistudioFormat --
        // goes down the normal path below, which validates the input and then
        // honours targetLayer. (Before, those combinations skipped validation
        // and path resolution entirely.)
        if (request.formattedData?.aistudioFormat) {
          logger.warn('formattedData.aistudioFormat is deprecated and ignored; routing this request normally', {
            hint: 'Send the request without formattedData to use the AI Studio layer.',
          });
        }
        const geminiFormat = request.formattedData?.geminiFormat;
        if (request.preformatted && geminiFormat
            && normalizeLayerName(request.targetLayer ?? 'adaptive') === 'antigravity') {
          logger.info('Using preformatted data for the Antigravity layer', {
            argCount: geminiFormat.args?.length ?? 0,
          });
          const result = await this.processPreformattedRequest(request.prompt, geminiFormat);
          return this.formatResponse(result, true);
        }

        // An explicit target is an instruction, not a hint.
        //
        // targetLayer was only consulted on the preformatted path above, so an
        // ordinary request naming a layer went through the analyser instead and
        // could be answered by a different one entirely -- measured: a request
        // for Claude was served by the search layer. 'adaptive' (and omitting
        // the field) still means "you choose".
        // 1. Input validation and normalization
        //
        // Runs before the routing decision, not after. Naming a layer chooses
        // WHERE the work goes; it is not a reason to skip checking the input.
        // Returning early with the raw args left relative paths unresolved, so
        // AI Studio looked for them against the server's own cwd, found
        // nothing, and could report success on files it never opened.
        const normalizedRequest = this.validateAndNormalize(args);

        const requested = normalizeLayerName(request.targetLayer ?? 'adaptive');
        if (requested !== 'adaptive') {
          logger.info('Routing directly to the requested layer', {
            layer: requested,
            filesCount: normalizedRequest.files.length,
          });

          // A layer that cannot read the attached files is an error, not a
          // silent drop. Claude Code is reached through `claude --print` with
          // the prompt on stdin, so it reads source code only, inlined into the
          // prompt; the search layer reads nothing. Answering from the prompt
          // alone returned success on a document nobody opened, which is worse
          // than an error: the caller has an answer and no reason to doubt it.
          // LayerManager.assertLayerCanReadFiles is the same check the CLI's
          // --layer runs.
          const localFiles = normalizedRequest.files.filter(file => file.type !== 'url');
          this.layerManager.assertLayerCanReadFiles(requested as LayerType, localFiles);

          if (requested === 'claude' && localFiles.length > 0) {
            return this.toCallToolResult(await this.layerManager.executeCodeFilesOnClaudeDirect({
              type: 'text_processing',
              prompt: normalizedRequest.prompt,
              files: localFiles,
              options: normalizedRequest.options ?? {},
            }));
          }

          const direct = await this.layerManager.executeWithLayer(requested as LayerType, {
            type: 'text_processing',
            prompt: normalizedRequest.prompt,
            files: normalizedRequest.files,
            options: normalizedRequest.options ?? {},
          });

          return this.toCallToolResult(direct);
        }

        // Fallback to original processing for backward compatibility
        logger.info('Using standard processing (not preformatted)');

        logger.info('Request normalized', {
          hasCGMB: normalizedRequest.hasCGMB,
          promptLength: normalizedRequest.prompt.length,
          filesCount: normalizedRequest.files.length,
          hasUrls: normalizedRequest.hasUrls,
          urlCount: normalizedRequest.urlsDetected.length
        });
        
        // 2. One routing decision, made by LayerManager -- the same rule the
        // CLI and cgmb_multimodal_process use. URLs, generation, search,
        // reasoning and source code are acted on here; other files, long and
        // multi-step requests go on to processMultimodal below.
        const localFiles = normalizedRequest.files.filter(file => file.type !== 'url');
        const decision = this.layerManager.decideRoute({
          prompt: normalizedRequest.prompt,
          files: localFiles,
          urls: normalizedRequest.urlsDetected,
        });
        logger.info('Routing decision', { route: decision.kind, layer: decision.layer, reason: decision.reason });

        if (decision.kind === 'file_url' || decision.kind === 'web_url' || decision.kind === 'web_and_files') {
          return this.handleUrlRoute(decision, normalizedRequest.prompt, localFiles, normalizedRequest.options, normalizedRequest.hasCGMB);
        }

        if (['image_generation', 'audio_generation', 'search', 'reasoning', 'code_files'].includes(decision.kind)) {
          const result = await this.layerManager.executeRoute(decision, {
            prompt: normalizedRequest.prompt,
            files: localFiles,
            options: normalizedRequest.options ?? {},
          });
          return this.formatResponse({
            success: result.success,
            ...(result.error ? { error: result.error } : {}),
            data: this.describeLayerData(result.data),
            metadata: {
              ...result.metadata,
              routing_reason: decision.kind,
            },
          }, normalizedRequest.hasCGMB);
        }

        // 3. Convert to format that each layer can understand (for non-URL, non-search, non-generation requests)
        const convertedRequest = this.convertForLayers(
          normalizedRequest.prompt,
          normalizedRequest.files,
          normalizedRequest.options
        );
        logger.info('Request converted for layers', {
          workflow: convertedRequest.workflow,
          optionsKeys: Object.keys(convertedRequest.options)
        });
        
        // 4. Delegate to LayerManager for intelligent routing (non-URL requests)
        logger.info('Calling LayerManager.processMultimodal...');
        const result = await this.layerManager.processMultimodal(
          convertedRequest.prompt,
          convertedRequest.files,
          convertedRequest.workflow,
          {
            ...convertedRequest.options,
            workingDirectory: normalizedRequest.workingDirectory  // Propagate for file path resolution
          }
        );
        logger.info('LayerManager.processMultimodal completed', {
          success: result.success,
          hasResults: !!result.results,
          hasSummary: !!result.summary
        });

        // 5. Format unified response
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
    const enhanced = EnhancedCGMBRequestSchema.safeParse(args);
    if (enhanced.success) {
      return enhanced.data;
    }

    // A request that names a layer or carries preformatted data is not a
    // legacy request. Falling back for it dropped targetLayer without a word
    // and answered from whichever layer the router picked, so say what is
    // wrong instead.
    const source = (args && typeof args === 'object') ? args as Record<string, unknown> : {};
    const routingKeys = ['targetLayer', 'preformatted', 'formattedData'].filter(key => source[key] !== undefined);
    if (routingKeys.length > 0) {
      throw new CGMBError(
        `Invalid CGMB request (${routingKeys.join(', ')} given): ${enhanced.error.message}`,
        'INVALID_REQUEST'
      );
    }

    // Fall back to the older request shape -- but still validate it.
    //
    // This used to cast to `any` and read the fields off directly, so anything
    // that failed the schema above was passed on completely unchecked: `files`
    // could be a bare string or objects without a path, and the problem only
    // surfaced deep in a layer as an unrelated error. The legacy schema keeps
    // the compatibility while rejecting shapes nothing downstream can use.
    logger.debug('Failed to parse as enhanced request, trying the legacy shape');

    const legacy = LegacyCGMBRequestSchema.safeParse(args);
    if (!legacy.success) {
      throw new CGMBError(
        `Invalid CGMB request: ${legacy.error.message}`,
        'INVALID_REQUEST'
      );
    }

    return {
      prompt: legacy.data.prompt ?? '',
      targetLayer: undefined,
      preformatted: false,
      formattedData: undefined,
      files: legacy.data.files ?? [],
      options: legacy.data.options ?? {}
    };
  }

  /**
   * Run a preformatted geminiFormat payload on the Antigravity layer.
   *
   * Only reached with targetLayer antigravity (or its deprecated spelling
   * gemini); handleCGMBUnified sends every other preformatted request down the
   * normal, validated path.
   */
  private async processPreformattedRequest(prompt: string, format: GeminiFormat): Promise<WorkflowResult> {
    const antigravity = await this.layerManager.getAntigravityLayerAsync();
    const result = await antigravity.execute({
      type: 'text_processing',
      prompt: preformattedPrompt(format, prompt),
      files: [],
      useSearch: true,
      args: format.args ?? [],
    });

    return {
      success: result.success,
      results: [result],
      metadata: {
        workflow: 'analysis',
        execution_mode: 'direct',
        total_duration: result.metadata?.duration || 0,
        steps_completed: result.success ? 1 : 0,
        steps_failed: result.success ? 0 : 1,
        layers_used: ['antigravity'],
        optimization: 'preformatted-direct'
      }
    };
  }

  /**
   * Validate and normalize input from Claude Code with URL detection and file path resolution
   */
  private validateAndNormalize(args: unknown): {
    prompt: string;
    files: any[];
    options: any;
    hasCGMB: boolean;
    hasUrls: boolean;
    urlsDetected: string[];
    workingDirectory: string;
  } {
    // Basic validation
    if (!args || typeof args !== 'object' || !('prompt' in args)) {
      throw new Error('Invalid arguments: prompt is required');
    }
    
    // Read off `unknown` rather than casting the whole object to `any`. The
    // runtime checks below were already doing the real work; the cast only
    // stopped the compiler from noticing that `prompt` might not be a string.
    const source = args as Record<string, unknown>;
    const prompt = source.prompt;
    const files = source.files ?? [];
    // Parsed, not cast. The cast let any key through: this object is handed
    // straight to a layer, and AI Studio reads options.multiplePDFs -- which is
    // not in the schema -- to switch itself to processMultiplePDFs(). That flag
    // is one internal callers set deliberately, not something MCP input should
    // be able to reach.
    //
    // This cannot reject anything new. The only caller runs after
    // parseEnhancedRequest, and both the enhanced and the legacy schema already
    // validate `options` with this same ProcessingOptionsSchema -- an
    // out-of-range known value has therefore thrown before reaching here. All
    // this adds is the stripping of unrecognised keys, which the earlier parse
    // performs on its own copy but which survives in the raw args.
    const options = ProcessingOptionsSchema.parse(source.options ?? {});
    const workingDirectory = typeof source.workingDirectory === 'string'
      ? source.workingDirectory
      : undefined;

    if (typeof prompt !== 'string' || !prompt.trim()) {
      throw new Error('Invalid prompt: must be a non-empty string');
    }

    // Simple CGMB keyword detection
    const hasCGMB = prompt.toLowerCase().includes('cgmb');

    // URL Detection - check for URLs in the prompt and file paths
    // extractUrls stops at characters a URL cannot hold, so a URL followed
    // directly by Japanese text ("...document.pdfを分析してください") is read
    // as the URL alone; matching up to the next space took the sentence too,
    // and the PDF was then classified as a web page.
    const urlsInPrompt = extractUrls(prompt);
    
    // Also check file paths for URLs
    const fileArray = Array.isArray(files) ? files : [];
    const urlsInFiles: string[] = [];
    const resolvedFiles: any[] = [];
    
    for (const file of fileArray) {
      const filePath = typeof file === 'string' ? file : (file?.path || '');
      
      // Check if file path is actually a URL
      if (/^https?:\/\//.test(filePath)) {
        urlsInFiles.push(filePath);
        // Keep URL files as-is for URL routing
        resolvedFiles.push(typeof file === 'string' ? { path: filePath, type: 'url' } : { ...file, type: 'url' });
      } else if (filePath) {
        // File path resolution for local files
        try {
          // Fix: Handle Windows paths with mixed slashes and ensure proper absolute path detection
          // First, normalize forward slashes to backslashes on Windows
          const isWindows = process.platform === 'win32';
          let preprocessedPath = filePath;

          // Check for Windows absolute path pattern (C:/ or C:\)
          const isWindowsAbsolutePath = /^[A-Za-z]:[/\\]/.test(filePath);

          if (isWindows && isWindowsAbsolutePath) {
            // Normalize all slashes to backslashes for Windows
            preprocessedPath = filePath.replace(/\//g, '\\');
          }

          const normalizedPath = path.normalize(preprocessedPath);
          // Use provided working directory or fall back to process.cwd()
          const baseDir = workingDirectory || process.cwd();

          // Determine if path is absolute (also check Windows absolute path pattern)
          const isAbsolute = path.isAbsolute(normalizedPath) || isWindowsAbsolutePath;
          const resolvedPath = isAbsolute
            ? normalizedPath
            : path.resolve(baseDir, normalizedPath);
          
          // Log path resolution for debugging
          if (workingDirectory && !path.isAbsolute(normalizedPath)) {
            logger.info(`Relative path resolution using provided working directory`, {
              originalPath: filePath,
              normalizedPath,
              workingDirectory,
              resolvedPath
            });
          }
          
          // Check file existence and permissions
          if (fsSync.existsSync(resolvedPath)) {
            const stats = fsSync.statSync(resolvedPath);
            if (stats.isFile()) {
              try {
                fsSync.accessSync(resolvedPath, fsSync.constants.R_OK);
                // File is accessible, add resolved path
                resolvedFiles.push(typeof file === 'string' 
                  ? { path: resolvedPath, type: 'document' }
                  : { ...file, path: resolvedPath, type: file.type || 'document' });
              } catch (permError) {
                logger.warn(`File permission denied: ${filePath} -> ${resolvedPath}`);
                throw new Error(`Permission denied: ${filePath}
Resolved to: ${resolvedPath}
File exists but cannot be read.

Fix: chmod +r "${resolvedPath}"`);
              }
            } else {
              logger.warn(`Path is not a file: ${filePath} -> ${resolvedPath}`);
              throw new Error(`Not a file: ${filePath}
Resolved to: ${resolvedPath}
This path points to a directory or special file.

Use a specific file path instead.`);
            }
          } else {
            logger.warn(`File not found: ${filePath} -> ${resolvedPath}`);
            throw new Error(`File not found: ${filePath}
Resolved path: ${resolvedPath}
Working directory: ${workingDirectory || 'not provided'}
Current directory: ${process.cwd()}

Solutions:
1. Check file exists: ls -la "${resolvedPath}"
2. Use relative path: "./filename.pdf" (from current dir)
3. Use absolute path: "/full/path/to/file.pdf"
4. Verify working directory matches file location`);
          }
        } catch (error) {
          if (error instanceof Error && error.message.includes('not found')) {
            throw error; // Re-throw file not found errors with context
          }
          // logger.warn takes a metadata bag, not an Error. Passing the Error
          // straight in logged an object with no enumerable keys -- the message
          // and stack were dropped.
          logger.warn(`File path resolution error: ${filePath}`, {
            error: (error as Error).message,
          });
          throw new Error(`Invalid file path: ${filePath}`);
        }
      }
    }

    // NEW: Local File Path Detection (Windows + Unix)
    // Extract file paths embedded in the prompt text (like URL detection above)
    // Fix: Support both uppercase and lowercase drive letters (M:\ and m:\)
    const filePathRegex = /(?:[A-Za-z]:\\[^\s"'<>|]+\.[a-zA-Z0-9]+|\/(?!https?:)[^\s"'<>|]+\.[a-zA-Z0-9]+|\.\.?\/[^\s"'<>|]+\.[a-zA-Z0-9]+)/gi;
    const localPathsInPrompt = prompt.match(filePathRegex) ?? [];

    if (localPathsInPrompt.length > 0) {
      logger.info('Local file paths detected in prompt', { paths: localPathsInPrompt });

      for (const detectedPath of localPathsInPrompt) {
        // Check for duplicates
        const isDuplicate = resolvedFiles.some(f =>
          (typeof f === 'string' ? f : f.path) === detectedPath
        );

        if (!isDuplicate) {
          try {
            // Fix: Handle Windows paths with mixed slashes consistently
            const isWindows = process.platform === 'win32';
            let preprocessedPath = detectedPath;

            // Check for Windows absolute path pattern (C:/ or C:\)
            const isWindowsAbsolutePath = /^[A-Za-z]:[/\\]/.test(detectedPath);

            if (isWindows && isWindowsAbsolutePath) {
              // Normalize all slashes to backslashes for Windows
              preprocessedPath = detectedPath.replace(/\//g, '\\');
            }

            const normalizedPath = path.normalize(preprocessedPath);
            const baseDir = workingDirectory || process.cwd();

            // Determine if path is absolute (also check Windows absolute path pattern)
            const isAbsolute = path.isAbsolute(normalizedPath) || isWindowsAbsolutePath;
            const resolvedPath = isAbsolute
              ? normalizedPath
              : path.resolve(baseDir, normalizedPath);

            // Check file existence
            if (fsSync.existsSync(resolvedPath)) {
              const stats = fsSync.statSync(resolvedPath);
              if (stats.isFile()) {
                const detectedType = this.layerManager.detectFileType(resolvedPath);
                resolvedFiles.push({ path: resolvedPath, type: detectedType });
                logger.info('File path extracted from prompt', {
                  original: detectedPath,
                  resolved: resolvedPath,
                  type: detectedType
                });
              }
            } else {
              logger.warn('File path in prompt does not exist', {
                original: detectedPath,
                resolved: resolvedPath
              });
            }
          } catch (error) {
            logger.warn('Failed to process file path from prompt', {
              path: detectedPath,
              error: (error as Error).message
            });
          }
        }
      }
    }

    const urlsDetected = [...urlsInPrompt, ...urlsInFiles];
    const hasUrls = urlsDetected.length > 0;
    
    if (hasUrls) {
      logger.info(`URLs detected in request`, {
        urlCount: urlsDetected.length,
        hosts: hostsOf(urlsDetected),
        inPrompt: urlsInPrompt.length,
        inFiles: urlsInFiles.length
      });
    }

    return {
      prompt: prompt.trim(),
      files: resolvedFiles,
      options: typeof options === 'object' ? options : {},
      hasCGMB,
      hasUrls,
      urlsDetected,
      workingDirectory: workingDirectory || process.cwd()  // Preserve for layer execution
    };
  }

  /**
   * Convert input to formats that Claude Code, the Antigravity CLI, and AI Studio can understand
   */
  private convertForLayers(prompt: string, files: any[], options: any): {
    prompt: string;
    files: any[];
    workflow: 'analysis' | 'conversion' | 'extraction' | 'generation';
    options: any;
  } {
    // Format for each layer:
    // - Claude Code: text prompt + file references
    // - Antigravity CLI: prompt on stdin
    // - AI Studio: API format, base64 encoded files

    // Determine workflow (simple logic)
    //
    // "generat"/"creat" no longer select the generation workflow. Image and
    // audio requests are recognised by LayerManager.decideRoute and sent to AI
    // Studio before this point; what reaches here is not one, and the
    // generation workflow made an image for anything that said "create" --
    // twice, with Claude's text returned in place of either.
    let workflow: 'analysis' | 'conversion' | 'extraction' | 'generation' = 'analysis';
    const lowerPrompt = prompt.toLowerCase();
    if (lowerPrompt.includes('convert') || lowerPrompt.includes('transform')) {
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
   * Improved data extraction to handle various result structures
   */
  /**
   * Convert a layer or workflow result into an MCP CallToolResult.
   *
   * The dedicated tools (workflow orchestration, multimodal, document
   * analysis) each JSON-stringified their result without consulting
   * result.success, so a workflow whose steps failed -- which
   * LayerManager.executeWorkflow returns as a normal value, not a throw --
   * arrived at the client with no isError and was recorded as a success. The
   * round-15 fix only covered the unified tool's formatResponse path.
   */
  private toCallToolResult(result: { success?: boolean | undefined; error?: string | undefined }): CallToolResult {
    const failed = result?.success === false;

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
      ...(failed ? { isError: true } : {}),
    };
  }

  private formatResponse(result: any, hasCGMB: boolean): CallToolResult {
    const prefix = hasCGMB ? '🎯 **CGMB**: ' : '';

    // Extract response data from various result structures
    let responseData: string | null = null;

    // 1. Direct data field (from simple routing)
    if (typeof result.data === 'string' && result.data.trim()) {
      responseData = result.data;
    }
    // 2 & 3. Workflow results, either as an array or as named steps.
    //
    // This used to hold two byte-for-byte copies of the same four-shape probe,
    // one per container, and both took element [0] without looking at whether
    // that step succeeded or what it was for. In a named workflow element [0]
    // is the preprocess step, so an intermediate result -- or a failed one --
    // was returned as the final answer. pickFinalResultText walks from the end
    // and skips failures.
    else if (Array.isArray(result.results) && result.results.length > 0) {
      responseData = pickFinalResultText(result.results);
    }
    else if (result.results && typeof result.results === 'object') {
      responseData = pickFinalResultText(Object.values(result.results));
    }
    // 4. Summary or content fallback
    else if (result.summary && typeof result.summary === 'string') {
      responseData = result.summary;
    }
    else if (result.content) {
      // Handle MCP content array format: [{type: 'text', text: '...'}]
      if (Array.isArray(result.content) && result.content[0]?.text) {
        responseData = result.content[0].text;
      } else if (typeof result.content === 'string') {
        responseData = result.content;
      } else {
        responseData = JSON.stringify(result.content);
      }
    }

    // 5. Final fallback with debug info
    if (!responseData) {
      logger.warn('formatResponse: No meaningful data extracted from result', {
        hasData: !!result.data,
        hasResults: !!result.results,
        hasSummary: !!result.summary,
        hasContent: !!result.content,
        resultKeys: Object.keys(result)
      });
      responseData = 'Processing completed';
    }

    // Say when the answer came from a fallback layer. A search answered by a
    // layer without web access, or a reasoning question answered by the search
    // layer, is still an answer -- but not the one the routing promised.
    const fallbackFrom = result?.metadata?.fallback_from;
    if (typeof fallbackFrom === 'string' && result?.success !== false) {
      const answeredBy = typeof result?.metadata?.layer === 'string' ? result.metadata.layer : 'another';
      const reason = typeof result?.metadata?.fallback_reason === 'string' ? result.metadata.fallback_reason : 'it failed';
      responseData = `⚠️ The ${fallbackFrom} layer could not answer (${reason}); ` +
        `this answer comes from the ${answeredBy} layer instead.\n\n${responseData}`;
    }

    let responseText = prefix + responseData;

    // Add usage hints only when CGMB keyword is missing AND response is minimal
    if (!hasCGMB && responseData.length < 100) {
      responseText += '\n\n💡 CGMB Commands:\n' +
        '• Chat: "CGMB tell me about..."\n' +
        '• Search: "CGMB search for latest..."\n' +
        '• Analyze: "CGMB analyze file.pdf"\n' +
        '• Generate: "CGMB create image/audio..."\n' +
        '• Process: "CGMB process files..."';
    }

    // A failed result must reach the wire as a failure.
    //
    // formatResponse ignored result.success entirely and, when it could not
    // extract data, substituted "Processing completed" -- so a workflow whose
    // steps failed produced a CallToolResult with no isError, which upstream
    // handlers record as success. Partial failures were worse: the first
    // successful step's data was returned and the later failures disappeared.
    const failed = result?.success === false;

    return {
      content: [{
        type: 'text',
        text: failed
          ? `${responseText}

❌ This request did not complete successfully.` +
            (typeof result?.error === 'string' ? `
Error: ${result.error}` : '') +
            (typeof result?.metadata?.steps_failed === 'number'
              ? `
Failed steps: ${result.metadata.steps_failed}`
              : '')
          : responseText
      }],
      ...(failed ? { isError: true } : {})
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
                text: extractResultText(mainResult) ?? 'Processing completed'
              }
            ]
          };
        }

        // Full response for complex workflows
        return this.toCallToolResult(result);
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

        return this.toCallToolResult(result);
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

        return this.toCallToolResult(result);
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
            const layer = await this.layerManager.getClaudeLayerAsync();
            return await layer.isAvailable();
          } catch {
            return false;
          }
        },
      },
      {
        name: 'Antigravity CLI',
        check: async () => {
          try {
            const layer = await this.layerManager.getAntigravityLayerAsync();
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
            const layer = await this.layerManager.getAIStudioLayerAsync();
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
      logger.warn('Some dependencies are not available:', { failures });
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
        api_key: process.env.AI_STUDIO_API_KEY ?? '',
        model: process.env.GEMINI_MODEL ?? AI_MODELS.GEMINI_FLASH,
        timeout: parseInt(process.env.GEMINI_TIMEOUT ?? '60000'),
        max_tokens: parseInt(process.env.GEMINI_MAX_OUTPUT_TOKENS ?? '16384'),
        temperature: parseFloat(process.env.GEMINI_TEMPERATURE ?? '0.2'),
      },
      claude: {
        code_path: process.env.CLAUDE_CODE_PATH ?? 'claude',
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

    return isOneOf(validLevels, lowerLevel) ? lowerLevel : 'info';
  }

  /**
   * Requests that name URLs.
   *
   * PDF (and image / audio) URLs go to AI Studio, whose server downloads a PDF
   * and reads it like a local one; web pages go to the Antigravity CLI. A
   * request with both a web page and files -- local files or file URLs -- has
   * each half read by the layer that can, and the answers are returned
   * together. The files used to be dropped here without a word: URL routing
   * ran first and handed the search layer `files: []`.
   *
   * There is no fallback on this path. No other layer can open a web page, and
   * no other layer can read the file; an answer from one would be about
   * content it never saw. A failure names the layer and what it could not read.
   */
  private async handleUrlRoute(
    decision: RouteDecision,
    prompt: string,
    localFiles: Array<{ path: string; type: string }>,
    options: Record<string, unknown> | undefined,
    hasCGMB: boolean
  ): Promise<CallToolResult> {
    const { fileUrls, webUrls } = decision;
    const sections: string[] = [];
    const failures: string[] = [];
    const failedLayers: string[] = [];
    const layersUsed: string[] = [];
    let duration = 0;

    if (webUrls.length > 0) {
      // Length only: prompts and URLs can carry personal or confidential
      // content, and logger metadata goes to the console and LOG_FILE
      // unredacted.
      const analysisPrompt = webUrls.length === 1
        ? (/\banaly[sz]e\b/i.test(prompt) ? prompt : `${prompt}\n\nRead the content at ${webUrls[0]}.`)
        : `Analyze the content at these URLs: ${webUrls.join(', ')}. ${prompt}`;
      logger.info('Executing URL analysis via Antigravity CLI', {
        promptLength: analysisPrompt.length,
        urlCount: webUrls.length,
      });
      try {
        const result = await this.layerManager.executeWithLayer('antigravity', {
          type: 'text_processing',
          prompt: analysisPrompt,
          files: [],
          useSearch: true,
        });
        if (result.success === false) {
          throw new Error(result.error ?? 'no result');
        }
        duration += result.metadata?.duration ?? 0;
        layersUsed.push('antigravity');
        sections.push(extractResultText(result) ?? '');
      } catch (error) {
        failures.push(`The antigravity layer could not read ${webUrls.join(', ')}: ${(error as Error).message}`);
        failedLayers.push('antigravity');
      }
    }

    // Only PDFs are fetched from URLs (the AI Studio server refuses the rest
    // too). Refused here first so the request fails at once rather than after
    // the layer's retries.
    const unfetchable = fileUrls.filter(url => this.layerManager.detectUrlType(url) !== 'pdf');
    if (unfetchable.length > 0) {
      failures.push(`The aistudio layer could not read ${unfetchable.join(', ')}: Only PDF URLs are fetched. ` +
        'Download the file and pass its local path instead.');
      failedLayers.push('aistudio');
    }

    const studioFiles = [
      ...fileUrls.map(url => ({ path: url, type: this.layerManager.detectUrlType(url) === 'pdf' ? 'pdf' : this.layerManager.detectUrlType(url) })),
      ...localFiles,
    ];
    if (studioFiles.length > 0 && failures.length === 0) {
      const instructions = webUrls.length > 0
        ? `${prompt}\n\n(${webUrls.join(', ')} ${webUrls.length === 1 ? 'is' : 'are'} read separately; ` +
          `answer from the attached file${studioFiles.length === 1 ? '' : 's'}.)`
        : prompt;
      // A request of PDF URLs alone takes the document path; anything with a
      // local file takes the path a local file takes on its own (the
      // single-file fast path's task shape), which reads both.
      const pdfUrlsOnly = localFiles.length === 0;
      try {
        const result = await this.layerManager.executeWithLayer('aistudio', {
          type: pdfUrlsOnly ? 'document_analysis' : 'multimodal_processing',
          ...(pdfUrlsOnly ? {} : { action: 'analyze' }),
          files: studioFiles,
          prompt: instructions,
          instructions,
          options: options ?? {},
          ...(typeof options?.pdf_mode === 'string' ? { pdf_mode: options.pdf_mode } : {}),
        });
        if (result.success === false) {
          throw new Error(result.error ?? 'no result');
        }
        duration += result.metadata?.duration ?? 0;
        layersUsed.push('aistudio');
        sections.push(extractResultText(result) ?? '');
      } catch (error) {
        const what = fileUrls.length > 0 && localFiles.length === 0 ? fileUrls.join(', ') : 'the attached files';
        failures.push(`The aistudio layer could not read ${what}: ${(error as Error).message}`);
        failedLayers.push('aistudio');
      }
    }

    if (failures.length > 0) {
      // The failure messages name the URLs in full, so they go to the caller
      // only; the log gets the hosts, the layers and any HTTP status.
      logger.error('URL request failed', {
        failureCount: failures.length,
        layers: failedLayers,
        hosts: hostsOf([...webUrls, ...fileUrls]),
        httpStatus: failures.flatMap(f => [...f.matchAll(/\bHTTP (\d{3})\b/g)].map(m => Number(m[1]))),
      });
      return this.formatResponse({
        success: false,
        error: failures.join('; '),
        data: failures.join('\n'),
        metadata: { layer: 'error', routing_reason: decision.kind, layers_used: layersUsed },
      }, hasCGMB);
    }

    const data = sections.length === 2
      ? `🌐 From ${webUrls.length === 1 ? 'the web page' : 'the web pages'} (Antigravity CLI):\n${sections[0]}\n\n` +
        `📎 From the attached ${studioFiles.length === 1 ? 'file' : 'files'} (AI Studio):\n${sections[1]}`
      : sections[0] ?? '';

    return this.formatResponse({
      success: true,
      data,
      metadata: {
        layer: layersUsed.length === 1 ? layersUsed[0] : 'multiple',
        layers_used: layersUsed,
        routing_reason: decision.kind === 'file_url' ? 'file_url_direct_routing'
          : decision.kind === 'web_url' ? 'web_url_auto_routing'
            : 'web_url_with_files',
        urls_processed: fileUrls.length + webUrls.length,
        processing_time: duration,
      },
    }, hasCGMB);
  }

  /**
   * The text of a layer result for the caller.
   *
   * Generation results are objects, and the generic extraction found no text
   * in them, so a generated image came back as "Processing completed" without
   * the path of the file -- which the README says is returned.
   */
  private describeLayerData(data: unknown): unknown {
    if (data && typeof data === 'object' && 'generationType' in data) {
      const media = data as { generationType?: unknown; outputPath?: unknown; metadata?: { responseText?: unknown } };
      const kind = media.generationType === 'audio' ? '🎵 Audio' : media.generationType === 'image' ? '🎨 Image' : 'Media';
      const where = typeof media.outputPath === 'string' && media.outputPath !== '' ? `: ${media.outputPath}` : '';
      const note = typeof media.metadata?.responseText === 'string' && media.metadata.responseText.trim() !== ''
        ? `\n\n${media.metadata.responseText}`
        : '';
      return `${kind} generated${where}${note}`;
    }
    return extractResultText({ data }) ?? data;
  }
}
