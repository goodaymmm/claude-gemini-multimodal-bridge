import { spawn } from 'child_process';
import { FileReference, GroundedResult, GroundingContext, LayerInterface, LayerResult, MultimodalResult } from '../core/types.js';
import { logger } from '../utils/logger.js';
import { safeExecute } from '../utils/errorHandler.js';
import { AuthVerifier } from '../auth/AuthVerifier.js';
import { SearchCache } from '../utils/SearchCache.js';

/**
 * Task interface for better type safety
 */
interface GeminiTask {
  type?: string;
  action?: string;
  prompt?: string;
  request?: string;
  input?: string;
  useSearch?: boolean;
  needsGrounding?: boolean;
  files?: FileReference[];
  model?: string;
  [key: string]: unknown;
}

/**
 * GeminiCLILayer - Simplified wrapper implementation based on mcp-gemini-cli
 * Focuses on high-speed search and real-time information processing
 * Optimized for enterprise-level reliability with intelligent caching
 */
export class GeminiCLILayer implements LayerInterface {
  private authVerifier: AuthVerifier;
  private searchCache: SearchCache;
  private geminiPath: string = 'gemini';
  private isInitialized = false;

  // Optimized settings for enterprise reliability
  private readonly DEFAULT_TIMEOUT = 60000; // 60 seconds (extended for quota/network issues)
  private readonly DEFAULT_MODEL = 'gemini-2.5-pro';

  constructor() {
    this.authVerifier = new AuthVerifier();
    
    // Initialize search cache for performance optimization (CGMB unique value)
    this.searchCache = new SearchCache({
      ttl: parseInt(process.env.CACHE_TTL || '1800000'), // 30 minutes
      maxEntries: parseInt(process.env.MAX_CACHE_ENTRIES || '1000'),
      enableMetrics: process.env.ENABLE_CACHING === 'true',
      similarityThreshold: 0.8
    });
  }

  /**
   * Initialize the Gemini CLI layer with minimal overhead
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    return safeExecute(
      async () => {
        logger.info('Initializing Gemini CLI layer (simplified)...');

        // Verify authentication using enhanced caching
        const authResult = await this.authVerifier.verifyGeminiAuth();
        if (!authResult.success) {
          throw new Error(`Gemini CLI authentication failed: ${authResult.error}`);
        }

        // Find Gemini CLI path
        this.geminiPath = await this.findGeminiPath() || 'gemini';

        this.isInitialized = true;
        logger.info('Gemini CLI layer initialized successfully', {
          geminiPath: this.geminiPath,
          authenticated: authResult.success,
          authMethod: authResult.status?.method || 'unknown',
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
  canHandle(task: GeminiTask): boolean {
    if (!task || typeof task !== 'object') {
      return false;
    }

    // Gemini CLI specializes in:
    // - Search and current information
    // - Simple text processing
    // - Real-time queries
    return !!(
      task.type === 'search' ||
      task.type === 'grounding' ||
      task.action === 'grounded_search' ||
      task.useSearch !== false || // Default to search-enabled
      task.needsGrounding ||
      (task.type === 'gemini' && !task.files) || // Text-only Gemini tasks
      task.type === 'text_processing'
    );
  }

  /**
   * Main execution method - simplified and optimized
   * Based on mcp-gemini-cli reference implementation with CGMB enhancements
   */
  async execute(task: GeminiTask): Promise<LayerResult> {
    const startTime = Date.now();
    
    // Ensure initialization
    if (!this.isInitialized) {
      await this.initialize();
    }

    return safeExecute(
      async () => {
        logger.info('Executing Gemini CLI task', {
          taskType: task.type || 'general',
          useSearch: task.useSearch !== false, // Log effective search setting
          hasFiles: !!(task.files && task.files.length > 0),
          promptLength: task.prompt?.length || 0,
        });

        const prompt = this.extractPrompt(task);
        if (!prompt.trim()) {
          throw new Error('No prompt provided for Gemini CLI execution');
        }

        // Check cache for search-enabled tasks (CGMB unique feature)
        if (task.useSearch !== false) {
          const cachedResult = await this.searchCache.get(prompt, 'gemini');
          if (cachedResult) {
            logger.debug('Cache hit for Gemini search', {
              promptLength: prompt.length,
              cacheAge: Date.now() - cachedResult.timestamp
            });
            
            return {
              success: true,
              data: cachedResult.content,
              metadata: {
                layer: 'gemini' as const,
                duration: Date.now() - startTime,
                cache_hit: true,
                model: task.model || this.DEFAULT_MODEL,
              }
            };
          }
        }

        // Execute via Gemini CLI (mcp-gemini-cli style)
        const result = await this.executeGeminiCLI(prompt, {
          model: task.model || this.DEFAULT_MODEL
        });

        const duration = Date.now() - startTime;

        // Cache search results (CGMB enhancement)
        if (task.useSearch !== false && result.trim()) {
          await this.searchCache.set(prompt, {
            content: result,
            sources: this.extractSources(result),
            grounded: true,
            search_used: true,
            timestamp: Date.now()
          }, 'gemini', duration);
        }

        return {
          success: true,
          data: result,
          metadata: {
            layer: 'gemini' as const,
            duration,
            cache_hit: false,
            model: task.model || this.DEFAULT_MODEL,
            search_enabled: task.useSearch !== false,
          }
        };
      },
      {
        operationName: 'execute-gemini-cli-task',
        layer: 'gemini',
        timeout: this.DEFAULT_TIMEOUT,
      }
    );
  }

