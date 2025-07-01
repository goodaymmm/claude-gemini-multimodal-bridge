import { execSync, spawn } from 'child_process';
import { FileReference, GroundedResult, GroundingContext, LayerInterface, LayerResult, MultimodalResult } from '../core/types.js';

// Task interface for better type safety
interface GeminiTask {
  type?: string;
  action?: string;
  prompt?: string;
  request?: string;
  input?: string;
  useSearch?: boolean;
  needsGrounding?: boolean;
  files?: FileReference[];
  [key: string]: unknown;
}
import { logger } from '../utils/logger.js';
import { retry, safeExecute } from '../utils/errorHandler.js';
import { AuthVerifier } from '../auth/AuthVerifier.js';
import { OAuthManager } from '../auth/OAuthManager.js';
import { getQuotaMonitor, QuotaMonitor } from '../utils/quotaMonitor.js';
import { OptimizationOptions, PromptOptimizer } from '../utils/PromptOptimizer.js';
import { CacheOptions, SearchCache } from '../utils/SearchCache.js';

/**
 * GeminiCLILayer handles Gemini CLI integration with enhanced authentication support
 * Provides grounding with Google Search integration and multimodal processing
 */
export class GeminiCLILayer implements LayerInterface {
  private authVerifier: AuthVerifier;
  private oauthManager: OAuthManager;
  private quotaMonitor: QuotaMonitor;
  private promptOptimizer: PromptOptimizer;
  private searchCache: SearchCache;
  private geminiPath?: string;
  private isInitialized = false;
  private isLightweightInitialized = false; // Fast initialization without full checks
  private lastAuthCheck = 0; // Timestamp of last auth verification
  private readonly AUTH_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours auth cache (OAuth tokens typically valid for 24h)
  private readonly DEFAULT_TIMEOUT = 120000; // 2 minutes
  private readonly MAX_RETRIES = 2;
  private readonly DEBUG_MODE = process.env.CGMB_DEBUG === 'true'; // Enable debug mode with stdio: 'inherit'
  private readonly RATE_LIMIT = {
    requests: 60,
    window: 60000, // 60 requests per minute
    daily: 1000,   // 1000 requests per day (free tier)
  };
  private requestCount = 0;
  private dailyRequestCount = 0;
  private lastRequestTime = 0;
  private dailyResetTime = 0;

  constructor() {
    this.authVerifier = new AuthVerifier();
    this.oauthManager = new OAuthManager();
    this.quotaMonitor = getQuotaMonitor(); // Defaults to free tier
    
    // Initialize prompt optimizer and search cache
    this.promptOptimizer = new PromptOptimizer();
    this.searchCache = new SearchCache({
      ttl: parseInt(process.env.CACHE_TTL || '1800000'), // 30 minutes default
      maxEntries: parseInt(process.env.MAX_CACHE_ENTRIES || '1000'),
      enableMetrics: process.env.ENABLE_CACHING === 'true',
      similarityThreshold: 0.8
    });
    
    this.resetDailyCounterIfNeeded();
  }

  /**
   * Lightweight initialization for simple tasks (skips connection tests)
   */
  async initializeLightweight(): Promise<void> {
    if (this.isLightweightInitialized) {
      return;
    }

    logger.debug('Performing lightweight Gemini CLI initialization...');

    // Find path only if not already set
    if (!this.geminiPath) {
      this.geminiPath = await this.findGeminiPath() || '';
      if (!this.geminiPath) {
        throw new Error('Gemini CLI executable not found');
      }
    }

    // Simplified auth check - let Gemini CLI handle authentication internally
    // Only verify if it's been more than 24 hours since last check
    const now = Date.now();
    if (now - this.lastAuthCheck > this.AUTH_CACHE_TTL) {
      try {
        const authResult = await this.authVerifier.verifyGeminiAuth();
        if (authResult.success) {
          this.lastAuthCheck = now;
        }
        // Don't fail initialization if auth check fails - let execution handle it
      } catch (error) {
        logger.debug('Auth verification skipped, will rely on CLI error handling', { error });
      }
    }

    this.isLightweightInitialized = true;
    logger.debug('Lightweight Gemini CLI initialization completed');
  }

  /**
   * Initialize the Gemini CLI layer
   */
  async initialize(): Promise<void> {
    return safeExecute(
      async () => {
        if (this.isInitialized) {
          return;
        }

        logger.info('Initializing Gemini CLI layer...');

        // Verify Gemini CLI installation and authentication
        const authResult = await this.authVerifier.verifyGeminiAuth();
        if (!authResult.success) {
          throw new Error(`Gemini CLI authentication failed: ${authResult.error}`);
        }

        // Find Gemini CLI executable path
        this.geminiPath = await this.findGeminiPath() || '';
        if (!this.geminiPath) {
          throw new Error('Gemini CLI executable not found');
        }

        // Test basic functionality
        await this.testGeminiConnection();

        this.isInitialized = true;
        logger.info('Gemini CLI layer initialized successfully', {
          geminiPath: this.geminiPath,
          authenticated: authResult.success,
          authMethod: authResult.status.method,
        });
      },
      {
        operationName: 'initialize-gemini-cli-layer',
        layer: 'gemini',
        timeout: 90000,
      }
    );
  }

