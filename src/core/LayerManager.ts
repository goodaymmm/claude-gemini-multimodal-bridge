import { ClaudeCodeLayer } from '../layers/ClaudeCodeLayer.js';
import { GeminiCLILayer } from '../layers/GeminiCLILayer.js';
import { AIStudioLayer } from '../layers/AIStudioLayer.js';
import { logger } from '../utils/logger.js';
import { ErrorHandler, safeExecute } from '../utils/errorHandler.js';
import {
  CGMBError,
  Config,
  ExecutionPlan,
  FileReference,
  LayerResult,
  LayerType,
  ProcessingOptions,
  WorkflowResult,
  WorkflowStep,
  WorkflowType,
  WorkloadAnalysis,
} from './types.js';

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

export class LayerManager {
  private claudeLayer: ClaudeCodeLayer | null = null;
  private geminiLayer: GeminiCLILayer | null = null;
  private aiStudioLayer: AIStudioLayer | null = null;
  private config: Config;
  private layerInitialized: {
    claude: boolean;
    gemini: boolean;
    aistudio: boolean;
  } = {
    claude: false,
    gemini: false,
    aistudio: false
  };

  // Promise cache for async layer initialization
  private claudeLayerPromise: Promise<ClaudeCodeLayer> | null = null;
  private geminiLayerPromise: Promise<GeminiCLILayer> | null = null;
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
      this.claudeLayer = new ClaudeCodeLayer();
      if (!this.layerInitialized.claude) {
        // Initialize only when first accessed
        this.claudeLayer.initialize().then(() => {
          this.layerInitialized.claude = true;
          logger.info('Claude Code layer initialized via lazy loading');
        }).catch(error => {
          logger.error('Failed to initialize Claude Code layer', error as Error);
        });
      }
    }
    return this.claudeLayer;
  }

  /**
   * Get Gemini layer with lazy initialization
   */
  public getGeminiLayer(): GeminiCLILayer {
    if (!this.geminiLayer) {
      logger.info('Lazy initializing Gemini CLI layer');
      this.geminiLayer = new GeminiCLILayer();
      // Gemini layer doesn't require initialization for fast path
    }
    return this.geminiLayer;
  }

  /**
   * Get AI Studio layer with lazy initialization
   */
  public getAIStudioLayer(): AIStudioLayer {
    if (!this.aiStudioLayer) {
      logger.info('Lazy initializing AI Studio layer');
      // Pass GeminiCLILayer reference for translation functionality
      this.aiStudioLayer = new AIStudioLayer(this.getGeminiLayer());
      if (!this.layerInitialized.aistudio) {
        // Initialize only when first accessed
        this.aiStudioLayer.initialize().then(() => {
          this.layerInitialized.aistudio = true;
          logger.info('AI Studio layer initialized via lazy loading');
        }).catch(error => {
          logger.error('Failed to initialize AI Studio layer', error as Error);
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
          this.claudeLayer = new ClaudeCodeLayer();
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
   * Get Gemini layer with guaranteed initialization (async)
   */
  public async getGeminiLayerAsync(): Promise<GeminiCLILayer> {
    if (!this.geminiLayerPromise) {
      this.geminiLayerPromise = (async () => {
        if (!this.geminiLayer) {
          logger.info('Async initializing Gemini CLI layer');
          this.geminiLayer = new GeminiCLILayer();
        }
        if (!this.layerInitialized.gemini) {
          await this.geminiLayer.initialize();
          this.layerInitialized.gemini = true;
          logger.info('Gemini CLI layer initialized (async)');
        }
        return this.geminiLayer;
      })();
    }
    return this.geminiLayerPromise;
  }

  /**
   * Get AI Studio layer with guaranteed initialization (async)
   */
  public async getAIStudioLayerAsync(): Promise<AIStudioLayer> {
    if (!this.aiStudioLayerPromise) {
      this.aiStudioLayerPromise = (async () => {
        if (!this.aiStudioLayer) {
          logger.info('Async initializing AI Studio layer');
          // Ensure Gemini layer is initialized first (needed for translation)
          await this.getGeminiLayerAsync();
          this.aiStudioLayer = new AIStudioLayer(this.geminiLayer!);
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
  public async processSimpleFast(prompt: string, files?: FileReference[]): Promise<LayerResult> {
    logger.info('Fast simple processing', {
      promptLength: prompt.length,
      hasFiles: !!files?.length,
      mode: 'fast'
    });

    try {
      // Use simplified execution directly on Gemini layer (with async initialization)
      const geminiLayer = await this.getGeminiLayerAsync();
      const result = await geminiLayer.execute({
        type: 'text_processing',
        prompt,
        files: files || [],
        useSearch: true // Enable search by default for current information
      });

      logger.info('Fast processing completed', {
        duration: result.metadata?.duration,
        success: result.success
      });

      return result;
    } catch (error) {
      logger.error('Fast processing failed', error as Error);
      throw error;
    }
  }

  /**
   * Intelligent task analysis for optimal layer selection
   * Implements enterprise-level routing logic for CGMB
   * Enhanced to support user-specified layer preferences
   */
  public analyzeTask(task: any, userPreferredLayer?: LayerType): TaskAnalysis {
    const prompt = task.prompt || task.request || task.input || '';
    const files = task.files || [];
    
    // Analyze file types and complexity
    const fileTypes = files.map((f: FileReference) => f.type || this.detectFileType(f.path));
    const hasFiles = files.length > 0;
    const hasImages = fileTypes.some((type: string) => ['image'].includes(type));
    const hasDocuments = fileTypes.some((type: string) => ['pdf', 'document', 'text', 'spreadsheet', 'presentation'].includes(type));
    const hasAudio = fileTypes.some((type: string) => ['audio'].includes(type));
    const hasVideo = fileTypes.some((type: string) => ['video'].includes(type));
    
    // Enhanced code file detection
    const hasCodeFiles = fileTypes.some((type: string) => ['code', 'config', 'markup', 'stylesheet', 'database'].includes(type));
    
    // Analyze prompt characteristics
    const promptLength = prompt.length;
    const isCodeRelated = this.detectCodeContent(prompt) || hasCodeFiles;
    const needsCurrentInfo = this.detectCurrentInfoNeed(prompt);
    const isGenerationTask = this.detectGenerationTask(prompt, task);
    const complexity = this.assessComplexity(prompt, files, task);
    
    // Check for user-specified layer override
    if (userPreferredLayer) {
      return {
        complexity,
        hasFiles,
        fileTypes,
        needsCurrentInfo,
        isGenerationTask,
        isCodeRelated,
        estimatedTokens: Math.ceil(promptLength / 4) + files.length * 100,
        preferredLayer: userPreferredLayer,
        reasoning: `User explicitly requested ${userPreferredLayer} layer`,
      };
    }
    
    // Determine optimal layer based on task characteristics
    let preferredLayer: LayerType;
    let reasoning: string;
    
    // Priority 1: Code files - Route to AI Studio (primary layer for most tasks)
    if (hasCodeFiles) {
      if (isGenerationTask) {
        preferredLayer = 'aistudio';
        reasoning = 'Code files with generation task - AI Studio for multimodal processing';
      } else {
        preferredLayer = 'aistudio';
        reasoning = 'Code files detected - AI Studio for code analysis';
      }
    } 
    // Priority 2: Media files - Route to AI Studio for multimodal processing
    else if (hasFiles && (hasImages || hasAudio || hasVideo)) {
      preferredLayer = 'aistudio';
      reasoning = 'Media files requiring AI Studio multimodal processing';
    }
    // Priority 3: Document files (PDFs, etc.) - Route to AI Studio for OCR and analysis
    else if (hasFiles && hasDocuments) {
      preferredLayer = 'aistudio';
      reasoning = 'Document files requiring AI Studio OCR and analysis capabilities';
    }
    // Priority 4: Generation tasks - Route to AI Studio for content creation
    else if (isGenerationTask && (hasImages || hasAudio || hasVideo || prompt.includes('generate') || prompt.includes('create'))) {
      preferredLayer = 'aistudio';
      reasoning = 'Generation task requiring AI Studio capabilities (Imagen 3, Veo 2)';
    }
    // Priority 5: Current information needs - Route to Gemini CLI for web search
    else if (needsCurrentInfo || task.useSearch !== false || task.type === 'search') {
      preferredLayer = 'gemini';
      reasoning = 'Current information or search required - Gemini CLI optimal';
    }
    // Priority 6: Complex reasoning or code-related prompts - Route to Claude Code
    else if (complexity === 'high' || isCodeRelated || promptLength > 2000) {
      preferredLayer = 'claude';
      reasoning = 'Complex reasoning or code analysis - Claude Code optimal';
    }
    // Priority 7: Simple tasks - Route to Gemini CLI for speed
    else if (complexity === 'low' && promptLength < 500) {
      preferredLayer = 'gemini';
      reasoning = 'Simple task - Gemini CLI for speed';
    }
    // Default: Route to AI Studio (primary layer)
    else {
      preferredLayer = 'aistudio';
      reasoning = 'Default to AI Studio for balanced multimodal capabilities';
    }
    
    const estimatedTokens = Math.ceil(promptLength / 4) + files.length * 100;
    
    return {
      complexity,
      hasFiles,
      fileTypes,
      needsCurrentInfo,
      isGenerationTask,
      isCodeRelated,
      estimatedTokens,
      preferredLayer,
      reasoning,
    };
  }

  /**
   * Execute task with optimal layer selection
   * Implements intelligent routing with fallback strategies
   * Enhanced to support user-specified layer preferences
   */
  public async executeWithOptimalLayer(task: any): Promise<LayerResult> {
    // Extract user-preferred layer from task options
    const userPreferredLayer = task.options?.preferredLayer;
    
    const analysis = this.analyzeTask(task, userPreferredLayer);
    
    logger.info('Optimal layer analysis completed', {
      preferredLayer: analysis.preferredLayer,
      complexity: analysis.complexity,
      reasoning: analysis.reasoning,
      hasFiles: analysis.hasFiles,
      fileTypes: analysis.fileTypes,
      userSpecified: !!userPreferredLayer,
    });

    try {
      return await this.executeWithLayer(analysis.preferredLayer, task);
    } catch (error) {
      logger.warn('Primary layer execution failed, attempting fallback', {
        primaryLayer: analysis.preferredLayer,
        error: (error as Error).message,
      });
      
      return await this.executeWithFallback(task, analysis.preferredLayer);
    }
  }

  /**
   * Execute task with specific layer
   */
  public async executeWithLayer(layerType: LayerType, task: any): Promise<LayerResult> {
    switch (layerType) {
      case 'claude':
        const claudeLayer = await this.getClaudeLayerAsync();
        return await claudeLayer.execute(task);
        
      case 'gemini':
        const geminiLayer = await this.getGeminiLayerAsync();
        return await geminiLayer.execute(task);
        
      case 'aistudio':
        const aiStudioLayer = await this.getAIStudioLayerAsync();
        return await aiStudioLayer.execute(task);
        
      default:
        throw new Error(`Unknown layer type: ${layerType}`);
    }
  }

  /**
   * Execute with fallback strategy
   */
  private async executeWithFallback(task: any, failedLayer: LayerType): Promise<LayerResult> {
    const fallbackOrder = this.getFallbackOrder(failedLayer, task);

    for (const layerType of fallbackOrder) {
      try {
        // Ensure layer is initialized before attempting execution
        await this.ensureLayerInitialized(layerType);

        // Verify layer is actually ready
        if (!this.layerInitialized[layerType as keyof typeof this.layerInitialized]) {
          logger.warn(`Skipping ${layerType} - layer not initialized`, {
            originalLayer: failedLayer,
          });
          continue;
        }

        logger.info('Attempting fallback execution', {
          layer: layerType,
          originalLayer: failedLayer,
        });

        return await this.executeWithLayer(layerType, task);
      } catch (error) {
        logger.warn('Fallback layer also failed', {
          layer: layerType,
          error: (error as Error).message,
        });
        continue;
      }
    }

    throw new Error(`All layers failed for task. Primary: ${failedLayer}, Fallbacks: ${fallbackOrder.join(', ')}`);
  }

  /**
   * Get fallback order based on failed layer and task characteristics
   */
  private getFallbackOrder(failedLayer: LayerType, task: any): LayerType[] {
    const analysis = this.analyzeTask(task);
    
    switch (failedLayer) {
      case 'claude':
        // If Claude fails, try Gemini for search or AI Studio for files
        return analysis.hasFiles ? ['aistudio', 'gemini'] : ['gemini', 'aistudio'];
        
      case 'gemini':
        // If Gemini fails, prefer AI Studio, then Claude for complex tasks only
        return analysis.complexity === 'high' ? ['aistudio', 'claude'] : ['aistudio', 'claude'];
        
      case 'aistudio':
        // If AI Studio fails, prefer Gemini for search, then Claude for complex tasks
        return analysis.complexity === 'high' ? ['gemini', 'claude'] : ['gemini', 'claude'];
        
      default:
        return ['aistudio', 'gemini', 'claude'];
    }
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
        case 'gemini':
          await this.getGeminiLayer().initialize();
          this.layerInitialized.gemini = true;
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
   * Detect if prompt contains code-related content
   */
  private detectCodeContent(prompt: string): boolean {
    const codeKeywords = [
      'function', 'class', 'import', 'export', 'const', 'let', 'var',
      'def', 'if __name__', 'import ', 'from ', 'return',
      'public', 'private', 'protected', 'static',
      'code', 'programming', 'script', 'algorithm', 'debug', 'refactor'
    ];
    
    const lowerPrompt = prompt.toLowerCase();
    return codeKeywords.some(keyword => lowerPrompt.includes(keyword)) ||
           /```/.test(prompt) || // Code blocks
           /\.(js|ts|py|java|cpp|c|go|rs|php)/.test(prompt); // File extensions
  }

  /**
   * Detect if prompt needs current/real-time information
   */
  private detectCurrentInfoNeed(prompt: string): boolean {
    const currentInfoKeywords = [
      'latest', 'recent', 'current', 'today', 'now', 'news', 'trends',
      '2024', '2025', 'this year', 'this month', 'this week',
      'search', 'find', 'what is happening', 'breaking', 'update'
    ];
    
    const lowerPrompt = prompt.toLowerCase();
    return currentInfoKeywords.some(keyword => lowerPrompt.includes(keyword));
  }

  /**
   * Detect if task is for content generation
   */
  private detectGenerationTask(prompt: string, task: any): boolean {
    const generationKeywords = [
      'generate', 'create', 'make', 'produce', 'build', 'design',
      'draw', 'paint', 'compose', 'write', 'author', 'craft'
    ];
    
    const lowerPrompt = prompt.toLowerCase();
    return generationKeywords.some(keyword => lowerPrompt.includes(keyword)) ||
           task.type === 'generation' ||
           task.action === 'generate' ||
           lowerPrompt.includes('image of') ||
           lowerPrompt.includes('picture of');
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
   * Determine if a prompt is simple enough for fast processing
   * Based on reference implementation principles
   */
  private isSimplePrompt(prompt: string, files?: FileReference[]): boolean {
    // NEW: Check for file paths embedded in prompt (Windows + Unix)
    // If paths found, this is not a simple prompt - needs file processing
    const filePathRegex = /(?:[A-Za-z]:\\[^\s"'<>|]+\.[a-zA-Z0-9]+|\/(?!https?:)[^\s"'<>|]+\.[a-zA-Z0-9]+|\.\.?\/[^\s"'<>|]+\.[a-zA-Z0-9]+)/gi;
    const embeddedPaths = prompt.match(filePathRegex) || [];

    if (embeddedPaths.length > 0) {
      logger.debug('File paths detected in prompt - not simple', { paths: embeddedPaths });
      return false;
    }

    // Fast processing criteria
    const isSimple =
      prompt.length < 1000 &&              // Short prompt
      (!files || files.length === 0) &&    // No files
      !prompt.includes('workflow') &&      // No workflow keywords
      !prompt.includes('orchestrate') &&   // No orchestration
      !prompt.includes('generate image') && // No AI Studio tasks
      !prompt.includes('convert') &&       // No complex conversion
      !prompt.includes('analyze multiple'); // No multi-step analysis

    logger.debug('Simple prompt check', {
      promptLength: prompt.length,
      hasFiles: !!files?.length,
      isSimple
    });

    return isSimple;
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

    // Fast path for simple prompts (reference implementation style)
    if (this.isSimplePrompt(prompt, files) && workflow === 'analysis') {
      logger.info('Using fast path for simple multimodal request');

      try {
        const result = await this.processSimpleFast(prompt, files);

        // Convert to WorkflowResult format
        return {
          success: result.success,
          results: [result],
          metadata: {
            workflow: 'analysis',
            execution_mode: 'fast',
            total_duration: result.metadata?.duration || 0,
            steps_completed: 1,
            steps_failed: 0,
            layers_used: ['gemini'],
            optimization: 'fast-path-bypass'
          }
        };
      } catch (error) {
        logger.warn('Fast path failed, falling back to full workflow', {
          error: (error as Error).message
        });
        // Continue to full workflow below
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
        // Direct AI Studio execution for file analysis (skip 3-step workflow)
        const aiStudioLayer = await this.getAIStudioLayerAsync();
        const result = await aiStudioLayer.execute({
          type: 'multimodal_processing',
          action: 'analyze',
          prompt,
          files,
          options: options || {}
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
          error: (error as Error).message,
          fileCount: files.length
        });
        // Continue to full workflow below
      }
    }

    // Create execution plan based on workflow type
    const executionPlan = await this.createWorkflowPlan(workflow, {
      prompt,
      files,
      options: options || {},
    });

    // Execute the workflow
    return this.executeWorkflow(executionPlan, { prompt, files }, {
      executionMode: options?.execution_mode || 'adaptive',
      timeout: options?.timeout || 300000,
    });
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
            layer: 'gemini',
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
      executionMode: options?.execution_mode || 'sequential',
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
      logger.error('Workflow execution failed', { error, totalDuration });
      
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

    // Sort steps by dependencies
    const sortedSteps = this.topologicalSort(workflow.steps);

    for (const step of sortedSteps) {
      try {
        // Prepare step input by resolving references
        const stepInput = this.resolveStepInput(step.input, stepOutputs, inputData);
        
        // Execute step
        const result = await this.executeStep(step, stepInput, options);
        results[step.id] = result;
        
        if (result.success && result.data) {
          stepOutputs[step.id] = { output: result.data };
        }

        logger.debug(`Step ${step.id} completed`, {
          success: result.success,
          duration: result.metadata.duration,
        });
      } catch (error) {
        logger.error(`Step ${step.id} failed`, error as Error);
        
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
    
    // Group steps by dependency level
    const dependencyLevels = this.groupStepsByDependencies(workflow.steps);
    
    for (const level of dependencyLevels) {
      const promises = level.map(async (step) => {
        try {
          const stepInput = this.resolveStepInput(step.input, results, inputData);
          const result = await this.executeStep(step, stepInput, options);
          return { stepId: step.id, result };
        } catch (error) {
          logger.error(`Step ${step.id} failed in parallel execution`, error as Error);
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
    let recommendedLayer: LayerType = 'gemini'; // Default to Gemini CLI for simple prompts
    
    // Check if this is a simple prompt (no files, no generation, no complex reasoning)
    const isSimplePrompt = !hasMultimodalFiles && !isGenerationRequest && !requiresComplexReasoning && !multipleSteps;
    
    // HIGHEST PRIORITY: Web search goes to Gemini CLI
    if (requiresGrounding && !hasMultimodalFiles) {
      recommendedLayer = 'gemini';
      logger.info('Routing to Gemini CLI for web search', {
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
      // Document processing goes to AI Studio with gemini-2.5-flash
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
      // Simple prompts go to Gemini CLI (2.5 Pro) for best performance
      recommendedLayer = 'gemini';
      logger.info('Routing simple prompt to Gemini CLI', {
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
  private async executeHybrid(
    workflow: ExecutionPlan,
    inputData: Record<string, unknown>,
    options: ExecutionOptions,
    analysis: WorkloadAnalysis
  ): Promise<Record<string, LayerResult>> {
    // Group steps by recommended layer and execute accordingly
    const stepGroups = this.groupStepsByRecommendedLayer(workflow.steps, analysis);
    const results: Record<string, LayerResult> = {};

    // Execute high-priority steps first
    for (const [_priority, steps] of Object.entries(stepGroups)) {
      if (steps.length === 1) {
        // Single step - execute directly
        const step = steps[0]!;
        const stepInput = this.resolveStepInput(step.input, results, inputData);
        results[step.id] = await this.executeStep(step, stepInput, options);
      } else {
        // Multiple steps - execute in parallel if possible
        const promises = steps.map(async (step) => {
          const stepInput = this.resolveStepInput(step.input, results, inputData);
          return {
            stepId: step.id,
            result: await this.executeStep(step, stepInput, options),
          };
        });

        const stepResults = await Promise.all(promises);
        stepResults.forEach(({ stepId, result }) => {
          results[stepId] = result;
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

    if (!strategy || strategy.replace !== failedStep.id) {
      return null;
    }

    logger.info(`Attempting fallback strategy for step ${failedStep.id}`, {
      strategy: strategyKey,
      fallbackLayer: strategy.with.layer,
    });

    try {
      const fallbackInput = this.resolveStepInput(
        strategy.with.input,
        {},
        failedStep.input
      );
      
      return await this.executeStep(strategy.with, fallbackInput, options);
    } catch (fallbackError) {
      logger.error(`Fallback strategy failed for step ${failedStep.id}`, fallbackError as Error);
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
            layer: 'gemini',
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
          layer: 'gemini',
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
      case 'gemini':
        return this.getGeminiLayer();
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
      case 'gemini':
        return await this.getGeminiLayerAsync();
      case 'aistudio':
        return await this.getAIStudioLayerAsync();
      default:
        throw new CGMBError(`Unknown layer type: ${layerType}`, 'INVALID_LAYER_TYPE');
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
      const dependencies = step.dependsOn || [];
      for (const depId of dependencies) {
        const depStep = steps.find(s => s.id === depId);
        if (depStep) {
          visit(depStep);
        }
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
        const dependencies = step.dependsOn || [];
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
    const groups: Record<string, WorkflowStep[]> = {
      high: [],
      medium: [],
      low: [],
    };

    steps.forEach(step => {
      if (step.layer === analysis.recommendedLayer) {
        groups.high!.push(step);
      } else if (step.layer === 'claude') {
        groups.medium!.push(step);
      } else {
        groups.low!.push(step);
      }
    });

    return groups;
  }

  private resolveStepInput(
    input: Record<string, unknown>,
    stepOutputs: Record<string, Record<string, unknown>>,
    baseInput: Record<string, unknown>
  ): Record<string, unknown> {
    const resolved: Record<string, unknown> = { ...baseInput };

    for (const [key, value] of Object.entries(input)) {
      if (typeof value === 'string' && value.startsWith('@')) {
        // Reference to another step's output
        const [stepId, ...pathParts] = value.slice(1).split('.');
        const stepOutput = stepOutputs[stepId!];

        if (stepOutput) {
          // Check if the step result is a failed LayerResult (has success: false)
          const layerResult = stepOutput as { success?: boolean; error?: string; output?: unknown };
          if (layerResult.success === false) {
            // Previous step failed - provide context for downstream handling
            logger.warn(`Step reference ${value} points to failed step ${stepId}`, {
              stepId,
              error: layerResult.error || 'Unknown error'
            });
            resolved[key] = {
              _stepFailed: true,
              _stepId: stepId,
              _error: layerResult.error || 'Previous step failed',
              _originalReference: value
            };
            continue;
          }

          let resolvedValue: unknown = stepOutput;
          for (const part of pathParts) {
            if (typeof resolvedValue === 'object' && resolvedValue !== null) {
              resolvedValue = (resolvedValue as Record<string, unknown>)[part];
            } else {
              resolvedValue = undefined;
              break;
            }
          }
          resolved[key] = resolvedValue;
        } else {
          // Step output not found - could be a failed step or not yet executed
          logger.warn(`Could not resolve step reference: ${value}`, {
            stepId,
            availableSteps: Object.keys(stepOutputs),
            hint: 'The referenced step may have failed or not been executed'
          });
          // Provide context for downstream handling
          resolved[key] = {
            _stepMissing: true,
            _stepId: stepId,
            _originalReference: value,
            _hint: 'Referenced step output not available - step may have failed or not executed'
          };
        }
      } else {
        resolved[key] = value;
      }
    }

    return resolved;
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
      // Get the appropriate layer
      const layer = await this.getLayerAsync(step.layer);
      
      // Prepare the execution parameters
      const executionParams = {
        type: this.mapActionToTaskType(step.action),
        action: step.action,
        ...input,
      };

      // Execute the step with timeout
      const result = await safeExecute(
        () => layer.execute(executionParams),
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

      return {
        success: true,
        data: result,
        metadata: {
          layer: step.layer,
          duration,
          model: step.action,
        },
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      
      logger.error(`Step ${step.id} failed on ${step.layer} layer`, {
        error: (error as Error).message,
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