  /**
   * Execute with grounding (simplified for search tasks)
   */
  async executeWithGrounding(prompt: string, context: GroundingContext): Promise<GroundedResult> {
    const task: GeminiTask = {
      type: 'grounding',
      prompt,
      useSearch: context.useSearch !== false,
    };

    const result = await this.execute(task);
    
    return {
      content: result.data as string,
      sources: this.extractSources(result.data as string),
      grounded: true,
      search_used: context.useSearch !== false,
    };
  }

  /**
   * Process files (basic support for text files)
   */
  async processFiles(files: FileReference[], prompt: string): Promise<MultimodalResult> {
    // Gemini CLI has limited file support - focus on text processing
    const textFiles = files.filter(f => f.type === 'text' || f.path.endsWith('.txt') || f.path.endsWith('.md'));
    
    if (textFiles.length === 0) {
      throw new Error('Gemini CLI layer only supports text files. Use AI Studio layer for other file types.');
    }

    logger.debug('Processing text files with Gemini CLI', {
      fileCount: textFiles.length,
      promptLength: prompt.length,
    });

    const result = await this.execute({
      type: 'multimodal',
      prompt,
      files: textFiles,
    });

    return {
      content: result.data as string,
      success: true,
      files_processed: textFiles.map(f => f.path),
      processing_time: result.metadata?.duration || 0,
      workflow_used: 'analysis' as const,
      layers_involved: ['gemini'] as const,
      metadata: {
        total_duration: result.metadata?.duration || 0,
        ...result.metadata,
      },
    };
  }

  /**
   * Get layer capabilities
   */
  getCapabilities(): string[] {
    return [
      'real_time_search',
      'web_grounding',
      'current_information',
      'text_processing',
      'simple_analysis',
      'search_integration',
    ];
  }

  /**
   * Get cost estimation (free tier)
   */
  getCost(task: GeminiTask): number {
    return 0; // Free tier usage
  }

  /**
   * Get estimated duration
   */
  getEstimatedDuration(task: GeminiTask): number {
    const baseTime = 3000; // 3 seconds base
    
    if (task.useSearch !== false) {
      return baseTime + 5000; // +5s for search
    }
    
    return baseTime;
  }

