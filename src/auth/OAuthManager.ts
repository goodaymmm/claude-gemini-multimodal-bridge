import { AuthenticationError, AuthErrorCode, AuthStatus } from '../core/types.js';
import { logger } from '../utils/logger.js';
import { safeExecute } from '../utils/errorHandler.js';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { AGY_INSTALL_HINT, findAntigravityBinary, probeAntigravityAuth } from '../utils/antigravityCli.js';

/**
 * OAuthManager handles OAuth flow management and Gemini CLI authentication
 * Supports both OAuth and API key authentication methods
 */
export class OAuthManager {
  private authCache: Map<string, AuthStatus> = new Map();
  private readonly CACHE_TTL = 3600000; // 1 hour in milliseconds

  /**
   * Check Gemini CLI authentication status
   * Simplified to check OAuth file and API key without executing gemini commands
   */
  async checkGeminiAuthentication(): Promise<AuthStatus> {
    return safeExecute(
      async () => {
        // Check cache first
        const cached = this.authCache.get('gemini');
        if (cached && this.isCacheValid('gemini')) {
          return cached;
        }

        // A live `agy models` call is the ONLY proof that the search layer can
        // serve a request.
        //
        // Antigravity keeps its OAuth tokens in the OS keyring. A leftover
        // ~/.gemini/oauth_creds.json or GEMINI_API_KEY says nothing about that
        // session, and on an upgraded machine both are likely to still be
        // present. Accepting them here reported the layer as healthy — cached
        // for hours by AuthVerifier — while every real request failed, which is
        // strictly worse than reporting the truth.
        const binary = await findAntigravityBinary();
        if (!binary) {
          return {
            isAuthenticated: false,
            method: 'oauth',
            userInfo: undefined,
          };
        }

        const probe = await probeAntigravityAuth(binary.path);

        if (probe.authenticated) {
          const status: AuthStatus = {
            isAuthenticated: true,
            method: 'oauth',
            userInfo: {
              planType: 'free',
              email: undefined,
              quotaRemaining: undefined
            }
          };

          this.updateCache('gemini', status);
          return status;
        }

        // Do not cache transient failures: a network blip is not a sign-out, and
        // caching it would keep the layer marked dead long after it recovered.
        if (probe.outcome === 'timeout' || probe.outcome === 'unavailable') {
          logger.warn('Antigravity CLI reachable but the auth probe did not complete', {
            outcome: probe.outcome,
            error: probe.error,
          });
        } else {
          logger.debug('Antigravity CLI is installed but not signed in', { error: probe.error });
        }

        return {
          isAuthenticated: false,
          method: 'oauth',
          userInfo: undefined,
        };
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
          // Guide the user through Antigravity CLI sign-in
          const result = await this.executeGeminiAuth();
          
          if (result) {
            logger.info('OAuth authentication successful');
            
            // Verify authentication worked by checking file
            const status = await this.checkGeminiAuthentication();
            
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
              instructions: 'Run `agy` in a terminal and complete the Google sign-in',
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
   * Simplified to check files and env vars only
   */
  private async detectAuthMethod(): Promise<'oauth' | 'api_key' | 'none'> {
    // Check for OAuth file first
    const oauthFile = path.join(os.homedir(), '.gemini', 'oauth_creds.json');
    if (fs.existsSync(oauthFile)) {
      return 'oauth';
    }
    
    // Check for Gemini-specific API keys
    const geminiApiKey = process.env.GEMINI_API_KEY ??  // Gemini CLI specific
                         process.env.GOOGLE_API_KEY;   // Legacy support
                   
    if (geminiApiKey && geminiApiKey.length > 10) {
      return 'api_key';
    }

    return 'none';
  }

  /**
   * Check API key authentication
   * Only checks Gemini-specific API keys
   */
  private async checkApiKeyAuth(): Promise<AuthStatus> {
    const apiKey = process.env.GEMINI_API_KEY ??  // Gemini CLI specific
                   process.env.GOOGLE_API_KEY;    // Legacy support
    
    if (!apiKey) {
      return {
        isAuthenticated: false,
        method: 'api_key',
        userInfo: undefined,
      };
    }

    // Basic validation - Gemini API keys have different format than AI Studio
    if (apiKey.length < 10) {
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
   * Check OAuth authentication via file existence
   * Removed dependency on gemini command execution
   */
  private async checkOAuthAuth(): Promise<AuthStatus> {
    const oauthFile = path.join(os.homedir(), '.gemini', 'oauth_creds.json');
    
    if (fs.existsSync(oauthFile)) {
      try {
        const creds = JSON.parse(fs.readFileSync(oauthFile, 'utf8'));
        
        if (creds.access_token || creds.refresh_token) {
          return {
            isAuthenticated: true,
            method: 'oauth',
            userInfo: {
              email: undefined,
              quotaRemaining: undefined,
              planType: 'free',
            },
          };
        }
      } catch (error) {
        logger.debug('OAuth credentials file could not be parsed', { error: (error as Error).message });
      }
    }
    
    return {
      isAuthenticated: false,
      method: 'oauth',
      userInfo: undefined,
    };
  }

  /**
   * Guide the user through Antigravity CLI sign-in.
   *
   * The Antigravity CLI has no `auth` subcommand: signing in happens on the
   * first interactive launch, which opens a browser and writes the tokens to the
   * OS keyring. There is nothing to drive non-interactively, so instruct the
   * user and then re-probe.
   */
  private async executeGeminiAuth(): Promise<boolean> {
    const binary = await findAntigravityBinary();

    if (!binary) {
      throw new AuthenticationError(
        `Antigravity CLI (agy) is not installed. Install it with: ${AGY_INSTALL_HINT}`,
        'gemini',
        AuthErrorCode.OAUTH_FLOW_FAILED,
        {
          method: 'oauth',
          instructions: AGY_INSTALL_HINT,
          canRetry: true,
        }
      );
    }

    const probe = await probeAntigravityAuth(binary.path);
    if (probe.authenticated) {
      return true;
    }

    logger.info(
      'Antigravity CLI is installed but not signed in. ' +
      'Run `agy` in a terminal, complete the Google sign-in, then re-run this command.',
      { error: probe.error }
    );

    return false;
  }

  /**
   * Check whether the search-layer CLI is available on this system.
   * Resolves against the Antigravity CLI (`agy`), not the retired Gemini CLI.
   */
  private async checkGeminiCLIAvailable(): Promise<boolean> {
    return (await findAntigravityBinary()) !== undefined;
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
  private isCacheValid(_service: string): boolean {
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