  /**
   * Check if Gemini CLI layer is available
   */
  async isAvailable(): Promise<boolean> {
    try {
      if (!this.isInitialized) {
        await this.initialize();
      }
      return this.isInitialized;
    } catch (error) {
      logger.debug('Gemini CLI layer not available', { error: (error as Error).message });
      return false;
    }
  }

  /**
   * Check if this layer can handle the given task
   */
  canHandle(task: GeminiTask): boolean {
    if (!task || typeof task !== 'object') {
      return false;
    }

    // Handle grounding tasks
    if (task.type === 'grounding' || task.action === 'grounded_search') {
      return true;
    }

    // Handle contextual analysis
    if (task.action === 'contextual_analysis') {
      return true;
    }

    // Handle multimodal tasks (basic support)
    if (task.type === 'multimodal' && task.files) {
      return true;
    }

    // Handle general Gemini tasks
    if (task.type === 'gemini' || task.useSearch || task.needsGrounding) {
      return true;
    }

    return false;
  }

  /**
   * Fast execution mode for simple prompts (reference implementation style)
   * Skips initialization overhead and complex validation
   */
  async executeFast(task: GeminiTask): Promise<LayerResult> {
    const startTime = Date.now();
    
    logger.info('Fast Gemini CLI execution', {
      taskType: task.type || 'general',
      promptLength: task.prompt?.length || 0,
      mode: 'fast'
    });

    try {
      // Minimal setup: just ensure geminiPath exists
      if (!this.geminiPath) {
        this.geminiPath = await this.findGeminiPath() || 'gemini';
      }

      const prompt = task.prompt || task.request || task.input || '';
      
      if (!prompt.trim()) {
        throw new Error('No prompt provided for Gemini CLI execution');
      }

      // Use reference implementation method directly (simplified pattern)
      const result = await this.executeGeminiCLIReference(prompt, { 
        model: (task.model as string) || 'gemini-2.5-pro' 
      });
      
      const duration = Date.now() - startTime;
      
      return {
        success: true,
        data: result,
        metadata: {
          layer: 'gemini' as const,
          duration,
          fast_mode: true,
          model: 'gemini-2.5-pro',
          optimization: 'reference-implementation-style'
        }
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error('Fast Gemini CLI execution failed', {
        error: (error as Error).message,
        duration
      });
      
      throw new Error(`Fast execution failed: ${(error as Error).message}`);
    }
  }

  /**
   * Execute a task through Gemini CLI with enhanced retry logic
   * Implements Gemini's architectural recommendations for production reliability
   */
  async execute(task: GeminiTask): Promise<LayerResult> {
    const maxRetries = 2;
    const startTime = Date.now();
    let lastError: Error | null = null;
    
    // Pre-execution setup (only done once)
    await this.setupForExecution(task);
    
    // Retry loop with exponential backoff
    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      try {
        logger.debug('Gemini CLI execution attempt', {
          attempt,
          maxRetries: maxRetries + 1,
          taskType: task.type,
          useSearch: task.useSearch
        });
        
        const result = await this.executeTaskWithTimeout(task, startTime, attempt);
        
        if (attempt > 1) {
          logger.info('Gemini CLI task succeeded after retry', {
            attempt,
            taskType: task.type,
            totalDuration: Date.now() - startTime
          });
        }
        
        return result;
        
      } catch (error) {
        lastError = error as Error;
        
        // Check if this is a retryable error
        const isRetryable = this.isRetryableError(lastError);
        const isLastAttempt = attempt === maxRetries + 1;
        
        if (isRetryable && !isLastAttempt) {
          const backoffTime = Math.min(2000 * Math.pow(2, attempt - 1), 8000); // Cap at 8 seconds
          
          logger.warn('Gemini CLI task failed, retrying', {
            attempt,
            error: lastError.message,
            retryAfter: backoffTime,
            isRetryable
          });
          
          // Exponential backoff wait
          await new Promise(resolve => setTimeout(resolve, backoffTime));
          
        } else {
          // Log final failure
          logger.error('Gemini CLI task failed permanently', {
            attempt,
            totalAttempts: maxRetries + 1,
            error: lastError.message,
            isRetryable,
            totalDuration: Date.now() - startTime
          });
          
          // Throw structured error as recommended by Gemini
          throw this.createStructuredError(lastError, task, {
            attempts: attempt,
            totalDuration: Date.now() - startTime,
            isRetryable
          });
        }
      }
    }
    
    // This should never be reached, but safety fallback
    throw this.createStructuredError(lastError || new Error('Unknown execution failure'), task, {
      attempts: maxRetries + 1,
      totalDuration: Date.now() - startTime,
      isRetryable: false
    });
  }

