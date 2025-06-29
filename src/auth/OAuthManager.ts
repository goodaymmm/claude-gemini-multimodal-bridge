import { execSync, spawn } from 'child_process';
import { AuthStatus, AuthResult, AuthErrorCode, AuthenticationError, LayerType } from '../core/types.js';
import { logger } from '../utils/logger.js';
import { safeExecute } from '../utils/errorHandler.js';

/**
 * OAuthManager handles OAuth flow management and Gemini CLI authentication
 * Supports both OAuth and API key authentication methods
 */
export class OAuthManager {
  private authCache: Map<string, AuthStatus> = new Map();
  private readonly CACHE_TTL = 3600000; // 1 hour in milliseconds

  /**
   * Check Gemini CLI authentication status
   */
  async checkGeminiAuthentication(): Promise<AuthStatus> {
    return safeExecute(
      async () => {
        // Check cache first
        const cached = this.authCache.get('gemini');
        if (cached && this.isCacheValid('gemini')) {
          return cached;
        }

        // Detect authentication method
        const method = await this.detectAuthMethod();
        
        if (method === 'api_key') {
          return this.checkApiKeyAuth();
        } else if (method === 'oauth') {
          return this.checkOAuthAuth();
        } else {
          return {
            isAuthenticated: false,
            method: 'oauth',
            userInfo: undefined,
          };
        }
      },
      {
        operationName: 'check-gemini-auth',
        layer: 'gemini',
        timeout: 10000,
      }
    );
  }

  /**
   * Prompt user for Gemini login and guide through authentication
   */
  async promptGeminiLogin(): Promise<boolean> {
    return safeExecute(
      async () => {
        logger.info('Prompting Gemini authentication...');
        
        const method = await this.detectAuthMethod();
        
        if (method === 'api_key') {
          logger.info('API key authentication detected. Please ensure GEMINI_API_KEY is set.');
          const status = await this.checkApiKeyAuth();
          return status.isAuthenticated;
        }

        // OAuth flow
        logger.info('Starting OAuth authentication flow...');
        
        try {
          // Spawn gemini auth command
          const result = await this.executeGeminiAuth();
          
          if (result) {
            logger.info('OAuth authentication successful');
            
            // Verify authentication worked
            const status = await this.checkOAuthAuth();
            this.updateCache('gemini', status);
            
            return status.isAuthenticated;
          }
          
          return false;
        } catch (error) {
          logger.error('OAuth authentication failed', { error: (error as Error).message });
          throw new AuthenticationError(
            'OAuth authentication failed. Please try again or use API key method.',
            'gemini',
            AuthErrorCode.OAUTH_FLOW_FAILED,
            {
              method: 'oauth',
              instructions: 'Run "gemini auth" manually or set GEMINI_API_KEY environment variable',
              canRetry: true
            }
          );
        }
      },
      {
        operationName: 'prompt-gemini-login',
        layer: 'gemini',
        timeout: 60000, // OAuth flow can take time
      }
    );
  }

  /**
   * Refresh Gemini token if possible
   */
  async refreshGeminiToken(): Promise<boolean> {
    return safeExecute(
      async () => {
        const method = await this.detectAuthMethod();
        
        if (method === 'api_key') {
          // API keys don't need refresh, just revalidate
          const status = await this.checkApiKeyAuth();
          this.updateCache('gemini', status);
          return status.isAuthenticated;
        }

        // For OAuth, try to refresh by re-authenticating
        logger.info('Attempting to refresh OAuth token...');
        
        try {
          // Clear cache first
          this.authCache.delete('gemini');
          
          // Check if current auth is still valid
          const currentStatus = await this.checkOAuthAuth();
          if (currentStatus.isAuthenticated) {
            this.updateCache('gemini', currentStatus);
            return true;
          }

          // If not valid, prompt for re-authentication
          logger.warn('OAuth token expired, re-authentication required');
          return await this.promptGeminiLogin();
          
        } catch (error) {
          logger.error('Token refresh failed', { error: (error as Error).message });
          return false;
        }
      },
      {
        operationName: 'refresh-gemini-token',
        layer: 'gemini',
        timeout: 30000,
      }
    );
  }

  /**
   * Detect current authentication method (OAuth vs API key)
   */
  private async detectAuthMethod(): Promise<'oauth' | 'api_key' | 'none'> {
    // Check for API key first
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (apiKey && apiKey.length > 10) {
      return 'api_key';
    }

    // Check if gemini CLI is available and authenticated
    try {
      const hasGeminiCLI = await this.checkGeminiCLIAvailable();
      if (hasGeminiCLI) {
        return 'oauth';
      }
    } catch (error) {
      logger.debug('Gemini CLI not available', { error: (error as Error).message });
    }

    return 'none';
  }

