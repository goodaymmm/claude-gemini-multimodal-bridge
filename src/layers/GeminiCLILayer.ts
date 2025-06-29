import { spawn, execSync } from 'child_process';
import { LayerInterface, LayerResult, GroundingContext, GroundedResult, MultimodalResult, FileReference } from '../core/types.js';
import { logger } from '../utils/logger.js';
import { safeExecute, retry } from '../utils/errorHandler.js';
import { AuthVerifier } from '../auth/AuthVerifier.js';
import { OAuthManager } from '../auth/OAuthManager.js';
import { getQuotaMonitor, QuotaMonitor } from '../utils/quotaMonitor.js';

/**
 * GeminiCLILayer handles Gemini CLI integration with enhanced authentication support
 * Provides grounding with Google Search integration and multimodal processing
 */
export class GeminiCLILayer implements LayerInterface {
  private authVerifier: AuthVerifier;
  private oauthManager: OAuthManager;
  private quotaMonitor: QuotaMonitor;
  private geminiPath?: string;
  private isInitialized = false;
  private readonly DEFAULT_TIMEOUT = 60000; // 1 minute
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
        timeout: 30000,
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
        logger.debug('Executing grounded search', {
          promptLength: prompt.length,
          useSearch: context.useSearch,
          searchQuery: context.searchQuery?.substring(0, 50),
        });

        const args = this.buildGeminiCommand(prompt, {
          search: context.useSearch !== false, // Default to true
          files: context.files || [],
          context: context.context || '',
        });

        const output = await this.executeGeminiProcess(args);
        
        return {
          content: output.trim(),
          sources: this.extractSources(output),
          grounded: true,
          search_used: context.useSearch !== false,
        };
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
          files_processed: files.map(f => f.path),
          processing_time: processingTime,
          tokens_used: this.estimateTokensUsed({ files, prompt }, output),
          model_used: 'gemini-2.5-pro',
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

    args.push(finalPrompt);

    return args;
  }

  /**
   * Execute Gemini CLI process
   */
  private async executeGeminiProcess(args: string[]): Promise<string> {
    if (!this.geminiPath) {
      throw new Error('Gemini CLI not initialized');
    }

    // Update rate limiting
    this.requestCount++;
    this.dailyRequestCount++;
    this.lastRequestTime = Date.now();

    return new Promise<string>((resolve, reject) => {
      logger.debug('Executing Gemini CLI command', {
        args: args.length,
        argsPreview: args.slice(0, -1).join(' ') + ' [prompt]',
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
          } else {
            const error = `Gemini CLI exited with code ${code}: ${errorOutput}`;
            logger.error('Gemini CLI command failed', { code, error: errorOutput });
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
      try {
        const simpleArgs = ['Test connection'];
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
    
    return this.getEstimatedDuration(task) + 15000; // Add 15s buffer
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
}