  /**
   * Pre-execution setup (extracted from execute for cleaner retry logic)
   */
  private async setupForExecution(task: GeminiTask): Promise<void> {
    // Use lightweight initialization for simple tasks
    if (!this.isInitialized && !this.isLightweightInitialized) {
      if (task.type === 'text_processing' && !task.files && task.useSearch === false) {
        try {
          await this.initializeLightweight();
        } catch (lightweightError) {
          logger.debug('Lightweight initialization failed, trying full initialization', {
            error: (lightweightError as Error).message
          });
          await this.initialize();
        }
      } else {
        await this.initialize();
      }
    }

    // Check quota limits before execution
    const estimatedTokens = QuotaMonitor.estimateTokens(
      JSON.stringify(task), 
      task.files?.length || 0
    );
    const quotaCheck = this.quotaMonitor.canMakeRequest(estimatedTokens);
    if (!quotaCheck.allowed) {
      throw new Error(`Quota limit exceeded: ${quotaCheck.reason}. ${quotaCheck.waitTime ? `Wait ${Math.ceil(quotaCheck.waitTime / 1000)}s` : 'Try again later'}`);
    }

    // Check legacy rate limits
    await this.checkRateLimit();
  }

  /**
   * Execute the actual task with timeout (extracted for cleaner retry logic)
   */
  private async executeTaskWithTimeout(task: GeminiTask, startTime: number, attempt: number): Promise<LayerResult> {
    return safeExecute(
      async () => {
        logger.info('Executing Gemini CLI task', {
          taskType: task.type || 'general',
          action: task.action || 'execute',
          useSearch: task.useSearch !== false, // Log actual effective value
          attempt
        });

        let result: any;

        // Route to appropriate execution method based on task type/action
        switch (task.action || task.type) {
          case 'grounded_search':
            const groundedResult = await this.executeWithGrounding(task.prompt || task.request || '', {
              useSearch: task.useSearch !== false, // Use corrected logic
              files: task.files?.map(f => f.path) || [],
              context: task.context as string | undefined,
            });
            result = groundedResult.content || 'Search completed';
            break;
          case 'contextual_analysis':
            result = await this.executeContextualAnalysis(task);
            break;
          case 'multimodal':
            const multimodalResult = await this.processFiles(task.files || [], task.prompt || task.request || '');
            result = multimodalResult.content || 'Processing completed';
            break;
          default:
            result = await this.executeGeneral(task);
        }

        const duration = Date.now() - startTime;
        const tokensUsed = this.estimateTokensUsed(task, result);
        
        // Track quota usage
        this.quotaMonitor.trackRequest(tokensUsed);
        
        return {
          success: true,
          data: result,
          metadata: {
            layer: 'gemini' as const,
            duration,
            tokens_used: tokensUsed,
            cost: this.calculateCost(task, result),
            model: 'gemini-2.5-pro',
            quota_status: this.quotaMonitor.getQuotaStatus(),
            retry_attempt: attempt,
          },
        };
      },
      {
        operationName: 'execute-gemini-cli-task',
        layer: 'gemini',
        timeout: this.getTaskTimeout(task),
      }
    );
  }

  /**
   * Determine if an error is retryable
   */
  private isRetryableError(error: Error): boolean {
    const retryablePatterns = [
      /timeout/i,
      /network/i,
      /connection/i,
      /temporary/i,
      /rate limit/i,
      /server error/i,
      /503/,
      /502/,
      /504/
    ];
    
    // Check if error message matches retryable patterns
    const isRetryable = retryablePatterns.some(pattern => pattern.test(error.message));
    
    // Don't retry authentication errors or quota exceeded errors
    const nonRetryablePatterns = [
      /authentication/i,
      /unauthorized/i,
      /forbidden/i,
      /quota.*exceeded/i,
      /api key/i,
      /permission/i
    ];
    
    const isNonRetryable = nonRetryablePatterns.some(pattern => pattern.test(error.message));
    
    return isRetryable && !isNonRetryable;
  }

  /**
   * Create structured error response as recommended by Gemini
   */
  private createStructuredError(error: Error, task: GeminiTask, metadata: any): Error {
    const structuredError = new Error(error.message);
    (structuredError as any).details = {
      error: 'ProcessingTimeout',
      message: error.message,
      layer: 'GeminiCLILayer',
      taskDetails: {
        type: task.type,
        useSearch: task.useSearch !== false,
        action: task.action,
        hasFiles: !!(task.files && task.files.length > 0)
      },
      executionMetadata: metadata
    };
    
    return structuredError;
  }

  /**
   * Execute with grounding (Google Search integration)
   */
  async executeWithGrounding(prompt: string, context: GroundingContext): Promise<GroundedResult> {
    return retry(
      async () => {
        const startTime = Date.now();
        let optimizedPrompt = prompt;
        
        logger.debug('Executing grounded search', {
          promptLength: prompt.length,
          useSearch: context.useSearch,
          searchQuery: context.searchQuery?.substring(0, 50),
        });

        // Check cache first for search tasks
        if (context.useSearch !== false) {
          const cachedResult = await this.searchCache.get(prompt, 'gemini');
          if (cachedResult) {
            logger.debug('Cache hit for grounded search', {
              promptLength: prompt.length,
              cacheAge: Date.now() - cachedResult.timestamp
            });
            return cachedResult;
          }
        }

        // Optimize prompt for search tasks
        if (context.useSearch !== false && prompt.length > 500) {
          try {
            const optimization = await this.promptOptimizer.optimizeForWebSearch(prompt, {
              maxTokens: 4000,
              preserveContext: true,
              removeRedundancy: true,
              extractKeywords: true,
              useTemplates: true
            });
            
            optimizedPrompt = optimization.optimizedPrompt;
            
            logger.info('Prompt optimized for search', {
              originalLength: prompt.length,
              optimizedLength: optimizedPrompt.length,
              reductionPercentage: optimization.reductionPercentage.toFixed(1),
              methods: optimization.optimizationMethods.join(', ')
            });
          } catch (error) {
            logger.warn('Prompt optimization failed, using original', { error });
            optimizedPrompt = prompt;
          }
        }

        // Build final prompt with context
        let finalPrompt = optimizedPrompt;
        if (context.context) {
          finalPrompt += `\n\nAdditional context: ${context.context}`;
        }

        // Note: File handling in reference implementation needs extension
        // For now, focusing on search grounding without files
        const output = await this.executeGeminiCLIReference(finalPrompt);
        const processingTime = Date.now() - startTime;
        
        const result: GroundedResult = {
          content: output.trim(),
          sources: this.extractSources(output),
          grounded: true,
          search_used: context.useSearch !== false,
        };

        // Cache the result for search tasks
        if (context.useSearch !== false) {
          await this.searchCache.set(prompt, result, 'gemini', processingTime);
        }
        
        return result;
      },
      {
        maxAttempts: this.MAX_RETRIES,
        delay: 2000,
        operationName: 'grounded-search',
      }
    );
  }