  /**
   * Check API key authentication
   */
  private async checkApiKeyAuth(): Promise<AuthStatus> {
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    
    if (!apiKey) {
      return {
        isAuthenticated: false,
        method: 'api_key',
        userInfo: undefined,
      };
    }

    // Validate API key format (basic check)
    if (apiKey.length < 20 || !apiKey.startsWith('AI')) {
      logger.warn('API key format appears invalid');
      return {
        isAuthenticated: false,
        method: 'api_key',
        userInfo: undefined,
      };
    }

    // We can't easily test API key without making a request,
    // so we assume it's valid if format is correct
    return {
      isAuthenticated: true,
      method: 'api_key',
      userInfo: {
        email: undefined,
        quotaRemaining: undefined,
        planType: 'free', // Default assumption
      },
    };
  }

  /**
   * Check OAuth authentication via Gemini CLI
   */
  private async checkOAuthAuth(): Promise<AuthStatus> {
    try {
      // Try a simple gemini command to test authentication
      const output = execSync('gemini --version', { 
        encoding: 'utf8', 
        timeout: 5000,
        stdio: 'pipe'
      });

      if (output && !output.toLowerCase().includes('error')) {
        return {
          isAuthenticated: true,
          method: 'oauth',
          userInfo: {
            email: undefined, // Could be extracted from gemini CLI if available
            quotaRemaining: undefined,
            planType: 'free',
          },
        };
      }

      return {
        isAuthenticated: false,
        method: 'oauth',
        userInfo: undefined,
      };
      
    } catch (error) {
      logger.debug('OAuth authentication check failed', { error: (error as Error).message });
      return {
        isAuthenticated: false,
        method: 'oauth',
        userInfo: undefined,
      };
    }
  }

  /**
   * Execute gemini auth command
   */
  private async executeGeminiAuth(): Promise<boolean> {
    return new Promise((resolve, reject) => {
      logger.info('Executing: gemini auth');
      
      const child = spawn('gemini', ['auth'], {
        stdio: 'inherit', // Allow user interaction
      });

      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('Authentication timeout'));
      }, 120000); // 2 minutes timeout

      child.on('close', (code) => {
        clearTimeout(timeout);
        
        if (code === 0) {
          resolve(true);
        } else {
          reject(new Error(`Authentication failed with exit code: ${code}`));
        }
      });

      child.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  /**
   * Check if Gemini CLI is available on system
   */
  private async checkGeminiCLIAvailable(): Promise<boolean> {
    try {
      execSync('which gemini', { stdio: 'ignore' });
      return true;
    } catch {
      try {
        execSync('gemini --version', { stdio: 'ignore' });
        return true;
      } catch {
        return false;
      }
    }
  }

  /**
   * Update authentication cache
   */
  private updateCache(service: string, status: AuthStatus): void {
    this.authCache.set(service, {
      ...status,
      // Add timestamp for cache invalidation
    });
  }

  /**
   * Check if cached auth status is still valid
   */
  private isCacheValid(service: string): boolean {
    // For now, always revalidate to ensure accuracy
    // In the future, could implement TTL-based caching
    return false;
  }

  /**
   * Clear authentication cache
   */
  clearCache(): void {
    this.authCache.clear();
    logger.debug('Authentication cache cleared');
  }

  /**
   * Get authentication method for a service
   */
  async getAuthMethod(service: 'gemini' | 'aistudio' | 'claude'): Promise<string> {
    if (service === 'gemini' || service === 'aistudio') {
      return await this.detectAuthMethod();
    }
    
    if (service === 'claude') {
      // Claude Code typically uses session-based auth
      return 'session';
    }
    
    return 'none';
  }

  /**
   * Validate API key format
   */
  validateApiKey(apiKey: string): boolean {
    if (!apiKey || typeof apiKey !== 'string') {
      return false;
    }

    // Basic validation for Google AI API keys
    return apiKey.length >= 20 && apiKey.startsWith('AI');
  }

  /**
   * Mask API key for logging
   */
  maskApiKey(apiKey: string): string {
    if (!apiKey || apiKey.length < 8) {
      return '***';
    }
    return apiKey.substring(0, 8) + '***';
  }
}