  /**
   * Core Gemini CLI execution - mcp-gemini-cli style with error enhancements
   */
  private async executeGeminiCLI(prompt: string, options: { model?: string } = {}): Promise<string> {
    const args = ['-p', prompt];
    
    if (options.model && options.model !== this.DEFAULT_MODEL) {
      args.push('-m', options.model);
    }

    return new Promise<string>((resolve, reject) => {
      logger.debug('Executing Gemini CLI', {
        command: this.geminiPath,
        args,
        promptLength: prompt.length
      });

      const child = spawn(this.geminiPath, args, { 
        stdio: ['ignore', 'pipe', 'pipe'] 
      });
      
      let stdout = '';
      let stderr = '';
      
      child.stdout?.on('data', (data) => {
        stdout += data.toString();
      });
      
      child.stderr?.on('data', (data) => {
        const chunk = data.toString();
        stderr += chunk;
        
        // Early quota error detection
        if (chunk.includes('429') || chunk.includes('quota') || chunk.includes('Quota exceeded')) {
          logger.warn('Quota limit detected in Gemini CLI service', { 
            error: chunk.substring(0, 200) 
          });
          child.kill();
          reject(new Error(`Gemini CLI quota exceeded (different from Gemini API quota). This is a Gemini CLI service limitation. Please wait or try using AI Studio layer instead. Details: ${chunk.substring(0, 300)}`));
          return;
        }
      });
      
      child.on('close', (code) => {
        logger.debug('Gemini CLI process closed', {
          code,
          stdoutLength: stdout.length,
          stderrLength: stderr.length,
        });
        
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          // Enhanced error handling for common issues
          if (stderr.includes('function response parts') || stderr.includes('function call parts')) {
            reject(new Error(`Gemini CLI authentication error. Try:\n1. gemini auth (OAuth - recommended)\n2. Check API key configuration\n\nOriginal error: ${stderr}`));
          } else if (stderr.includes('UNAUTHENTICATED') || stderr.includes('API_KEY')) {
            reject(new Error(`Authentication failed. Try: gemini auth\n${stderr}`));
          } else if (stderr.includes('quota') || stderr.includes('limit')) {
            reject(new Error(`Quota/rate limit exceeded: ${stderr}`));
          } else {
            reject(new Error(`Gemini CLI failed (code ${code}): ${stderr || 'Unknown error'}`));
          }
        }
      });
      
      child.on('error', (err) => {
        reject(new Error(`Gemini CLI spawn error: ${err.message}`));
      });
      
      // Set timeout with graceful termination
      const timeout = setTimeout(() => {
        logger.warn('Gemini CLI timeout reached, terminating process', {
          timeoutMs: this.DEFAULT_TIMEOUT,
          promptLength: prompt.length
        });
        
        // Try graceful termination first
        child.kill('SIGTERM');
        
        // Force kill after 2 seconds if still running
        setTimeout(() => {
          if (!child.killed) {
            child.kill('SIGKILL');
          }
        }, 2000);
        
        reject(new Error(`Gemini CLI timeout after ${this.DEFAULT_TIMEOUT / 1000}s. This may be due to quota limits or network issues.`));
      }, this.DEFAULT_TIMEOUT);
      
      child.on('close', () => clearTimeout(timeout));
    });
  }

  /**
   * Extract prompt from task (unified method)
   */
  private extractPrompt(task: GeminiTask): string {
    return task.prompt || task.request || task.input || '';
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
        const { execSync } = await import('child_process');
        execSync(`${path} --version`, { stdio: 'ignore', timeout: 5000 });
        logger.debug('Found Gemini CLI at', { path });
        return path;
      } catch {
        continue;
      }
    }

    return undefined;
  }

  /**
   * Extract sources from Gemini output
   */
  private extractSources(output: string): string[] {
    const sources: string[] = [];
    
    // Look for URL patterns
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
   * Translate text to English for image generation
   * Uses Gemini CLI for efficient token usage and cost optimization
   */
  async translateToEnglish(text: string, sourceLang: string): Promise<string> {
    const languageNames: Record<string, string> = {
      ja: 'Japanese',
      ko: 'Korean', 
      zh: 'Chinese',
      fr: 'French',
      de: 'German',
      es: 'Spanish',
      ru: 'Russian',
      ar: 'Arabic',
      hi: 'Hindi',
      th: 'Thai'
    };

    const languageName = languageNames[sourceLang] || sourceLang;
    
    // Optimized translation prompt for image generation
    const translationPrompt = `Translate the following ${languageName} text to English. Keep the meaning and descriptive details, but make it suitable for image generation. Only return the English translation, nothing else:

${text}`;

    logger.info(`Translating ${languageName} prompt to English using Gemini CLI`, {
      originalText: text,
      sourceLang,
      languageName
    });

    try {
      const result = await this.execute({
        type: 'translation',
        prompt: translationPrompt,
        useSearch: false, // No web search needed for translation
        model: 'gemini-2.0-flash-exp' // Fast model for translation
      });

      if (!result.success || !result.data) {
        throw new Error('Translation failed: No result returned');
      }

      const translatedText = result.data.trim();
      
      logger.info('Translation completed successfully', {
        originalText: text,
        translatedText,
        sourceLang,
        duration: result.metadata?.duration || 0
      });

      return translatedText;

    } catch (error) {
      logger.error('Translation failed, using original text', {
        error: error instanceof Error ? error.message : String(error),
        originalText: text,
        sourceLang
      });
      
      // Fallback to original text if translation fails
      return text;
    }
  }
}