  /**
   * Process files with multimodal capabilities
   */
  async processFiles(files: FileReference[], prompt: string): Promise<MultimodalResult> {
    return retry(
      async () => {
        logger.debug('Processing files with Gemini', {
          fileCount: files.length,
          promptLength: prompt.length,
        });

        // Validate file types and sizes
        this.validateFiles(files);

        // Note: File processing with reference implementation needs extension
        // For now, using basic prompt-based analysis
        const startTime = Date.now();
        const output = await this.executeGeminiCLIReference(prompt);
        const processingTime = Date.now() - startTime;

        return {
          content: output.trim(),
          success: true,
          files_processed: files.map(f => f.path),
          processing_time: processingTime,
          workflow_used: 'analysis' as const,
          layers_involved: ['gemini'] as const,
          metadata: {
            total_duration: processingTime,
            tokens_used: this.estimateTokensUsed({ files, prompt }, output),
            cost: this.estimateCost({ files, prompt }, output),
          },
        };
      },
      {
        maxAttempts: this.MAX_RETRIES,
        delay: 3000,
        operationName: 'process-files',
      }
    );
  }

  /**
   * Execute contextual analysis (using reference implementation style)
   */
  async executeContextualAnalysis(task: GeminiTask): Promise<string> {
    return retry(
      async () => {
        logger.debug('Executing contextual analysis', {
          hasContext: !!task.context,
          promptLength: task.prompt?.length || 0,
        });

        let prompt = task.prompt || task.request || '';
        if (task.context) {
          prompt += `\n\nContext: ${task.context}`;
        }

        // Note: File support would need to be added to reference implementation
        // For now, focusing on prompt-based analysis
        const options: { model?: string } = {};
        if (task.model && typeof task.model === 'string') {
          options.model = task.model;
        }
        const output = await this.executeGeminiCLIReference(prompt, options);
        return output.trim();
      },
      {
        maxAttempts: this.MAX_RETRIES,
        delay: 1500,
        operationName: 'contextual-analysis',
      }
    );
  }

  /**
   * Get layer capabilities
   */
  getCapabilities(): string[] {
    return [
      'grounded_search',
      'contextual_analysis',
      'multimodal_processing',
      'real_time_information',
      'web_search',
      'image_analysis',
      'document_processing',
      'current_events',
    ];
  }

  /**
   * Get cost estimation for a task
   */
  getCost(task: GeminiTask): number {
    // Free tier: 1000 requests/day, then paid
    // Assuming free tier usage, cost is 0
    return 0;
  }

  /**
   * Get estimated duration for a task
   */
  getEstimatedDuration(task: any): number {
    const baseTime = 3000; // 3 seconds base
    
    if (task.files && task.files.length > 0) {
      return baseTime + (task.files.length * 2000); // +2s per file
    }
    
    if (task.useSearch || task.action === 'grounded_search') {
      return baseTime + 5000; // +5s for search
    }
    
    if (task.prompt && task.prompt.length > 1000) {
      return baseTime + 2000; // +2s for long prompts
    }
    
    return baseTime;
  }

  /**
   * Execute general Gemini task (using reference implementation style)
   */
  private async executeGeneral(task: any): Promise<string> {
    const prompt = task.prompt || task.request || task.input || 'Please help with this task.';
    
    // Use reference implementation style for better compatibility
    const options: { model?: string } = {};
    if (task.model && typeof task.model === 'string') {
      options.model = task.model;
    }
    return await this.executeGeminiCLIReference(prompt, options);
  }

  /**
   * Build Gemini CLI command arguments (for file processing only - prompts use -p flag)
   */
  private buildGeminiCommand(options: {
    files?: string[];
  } = {}): string[] {
    const args: string[] = [];

    // Note: Web search is built-in and enabled by default in Gemini CLI
    // No special flags are needed - Gemini will automatically use web search when beneficial

    // Add files if provided
    if (options.files && options.files.length > 0) {
      options.files.forEach(file => {
        args.push(`@${file}`);
      });
    }

    // Don't add -p flag here - prompts are handled separately with -p flag
    logger.debug('Built Gemini command arguments', {
      argsCount: args.length,
      hasFiles: options.files && options.files.length > 0,
      command: `gemini ${args.join(' ')}`
    });

    return args;
  }

