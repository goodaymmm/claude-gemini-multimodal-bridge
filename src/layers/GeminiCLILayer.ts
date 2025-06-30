import { execSync, spawn } from 'child_process';
import { FileReference, GroundedResult, GroundingContext, LayerInterface, LayerResult, MultimodalResult } from '../core/types.js';
import { logger } from '../utils/logger.js';
import { retry, safeExecute } from '../utils/errorHandler.js';
import { AuthVerifier } from '../auth/AuthVerifier.js';
import { OAuthManager } from '../auth/OAuthManager.js';
import { getQuotaMonitor, QuotaMonitor } from '../utils/quotaMonitor.js';
import { PromptOptimizer, OptimizationOptions } from '../utils/PromptOptimizer.js';
import { SearchCache, CacheOptions } from '../utils/SearchCache.js';

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
  private readonly DEFAULT_TIMEOUT = 120000; // 2 minutes
  private readonly MAX_RETRIES = 2;
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
  canHandle(task: any): boolean {
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
   * Execute a task through Gemini CLI
   */
  async execute(task: any): Promise<LayerResult> {
    return safeExecute(
      async () => {
        const startTime = Date.now();
        
        if (!this.isInitialized) {
          await this.initialize();
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

        logger.info('Executing Gemini CLI task', {
          taskType: task.type || 'general',
          action: task.action || 'execute',
          useSearch: task.useSearch || false,
        });

        let result: any;

        // Route to appropriate execution method based on task type/action
        switch (task.action || task.type) {
          case 'grounded_search':
            result = await this.executeWithGrounding(task.prompt || task.request, task);
            break;
          case 'contextual_analysis':
            result = await this.executeContextualAnalysis(task);
            break;
          case 'multimodal':
            result = await this.processFiles(task.files, task.prompt || task.request);
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

        const args = this.buildGeminiCommand(optimizedPrompt, {
          search: context.useSearch !== false, // Default to true
          files: context.files || [],
          context: context.context || '',
        });

        const output = await this.executeGeminiProcess(args);
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

        const args = this.buildGeminiCommand(prompt, {
          files: files.map(f => f.path),
        });

        const startTime = Date.now();
        const output = await this.executeGeminiProcess(args);
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
   * Execute contextual analysis
   */
  async executeContextualAnalysis(task: any): Promise<string> {
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

        const args = this.buildGeminiCommand(prompt, {
          search: task.useSearch,
        });

        const output = await this.executeGeminiProcess(args);
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
  getCost(task: any): number {
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
   * Execute general Gemini task
   */
  private async executeGeneral(task: any): Promise<string> {
    const prompt = task.prompt || task.request || task.input || 'Please help with this task.';
    
    const args = this.buildGeminiCommand(prompt, {
      search: task.useSearch,
      files: task.files,
    });

    return await this.executeGeminiProcess(args);
  }

  /**
   * Build Gemini CLI command arguments
   */
  private buildGeminiCommand(prompt: string, options: {
    search?: boolean;
    files?: string[];
    context?: string;
  } = {}): string[] {
    const args: string[] = [];

    // Add search flag if enabled
    if (options.search) {
      args.push('--search');
    }

    // Add files if provided
    if (options.files && options.files.length > 0) {
      options.files.forEach(file => {
        args.push(`@${file}`);
      });
    }

    // Build final prompt
    let finalPrompt = prompt;
    if (options.context) {
      finalPrompt += `\n\nAdditional context: ${options.context}`;
    }

    // Use -p option for better token efficiency and stability
    // This prevents issues with long prompts being passed as arguments
    // Both -p and --prompt should work, but -p is shorter and more reliable
    args.push('-p', finalPrompt);

    logger.debug('Built Gemini command arguments', {
      argsCount: args.length,
      hasPromptFlag: args.includes('-p'),
      promptLength: finalPrompt.length,
      command: `gemini ${args.join(' ').substring(0, 100)}...`
    });

    return args;
  }

  /**
   * Execute Gemini CLI process
   */
  private async executeGeminiProcess(args: string[]): Promise<string> {
    if (!this.geminiPath) {
      throw new Error('Gemini CLI not initialized');
    }

    // CRITICAL: Validate command arguments to prevent incorrect usage
    this.validateGeminiCommand(args);

    // Update rate limiting
    this.requestCount++;
    this.dailyRequestCount++;
    this.lastRequestTime = Date.now();

    return new Promise<string>((resolve, reject) => {
      logger.debug('Executing Gemini CLI command', {
        geminiPath: this.geminiPath,
        args: args.length,
        argsPreview: args.slice(0, -1).join(' ') + ' [prompt]',
        fullCommand: `${this.geminiPath} ${args.slice(0, -1).join(' ')} -p "[PROMPT]"`
      });

      const child = spawn(this.geminiPath!, args, {
        stdio: 'pipe',
        cwd: process.cwd(),
        env: process.env,
      });

      let output = '';
      let errorOutput = '';

      const timeoutId = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`Gemini CLI execution timeout after ${this.DEFAULT_TIMEOUT}ms`));
      }, this.DEFAULT_TIMEOUT);

      child.stdout.on('data', (data) => {
        output += data.toString();
      });

      child.stderr.on('data', (data) => {
        errorOutput += data.toString();
      });

      child.on('close', (code) => {
        clearTimeout(timeoutId);
        
        if (code === 0) {
          logger.debug('Gemini CLI command completed successfully', {
            outputLength: output.length,
            code,
          });
          resolve(output);
        } else {
          // Handle specific error cases
          if (errorOutput.includes('authentication') || errorOutput.includes('login')) {
            reject(new Error('Gemini authentication expired. Please run: gemini auth'));
          } else if (errorOutput.includes('quota') || errorOutput.includes('rate limit')) {
            reject(new Error('Gemini API quota exceeded. Please wait or upgrade plan.'));
          } else if (errorOutput.includes('Unknown argument') || errorOutput.includes('Options:')) {
            // Handle argument parsing errors - likely prompt not passed with -p flag
            logger.error('Gemini CLI argument error detected', {
              command: `${this.geminiPath} ${args.join(' ')}`,
              errorOutput,
              suggestedFix: 'Ensure prompt is passed with -p flag'
            });
            reject(new Error(`Gemini CLI argument error: Prompt must be passed with -p flag. Error: ${errorOutput}`));
          } else {
            const error = `Gemini CLI exited with code ${code}: ${errorOutput}`;
            logger.error('Gemini CLI command failed', { 
              code, 
              error: errorOutput,
              command: `${this.geminiPath} ${args.slice(0, -1).join(' ')} -p "[PROMPT]"`
            });
            reject(new Error(error));
          }
        }
      });

      child.on('error', (error) => {
        clearTimeout(timeoutId);
        logger.error('Gemini CLI process error', { error: error.message });
        reject(error);
      });
    });
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
      const testArgs = ['--version'];
      const testResult = await this.executeGeminiProcess(testArgs);
      
      if (!testResult) {
        throw new Error('No response from Gemini CLI');
      }
      
      logger.debug('Gemini CLI connection test successful', {
        version: testResult.trim(),
      });
    } catch (error) {
      // Don't fail on version command issues - try a simple query instead
      // CRITICAL FIX: Use buildGeminiCommand() instead of direct argument passing
      try {
        const simpleArgs = this.buildGeminiCommand('Test connection');
        await this.executeGeminiProcess(simpleArgs);
        logger.debug('Gemini CLI connection test successful (via simple query)');
      } catch (testError) {
        throw new Error(`Gemini CLI connection test failed: ${(testError as Error).message}`);
      }
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
   * Get task timeout
   */
  private getTaskTimeout(task: any): number {
    if (task.timeout) {
      return task.timeout;
    }
    
    // WebSearch tasks get extended timeout
    if (task.useSearch || task.action?.includes('search') || task.prompt?.toLowerCase().includes('search')) {
      return Math.max(180000, this.getEstimatedDuration(task) + 30000); // Minimum 3 minutes for search
    }
    
    return Math.max(90000, this.getEstimatedDuration(task) + 15000); // Minimum 90s for other tasks
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

    // Check for common incorrect patterns that caused the Error.md issue
    const hasPromptFlag = args.includes('-p') || args.includes('--prompt');
    const hasQuotedLongText = args.some(arg => 
      arg && arg.length > 50 && !arg.startsWith('-') && !arg.startsWith('@')
    );

    // CRITICAL: Detect the exact error pattern from Error.md (line 3)
    // Where long prompts were passed as direct arguments without -p flag
    if (hasQuotedLongText && !hasPromptFlag) {
      const longArg = args.find(arg => arg && arg.length > 50 && !arg.startsWith('-') && !arg.startsWith('@'));
      logger.error('Invalid Gemini CLI usage detected', {
        issue: 'Long prompt passed as direct argument instead of using -p flag',
        problematicArg: longArg ? longArg.substring(0, 100) + '...' : 'unknown',
        correctUsage: 'Use buildGeminiCommand() or pass prompt with -p flag',
        errorPattern: 'This matches the Error.md line 3 issue'
      });
      
      throw new Error(
        'Invalid Gemini CLI command: Long prompts must be passed with -p flag. ' +
        'Use buildGeminiCommand() method instead of direct arguments. ' +
        'This prevents the waste of API calls seen in Error.md line 3.'
      );
    }

    // Additional validation: Ensure prompts use proper flags
    if (!hasPromptFlag && args.length > 0 && args[0] && !args[0].startsWith('-') && !args[0].startsWith('@')) {
      // This might be a direct prompt argument
      const potentialPrompt = args[0];
      if (potentialPrompt && potentialPrompt.length > 20) { // Likely a prompt, not a command
        logger.warn('Potential incorrect Gemini CLI usage', {
          firstArg: potentialPrompt.substring(0, 50) + '...',
          suggestion: 'Use -p flag for prompts'
        });
      }
    }

    logger.debug('Gemini CLI command validation passed', {
      argsCount: args.length,
      hasPromptFlag,
      commandType: hasPromptFlag ? 'prompt-with-flag' : 'system-command'
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