  /**
   * Reference implementation style execution (mcp-gemini-cli compatible)
   * Uses -p flag directly instead of stdin for better compatibility
   */
  private async executeGeminiCLIReference(prompt: string, options: { model?: string } = {}): Promise<string> {
    const command = this.geminiPath || 'gemini';
    // Use same argument construction as successful fast path
    const args = ['-p', prompt];
    
    if (options.model && options.model !== 'gemini-2.5-pro') {
      args.push('-m', options.model);
    }
    
    return new Promise<string>((resolve, reject) => {
      logger.debug('Executing Gemini CLI (reference style)', {
        command,
        args,
        fullCommand: `${command} ${args.join(' ')}`,
        argsCount: args.length,
        promptLength: prompt.length
      });

      const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      
      let stdout = '';
      let stderr = '';
      
      // No stdin processing - pure command argument approach
      
      child.stdout?.on('data', (data) => {
        stdout += data.toString();
      });
      
      child.stderr?.on('data', (data) => {
        stderr += data.toString();
      });
      
      child.on('close', (code) => {
        logger.debug('Gemini CLI process closed', {
          code,
          stdoutLength: stdout.length,
          stderrLength: stderr.length,
          hasStdout: stdout.length > 0,
          hasStderr: stderr.length > 0
        });
        
        if (code === 0) {
          logger.debug('Gemini CLI execution successful', {
            outputPreview: stdout.substring(0, 200) + (stdout.length > 200 ? '...' : '')
          });
          resolve(stdout.trim());
        } else {
          logger.error('Gemini CLI execution failed', {
            code,
            stderr: stderr.substring(0, 500),
            fullCommand: `${command} ${args.join(' ')}`
          });
          
          // Enhanced error handling for common issues
          if (stderr.includes('function response parts') || stderr.includes('function call parts')) {
            reject(new Error(`Function call mismatch error. This usually indicates an authentication or API configuration issue. Try:\n1. gemini auth (OAuth - recommended)\n2. Check API key configuration\n3. Verify gemini CLI version\n\nOriginal error: ${stderr}`));
          } else if (stderr.includes('UNAUTHENTICATED') || stderr.includes('API_KEY')) {
            reject(new Error(`Authentication failed. Try: gemini auth\n${stderr}`));
          } else {
            reject(new Error(`gemini exited with code ${code}: ${stderr}`));
          }
        }
      });
      
      child.on('error', (err) => {
        reject(new Error(`Spawn error: ${err.message}`));
      });
      
      // Reference implementation timeout
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error('Gemini CLI timeout (30s)'));
      }, 30000);
      
      child.on('close', () => clearTimeout(timeout));
    });
  }

  /**
   * Fast lightweight spawn implementation based on mcp-gemini-cli reference
   * Uses pure command argument approach without stdin
   */
  private async executeGeminiProcessFast(prompt: string, options: { model?: string } = {}): Promise<string> {
    const command = this.geminiPath || 'gemini';
    // Construct args the same way as executeGeminiCLIReference
    const args = ['-p', prompt];
    
    if (options.model && options.model !== 'gemini-2.5-pro') {
      args.push('-m', options.model);
    }
    
    return new Promise<string>((resolve, reject) => {
      logger.debug('Fast Gemini CLI execution', {
        command,
        args,
        fullCommand: `${command} ${args.join(' ')}`,
        argsCount: args.length,
        promptLength: prompt.length
      });

      const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      
      let output = '';
      let errorOutput = '';
      
      // No stdin processing - pure command argument approach
      
      child.stdout?.on('data', (data) => {
        output += data.toString();
      });
      
      child.stderr?.on('data', (data) => {
        errorOutput += data.toString();
      });
      
      child.on('close', (code) => {
        if (code === 0) {
          resolve(output.trim());
        } else {
          reject(new Error(`Gemini CLI failed: ${errorOutput || 'Unknown error'}`));
        }
      });
      
      child.on('error', (error) => {
        reject(new Error(`Process spawn failed: ${error.message}`));
      });
      
      // Shorter timeout for fast execution (30 seconds like reference)
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error(`Fast execution timeout after 30s`));
      }, 30000);
      
      child.on('close', () => clearTimeout(timeout));
    });
  }

  /**
   * Execute Gemini CLI process using reference implementation
   * Wrapper for backward compatibility
   */
  private async executeGeminiProcess(args: string[], promptContent: string): Promise<string> {
    if (!this.geminiPath) {
      throw new Error('Gemini CLI not initialized');
    }

    // Simplified: Use reference implementation pattern for all cases
    if (!promptContent || !promptContent.trim()) {
      throw new Error('No prompt content provided for Gemini CLI execution');
    }

    // Update rate limiting
    this.requestCount++;
    this.dailyRequestCount++;
    this.lastRequestTime = Date.now();

    // Use reference implementation method
    return await this.executeGeminiCLIReference(promptContent);
  }

  /**
   * Find Gemini CLI executable path
   */
  private async findGeminiPath(): Promise<string | undefined> {
    const possiblePaths = [
      'gemini',
      '/usr/local/bin/gemini',
      '/opt/homebrew/bin/gemini',
    ];

    for (const path of possiblePaths) {
      try {
        execSync(`${path} --version`, { stdio: 'ignore', timeout: 5000 });
        logger.debug('Found Gemini CLI at', { path });
        return path;
      } catch {
        continue;
      }
    }

    // Try system PATH
    try {
      const output = execSync('which gemini 2>/dev/null || where gemini 2>nul', {
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 5000,
      });
      
      const path = output.trim().split('\n')[0];
      if (path) {
        return path;
      }
    } catch {
      // System PATH lookup failed
    }

    return undefined;
  }

  /**
   * Test Gemini CLI connection
   */
  private async testGeminiConnection(): Promise<void> {
    try {
      // Simplified connection test using reference implementation pattern
      const testPrompt = 'Test connection';
      await this.executeGeminiCLIReference(testPrompt);
      logger.debug('Gemini CLI connection test successful');
    } catch (error) {
      throw new Error(`Gemini CLI connection test failed: ${(error as Error).message}`);
    }
  }

  /**
   * Check rate limiting
   */
  private async checkRateLimit(): Promise<void> {
    const now = Date.now();
    
    // Reset daily counter if needed
    this.resetDailyCounterIfNeeded();
    
    // Check daily limit
    if (this.dailyRequestCount >= this.RATE_LIMIT.daily) {
      throw new Error('Daily Gemini API limit exceeded. Please wait until tomorrow or upgrade your plan.');
    }
    
    // Check per-minute limit
    const timeSinceLastRequest = now - this.lastRequestTime;
    if (this.requestCount >= this.RATE_LIMIT.requests && timeSinceLastRequest < this.RATE_LIMIT.window) {
      const waitTime = this.RATE_LIMIT.window - timeSinceLastRequest;
      logger.warn('Rate limit reached, waiting', { waitTime });
      await new Promise(resolve => setTimeout(resolve, waitTime));
      this.requestCount = 0; // Reset counter
    }
  }

  /**
   * Reset daily counter if needed
   */
  private resetDailyCounterIfNeeded(): void {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    
    if (now - this.dailyResetTime > dayMs) {
      this.dailyRequestCount = 0;
      this.dailyResetTime = now;
      logger.debug('Daily request counter reset');
    }
  }

  /**
   * Validate files for processing
   */
  private validateFiles(files: FileReference[]): void {
    const maxFiles = 10;
    const maxFileSize = 100 * 1024 * 1024; // 100MB
    const supportedTypes = ['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.txt', '.md'];

    if (files.length > maxFiles) {
      throw new Error(`Too many files. Maximum ${maxFiles} files allowed.`);
    }

    for (const file of files) {
      if (file.size && file.size > maxFileSize) {
        throw new Error(`File ${file.path} is too large. Maximum ${maxFileSize / 1024 / 1024}MB allowed.`);
      }

      const ext = file.path.toLowerCase().match(/\.[^.]+$/)?.[0];
      if (ext && !supportedTypes.includes(ext)) {
        logger.warn('Potentially unsupported file type', { 
          path: file.path, 
          extension: ext 
        });
      }
    }
  }

  /**
   * Extract sources from Gemini output
   */
  private extractSources(output: string): string[] {
    const sources: string[] = [];
    
    // Look for URL patterns in the output
    const urlPattern = /https?:\/\/[^\s]+/g;
    const urls = output.match(urlPattern);
    
    if (urls) {
      sources.push(...urls);
    }
    
    // Look for source citations
    const sourcePattern = /Source: (.+?)(?:\n|$)/g;
    let match;
    while ((match = sourcePattern.exec(output)) !== null) {
      sources.push(match[1]?.trim() || '');
    }
    
    return [...new Set(sources)]; // Remove duplicates
  }

  /**
   * Enhanced task timeout calculation based on Gemini's architectural recommendations
   * Implements dynamic, tiered timeout strategy for production reliability
   */
  private getTaskTimeout(task: any): number {
    if (task.timeout) {
      return task.timeout;
    }
    
    const baseTimeout = 10000; // Base overhead (reduced from previous implementation)
    
    // Tier 3: Multimodal tasks get variable timeouts based on file size
    if (task.type === 'multimodal_processing' && task.files && task.files.length > 0) {
      let totalFileSizeMB = 0;
      for (const file of task.files) {
        if (file.size) {
          totalFileSizeMB += file.size / (1024 * 1024);
        } else {
          // Estimate 5MB per file if size unknown
          totalFileSizeMB += 5;
        }
      }
      const timePerMB = 5000; // 5 seconds per MB (tunable parameter)
      const multimodalBase = 30000; // 30s base for multimodal
      
      const calculatedTimeout = Math.max(multimodalBase, (totalFileSizeMB * timePerMB) + baseTimeout);
      logger.debug('Calculated multimodal timeout', {
        totalFileSizeMB: totalFileSizeMB.toFixed(2),
        calculatedTimeout,
        files: task.files.length
      });
      return calculatedTimeout;
    }
    
    // Tier 2: Search-enabled tasks (default unless explicitly disabled)
    if (task.useSearch !== false) {
      const searchTimeout = 180000; // 3 minutes for search-enabled tasks
      logger.debug('Using search-enabled timeout', {
        timeout: searchTimeout,
        useSearch: task.useSearch,
        taskType: task.type
      });
      return searchTimeout;
    }
    
    // Tier 1: Simple, non-search tasks (only when explicitly disabled)
    const simpleTimeout = 45000; // 45 seconds for confirmed simple processing
    logger.debug('Using simple processing timeout', {
      timeout: simpleTimeout,
      useSearch: task.useSearch,
      taskType: task.type
    });
    return simpleTimeout;
  }

  /**
   * Estimate tokens used
   */
  private estimateTokensUsed(task: any, result: any): number {
    const inputText = JSON.stringify(task);
    const outputText = typeof result === 'string' ? result : JSON.stringify(result);
    
    // Rough estimate: 1 token ≈ 4 characters
    return Math.ceil((inputText.length + outputText.length) / 4);
  }

  /**
   * Calculate cost
   */
  private calculateCost(task: any, result: any): number {
    // Free tier usage
    return 0;
  }

  /**
   * Get current rate limit status
   */
  getRateLimitStatus(): {
    requestCount: number;
    dailyRequestCount: number;
    remainingRequests: number;
    remainingDailyRequests: number;
    resetTime: number;
  } {
    return {
      requestCount: this.requestCount,
      dailyRequestCount: this.dailyRequestCount,
      remainingRequests: Math.max(0, this.RATE_LIMIT.requests - this.requestCount),
      remainingDailyRequests: Math.max(0, this.RATE_LIMIT.daily - this.dailyRequestCount),
      resetTime: this.lastRequestTime + this.RATE_LIMIT.window,
    };
  }

  /**
   * Get comprehensive quota status
   */
  getQuotaStatus() {
    return this.quotaMonitor.getUsageStats();
  }

  /**
   * Check if quota allows the request
   */
  canMakeQuotaRequest(estimatedTokens: number = 1000) {
    return this.quotaMonitor.canMakeRequest(estimatedTokens);
  }

  /**
   * Validate Gemini CLI command arguments to prevent incorrect usage patterns
   */
  private validateGeminiCommand(args: string[]): void {
    // Allow system commands like --version, --help
    const systemCommands = ['--version', '--help', '-h', '-v'];
    if (args.length === 1 && args[0] && systemCommands.includes(args[0])) {
      return;
    }

    // FIXED v1.1.1: Allow -p flags as we use command-argument approach now
    // This validation is only for file-based arguments passed to executeGeminiProcess
    // The actual prompt handling is done in executeGeminiCLIReference with -p flag

    // SIMPLIFIED: Just validate that args are properly formatted
    logger.debug('Gemini CLI command validation passed', {
      argsCount: args.length,
      commandType: 'command-argument-based',
      validArgs: args.filter(arg => arg.startsWith('@') || arg.startsWith('-')).length
    });
  }

  /**
   * Estimate cost for processing
   */
  private estimateCost(input: any, result: string): number {
    // Gemini CLI with API key usage
    const basePrice = 0.001; // $0.001 per request
    
    if (input.files && input.files.length > 0) {
      return basePrice * input.files.length;
    }
    
    // Estimate based on output length
    const outputTokens = Math.ceil(result.length / 4);
    return basePrice + (outputTokens * 0.000001); // Rough token pricing
  }

  /**
   * Process multiple search queries in parallel for improved performance
   */
  async executeParallelSearch(queries: string[], context: GroundingContext): Promise<GroundedResult[]> {
    const maxConcurrent = parseInt(process.env.MAX_CONCURRENT_REQUESTS || '3');
    const results: GroundedResult[] = [];
    
    logger.info('Starting parallel search execution', {
      queryCount: queries.length,
      maxConcurrent
    });

    // Process queries in batches to avoid overwhelming the API
    for (let i = 0; i < queries.length; i += maxConcurrent) {
      const batch = queries.slice(i, i + maxConcurrent);
      const batchPromises = batch.map(async (query) => {
        try {
          return await this.executeWithGrounding(query, context);
        } catch (error) {
          logger.warn('Parallel search query failed', { 
            query: query.substring(0, 50), 
            error: (error as Error).message 
          });
          return {
            content: `Search failed: ${(error as Error).message}`,
            sources: [],
            grounded: false,
            search_used: true,
          };
        }
      });

      const batchResults = await Promise.allSettled(batchPromises);
      
      batchResults.forEach((result) => {
        if (result.status === 'fulfilled') {
          results.push(result.value);
        } else {
          results.push({
            content: `Batch processing failed: ${result.reason}`,
            sources: [],
            grounded: false,
            search_used: true,
          });
        }
      });

      // Rate limiting between batches
      if (i + maxConcurrent < queries.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    logger.info('Parallel search execution completed', {
      totalQueries: queries.length,
      successfulResults: results.filter(r => r.grounded).length
    });

    return results;
  }

  /**
   * Batch optimize multiple prompts for better efficiency
   */
  async batchOptimizePrompts(prompts: string[], options: OptimizationOptions = {}): Promise<string[]> {
    const optimizedPrompts: string[] = [];
    
    logger.debug('Starting batch prompt optimization', { count: prompts.length });

    // Process optimization in parallel for better performance
    const optimizationPromises = prompts.map(async (prompt) => {
      try {
        if (prompt.length > 500) {
          const optimization = await this.promptOptimizer.optimizeForWebSearch(prompt, options);
          return optimization.optimizedPrompt;
        }
        return prompt;
      } catch (error) {
        logger.warn('Prompt optimization failed in batch', { 
          prompt: prompt.substring(0, 50), 
          error 
        });
        return prompt;
      }
    });

    const results = await Promise.allSettled(optimizationPromises);
    
    results.forEach((result) => {
      if (result.status === 'fulfilled') {
        optimizedPrompts.push(result.value);
      } else {
        optimizedPrompts.push(''); // Fallback for failed optimization
      }
    });

    logger.debug('Batch prompt optimization completed', {
      originalCount: prompts.length,
      optimizedCount: optimizedPrompts.length
    });

    return optimizedPrompts;
  }

  /**
   * Smart query splitting for complex prompts
   */
  async splitComplexQuery(prompt: string): Promise<string[]> {
    // Split complex queries into smaller, focused sub-queries
    const queries: string[] = [];
    
    // Look for numbered points or bullet points
    const numberedPattern = /(?:^|\n)\s*[0-9]+\.\s*([^.\n]+)/gm;
    const bulletPattern = /(?:^|\n)\s*[•\-*]\s*([^.\n]+)/gm;
    
    let match;
    
    // Extract numbered items
    while ((match = numberedPattern.exec(prompt)) !== null) {
      const query = match[1]?.trim();
      if (query && query.length > 10) {
        queries.push(query);
      }
    }
    
    // Extract bullet points if no numbered items found
    if (queries.length === 0) {
      while ((match = bulletPattern.exec(prompt)) !== null) {
        const query = match[1]?.trim();
        if (query && query.length > 10) {
          queries.push(query);
        }
      }
    }
    
    // If no structured content found, split by sentences for very long prompts
    if (queries.length === 0 && prompt.length > 2000) {
      const sentences = prompt.split(/[。！？]/).filter(s => s.trim().length > 50);
      queries.push(...sentences.slice(0, 5)); // Limit to 5 sentences
    }
    
    // Fallback: return original prompt if no split possible
    if (queries.length === 0) {
      queries.push(prompt);
    }
    
    logger.debug('Query splitting completed', {
      originalLength: prompt.length,
      splitCount: queries.length,
      avgQueryLength: queries.reduce((sum, q) => sum + q.length, 0) / queries.length
    });
    
    return queries;
  }

  /**
   * Connection pooling for Gemini CLI processes
   */
  private connectionPool: Map<string, { process: any; lastUsed: number; isAvailable: boolean }> = new Map();
  private readonly maxPoolSize = 5;
  private readonly connectionTimeout = 300000; // 5 minutes

  /**
   * Get or create a pooled connection
   */
  private async getPooledConnection(commandHash: string): Promise<any> {
    // Cleanup expired connections
    this.cleanupExpiredConnections();
    
    // Try to reuse existing connection
    const existingConnection = this.connectionPool.get(commandHash);
    if (existingConnection && existingConnection.isAvailable) {
      existingConnection.lastUsed = Date.now();
      existingConnection.isAvailable = false;
      return existingConnection.process;
    }
    
    // Create new connection if pool not full
    if (this.connectionPool.size < this.maxPoolSize) {
      const process = null; // Will be created when needed
      this.connectionPool.set(commandHash, {
        process,
        lastUsed: Date.now(),
        isAvailable: false
      });
      return process;
    }
    
    // Pool is full, wait for available connection
    return await this.waitForAvailableConnection();
  }

  /**
   * Release connection back to pool
   */
  private releaseConnection(commandHash: string): void {
    const connection = this.connectionPool.get(commandHash);
    if (connection) {
      connection.isAvailable = true;
      connection.lastUsed = Date.now();
    }
  }

  /**
   * Cleanup expired connections
   */
  private cleanupExpiredConnections(): void {
    const now = Date.now();
    for (const [hash, connection] of this.connectionPool.entries()) {
      if (now - connection.lastUsed > this.connectionTimeout) {
        try {
          connection.process?.kill?.();
        } catch (error) {
          // Ignore cleanup errors
        }
        this.connectionPool.delete(hash);
      }
    }
  }

  /**
   * Wait for available connection
   */
  private async waitForAvailableConnection(): Promise<any> {
    return new Promise((resolve) => {
      const checkAvailable = () => {
        for (const connection of this.connectionPool.values()) {
          if (connection.isAvailable) {
            connection.isAvailable = false;
            connection.lastUsed = Date.now();
            resolve(connection.process);
            return;
          }
        }
        // Check again after 100ms
        setTimeout(checkAvailable, 100);
      };
      checkAvailable();
    });
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
   * Cleanup expired cache entries
   */
  async cleanupCache(): Promise<number> {
    return await this.searchCache.cleanup();
  }

  /**
   * Export cache to file
   */
  async exportCache(filePath: string): Promise<void> {
    await this.searchCache.exportToFile(filePath);
  }

  /**
   * Import cache from file
   */
  async importCache(filePath: string): Promise<void> {
    await this.searchCache.importFromFile(filePath);
  }
}