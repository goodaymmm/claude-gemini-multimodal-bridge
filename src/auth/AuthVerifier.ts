import { commandExists } from '../utils/platformUtils.js';
import { execSync } from 'child_process';
import { AuthResult, VerificationResult } from '../core/types.js';
import { logger } from '../utils/logger.js';
import { safeExecute } from '../utils/errorHandler.js';
import { OAuthManager } from './OAuthManager.js';
import { AuthCache } from './AuthCache.js';

/**
 * AuthVerifier handles authentication verification for all services
 * Provides clear error messages and guidance for authentication failures
 * Enhanced with intelligent caching for optimal performance
 */
export class AuthVerifier {
  private oauthManager: OAuthManager;
  private authCache: AuthCache;

  constructor() {
    this.oauthManager = new OAuthManager();
    this.authCache = AuthCache.getInstance();
    
    // Setup periodic cache cleanup (every 30 minutes)
    setInterval(() => {
      this.authCache.cleanup();
    }, 30 * 60 * 1000);
  }

  /**
   * Verify all service authentications
   */
  async verifyAllAuthentications(): Promise<VerificationResult> {
    return safeExecute(
      async () => {
        logger.info('Starting comprehensive authentication verification...');

        const services = {
          gemini: await this.verifyGeminiAuth(),
          aistudio: await this.verifyAIStudioAuth(),
          claude: await this.verifyClaudeCodeAuth(),
        };

        const overall = Object.values(services).every(result => result.success);
        const recommendations = this.generateRecommendations(services);

        logger.info('Authentication verification completed', {
          overall,
          servicesVerified: Object.keys(services).length,
          successCount: Object.values(services).filter(r => r.success).length,
        });

        return {
          overall,
          services,
          recommendations,
        };
      },
      {
        operationName: 'verify-all-auth',
        layer: 'claude',
        timeout: 30000,
      }
    );
  }

  /**
   * Verify Gemini authentication with intelligent caching
   * Prioritizes OAuth authentication over API key with 6-hour cache
   */
  async verifyGeminiAuth(): Promise<AuthResult> {
    // Check cache first
    const cachedResult = this.authCache.get('gemini');
    if (cachedResult) {
      return cachedResult;
    }

    return safeExecute(
      async () => {
        logger.info('Verifying Gemini authentication (no cache)...');

        try {
          // Priority 1: OAuth authentication (recommended)
          const oauthStatus = await this.oauthManager.checkGeminiAuthentication();
          
          if (oauthStatus.isAuthenticated) {
            const result: AuthResult = {
              success: true,
              status: oauthStatus,
              requiresAction: false,
            };
            
            // Cache successful OAuth authentication
            this.authCache.set('gemini', result);
            return result;
          }

          // Priority 2: API Key fallback
          const apiKey = process.env.GEMINI_API_KEY;
          if (apiKey) {
            logger.debug('OAuth failed, trying API Key fallback for Gemini');
            
            // Test API key validity with a simple request
            try {
              await this.testGeminiApiKey(apiKey);
              
              const result: AuthResult = {
                success: true,
                status: {
                  isAuthenticated: true,
                  method: 'api_key',
                  userInfo: undefined,
                },
                requiresAction: false,
              };
              
              // Cache successful API key authentication
              this.authCache.set('gemini', result);
              return result;
            } catch (apiError) {
              logger.warn('Gemini API key validation failed', { error: (apiError as Error).message });
            }
          }

          // No valid authentication found
          const result: AuthResult = {
            success: false,
            status: {
              isAuthenticated: false,
              method: 'oauth',
              userInfo: undefined,
            },
            error: 'Gemini not authenticated',
            requiresAction: true,
            actionInstructions: 'Run "gemini auth" for OAuth (recommended) or set GEMINI_API_KEY environment variable',
          };
          
          // Cache failed authentication with exponential backoff
          this.authCache.set('gemini', result);
          
          // Add failure info to error message
          const failureInfo = this.authCache.getFailureInfo('gemini');
          if (failureInfo?.nextRetryTime) {
            result.error += ` (Failure #${failureInfo.count}, retry after ${failureInfo.nextRetryTime.toLocaleTimeString()})`;
          }
          
          return result;
          
        } catch (error) {
          logger.error('Gemini authentication verification failed', { error: (error as Error).message });
          
          const result: AuthResult = {
            success: false,
            status: {
              isAuthenticated: false,
              method: 'oauth',
              userInfo: undefined,
            },
            error: `Gemini verification failed: ${(error as Error).message}`,
            requiresAction: true,
            actionInstructions: 'Install Gemini CLI: npm install -g @google/gemini-cli && gemini auth',
          };
          
          return result;
        }
      },
      {
        operationName: 'verify-gemini-auth',
        layer: 'gemini',
        timeout: 10000,
      }
    );
  }

  /**
   * Verify AI Studio authentication with intelligent caching
   * Enhanced to address authentication issues from Error.md with 24-hour cache
   */
  async verifyAIStudioAuth(): Promise<AuthResult> {
    // Check cache first (24-hour TTL for API keys)
    const cachedResult = this.authCache.get('aistudio');
    if (cachedResult) {
      return cachedResult;
    }

    return safeExecute(
      async () => {
        logger.info('Verifying AI Studio authentication (no cache)...');

        // Enhanced environment variable resolution with priority order
        const preferredKey = process.env.AI_STUDIO_API_KEY;
        const fallback1 = process.env.GOOGLE_AI_STUDIO_API_KEY;
        const fallback2 = process.env.GEMINI_API_KEY; // Deprecated
        
        const apiKey = preferredKey ?? fallback1 ?? fallback2;
        
        // Enhanced logging for debugging authentication chain
        logger.debug('AI Studio authentication verification', {
          hasPreferredKey: !!preferredKey,
          hasFallback1: !!fallback1,
          hasFallback2: !!fallback2,
          selectedKey: apiKey ? `${apiKey.substring(0, 8)}...` : 'none',
          searchOrder: ['AI_STUDIO_API_KEY', 'GOOGLE_AI_STUDIO_API_KEY', 'GEMINI_API_KEY'],
          errorReference: 'Addressing authentication issues from Error.md lines 70-86'
        });

        // Enhanced deprecation warnings with specific guidance
        if (!preferredKey && fallback2) {
          logger.warn('GEMINI_API_KEY is deprecated for AI Studio. Please use AI_STUDIO_API_KEY instead.', {
            currentVar: 'GEMINI_API_KEY',
            recommendedVar: 'AI_STUDIO_API_KEY',
            migration: 'Update your .env file: GEMINI_API_KEY → AI_STUDIO_API_KEY',
            reason: 'GEMINI_API_KEY is ambiguous - used for both Gemini CLI and AI Studio'
          });
        }
        
        if (!preferredKey && fallback1) {
          logger.warn('GOOGLE_AI_STUDIO_API_KEY is deprecated. Please use AI_STUDIO_API_KEY instead.', {
            currentVar: 'GOOGLE_AI_STUDIO_API_KEY',
            recommendedVar: 'AI_STUDIO_API_KEY',
            migration: 'Update your .env file: GOOGLE_AI_STUDIO_API_KEY → AI_STUDIO_API_KEY'
          });
        }
        
        if (!apiKey) {
          logger.error('AI Studio API key missing - this causes the authentication failure seen in Error.md', {
            issue: 'No API key found in any environment variable',
            searchedVars: ['AI_STUDIO_API_KEY', 'GOOGLE_AI_STUDIO_API_KEY', 'GEMINI_API_KEY'],
            errorContext: 'This is the root cause of AI Studio authentication failures',
            setupUrl: 'https://aistudio.google.com/app/apikey'
          });
          
          const result: AuthResult = {
            success: false,
            status: {
              isAuthenticated: false,
              method: 'api_key',
              userInfo: undefined,
            },
            error: 'AI Studio API key not found. This causes authentication failures as seen in Error.md.',
            requiresAction: true,
            actionInstructions: 'Set AI_STUDIO_API_KEY environment variable with your AI Studio API key. Get it from: https://aistudio.google.com/app/apikey',
          };
          
          // Cache failed authentication with exponential backoff
          this.authCache.set('aistudio', result);
          
          // Add failure info to error message
          const failureInfo = this.authCache.getFailureInfo('aistudio');
          if (failureInfo?.nextRetryTime) {
            result.error += ` (Failure #${failureInfo.count}, retry after ${failureInfo.nextRetryTime.toLocaleTimeString()})`;
          }
          
          return result;
        }

        // Enhanced API key format validation
        if (!this.validateAIStudioApiKeyFormat(apiKey)) {
          logger.error('Invalid AI Studio API key format detected', {
            keyPrefix: apiKey.substring(0, 8),
            keyLength: apiKey.length,
            expectedFormat: 'Should start with "AI" and be at least 20 characters',
            currentFormat: `Starts with "${apiKey.substring(0, 2)}", length: ${apiKey.length}`,
            troubleshooting: 'Verify the key was copied correctly from AI Studio'
          });
          
          return {
            success: false,
            status: {
              isAuthenticated: false,
              method: 'api_key',
              userInfo: undefined,
            },
            error: 'Invalid AI Studio API key format. Expected format: starts with "AI", minimum 20 characters.',
            requiresAction: true,
            actionInstructions: 'Verify your API key from https://aistudio.google.com/app/apikey and update AI_STUDIO_API_KEY in your .env file',
          };
        }

        // MCP server check removed - using built-in MCP server (src/mcp-servers/ai-studio-mcp-server.ts)
        logger.info('AI Studio authentication verification successful', {
          method: 'api_key',
          keySource: preferredKey ? 'AI_STUDIO_API_KEY' : fallback1 ? 'GOOGLE_AI_STUDIO_API_KEY' : 'GEMINI_API_KEY',
          status: 'ready'
        });

        const result: AuthResult = {
          success: true,
          status: {
            isAuthenticated: true,
            method: 'api_key',
            userInfo: {
              planType: 'free',
            },
          },
          requiresAction: false,
        };
        
        // Cache successful authentication (24-hour TTL)
        this.authCache.set('aistudio', result);
        return result;
      },
      {
        operationName: 'verify-aistudio-auth',
        layer: 'aistudio',
        timeout: 10000, // Increased timeout for MCP server check
      }
    );
  }

  /**
   * Validate AI Studio API key format (dedicated method for AuthVerifier)
   */
  private validateAIStudioApiKeyFormat(apiKey: string): boolean {
    if (!apiKey || typeof apiKey !== 'string') {
      return false;
    }
    
    // Google AI Studio API keys typically start with "AI" and are 39+ characters
    return apiKey.length >= 20 && apiKey.startsWith('AI');
  }

  /**
   * Verify Claude Code authentication with intelligent caching
   * Uses 12-hour cache for session-based authentication
   */
  async verifyClaudeCodeAuth(): Promise<AuthResult> {
    // Check cache first (12-hour TTL for session auth)
    const cachedResult = this.authCache.get('claude');
    if (cachedResult) {
      return cachedResult;
    }

    return safeExecute(
      async () => {
        logger.info('Verifying Claude Code authentication...');

        try {
          // Check if Claude Code is installed
          const isInstalled = await this.checkClaudeCodeInstalled();
          
          if (!isInstalled) {
            const result: AuthResult = {
              success: false,
              status: {
                isAuthenticated: false,
                method: 'session',
                userInfo: undefined,
              },
              error: 'Claude Code not installed',
              requiresAction: true,
              actionInstructions: 'Install Claude Code: npm install -g @anthropic-ai/claude-code',
            };
            
            // Cache failed authentication
            this.authCache.set('claude', result);
            return result;
          }

          // Test Claude Code functionality
          const isWorking = await this.testClaudeCodeFunctionality();
          
          if (!isWorking) {
            const result: AuthResult = {
              success: false,
              status: {
                isAuthenticated: false,
                method: 'session',
                userInfo: undefined,
              },
              error: 'Claude Code authentication required',
              requiresAction: true,
              actionInstructions: 'Run "claude auth" to authenticate Claude Code',
            };
            
            // Cache failed authentication
            this.authCache.set('claude', result);
            return result;
          }

          const result: AuthResult = {
            success: true,
            status: {
              isAuthenticated: true,
              method: 'session',
              userInfo: {
                planType: 'authenticated',
              },
            },
            requiresAction: false,
          };
          
          // Cache successful authentication (12-hour TTL)
          this.authCache.set('claude', result);
          return result;

        } catch (error) {
          logger.error('Claude Code verification failed', { error: (error as Error).message });
          
          return {
            success: false,
            status: {
              isAuthenticated: false,
              method: 'session',
              userInfo: undefined,
            },
            error: `Claude Code verification failed: ${(error as Error).message}`,
            requiresAction: true,
            actionInstructions: 'Ensure Claude Code is properly installed and authenticated',
          };
        }
      },
      {
        operationName: 'verify-claude-auth',
        layer: 'claude',
        timeout: 10000,
      }
    );
  }

  /**
   * Verify authentication for a specific service
   */
  async verifyServiceAuth(service: 'gemini' | 'aistudio' | 'claude'): Promise<AuthResult> {
    switch (service) {
      case 'gemini':
        return this.verifyGeminiAuth();
      case 'aistudio':
        return this.verifyAIStudioAuth();
      case 'claude':
        return this.verifyClaudeCodeAuth();
      default:
        throw new Error(`Unknown service: ${service}`);
    }
  }

  /**
   * Test Gemini API key validity with a lightweight request
   */
  private async testGeminiApiKey(apiKey: string): Promise<void> {
    // Import Google AI library dynamically to avoid loading if not needed
    const { GoogleGenAI } = await import('@google/genai');
    
    try {
      const genAI = new GoogleGenAI({ apiKey });
      
      // Simple test prompt to validate API key and check quota
      const result = await genAI.models.generateContent({
        model: 'gemini-pro',
        contents: [{
          parts: [{ text: 'Test' }]
        }]
      });
      
      if (!result.candidates || result.candidates.length === 0) {
        throw new Error('API key test failed - no response');
      }
      
      logger.debug('Gemini API key validation successful');
    } catch (error) {
      const errorMessage = (error as Error).message;
      
      // Enhanced quota error detection during authentication
      if (errorMessage.includes('429') || errorMessage.includes('quota') || errorMessage.includes('Quota exceeded')) {
        logger.warn('Gemini quota exceeded during authentication check', { error: errorMessage });
        throw new Error(`Gemini API quota exceeded. Please wait before retrying or use a different model. Details: ${errorMessage}`);
      }
      
      logger.warn('Gemini API key validation failed', { error: errorMessage });
      throw new Error(`Gemini API key invalid: ${errorMessage}`);
    }
  }

  /**
   * Get authentication cache statistics
   */
  getAuthCacheStats() {
    return this.authCache.getStats();
  }

  /**
   * Clear authentication cache for a specific service
   */
  clearAuthCache(service?: 'gemini' | 'aistudio' | 'claude'): void {
    if (service) {
      this.authCache.invalidate(service);
      logger.info('Authentication cache cleared for service', { service });
    } else {
      this.authCache.clear();
      logger.info('All authentication cache cleared');
    }
  }

  /**
   * Force refresh authentication for a service
   */
  async forceRefreshAuth(service: 'gemini' | 'aistudio' | 'claude'): Promise<AuthResult> {
    this.authCache.forceRefresh(service);
    return await this.verifyServiceAuth(service);
  }

  /**
   * Check if Claude Code is installed
   */
  private async checkClaudeCodeInstalled(): Promise<boolean> {
    // Cross-platform check using platformUtils
    if (commandExists('claude')) {
      return true;
    }
    // Fallback: try running claude --version
    try {
      execSync('claude --version', { stdio: 'ignore', timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Test Claude Code functionality
   */
  private async testClaudeCodeFunctionality(): Promise<boolean> {
    try {
      // Try a simple claude command
      const output = execSync('claude --help', { 
        encoding: 'utf8',
        timeout: 5000,
        stdio: 'pipe'
      });
      
      // Check if the output indicates authentication is needed
      const needsAuth = output.toLowerCase().includes('auth') && 
                       (output.toLowerCase().includes('required') || 
                        output.toLowerCase().includes('login'));
      
      return !needsAuth;
    } catch (error) {
      logger.debug('Claude Code functionality test failed', { error: (error as Error).message });
      return false;
    }
  }

  /**
   * Generate recommendations based on verification results
   */
  private generateRecommendations(services: Record<string, AuthResult>): string[] {
    const recommendations: string[] = [];

    if (services.gemini && !services.gemini.success) {
      if (services.gemini.actionInstructions) {
        recommendations.push(`Gemini: ${services.gemini.actionInstructions}`);
      }
    }

    if (services.aistudio && !services.aistudio.success) {
      if (services.aistudio.actionInstructions) {
        recommendations.push(`AI Studio: ${services.aistudio.actionInstructions}`);
      }
    }

    if (services.claude && !services.claude.success) {
      if (services.claude.actionInstructions) {
        recommendations.push(`Claude Code: ${services.claude.actionInstructions}`);
      }
    }

    // Add general recommendations
    if (recommendations.length === 0) {
      recommendations.push('All services are properly authenticated and ready to use!');
    } else {
      recommendations.push('For setup assistance, run: cgmb setup-guide');
    }

    return recommendations;
  }

  /**
   * Quick check if any authentication is available
   */
  async hasAnyAuthentication(): Promise<boolean> {
    try {
      const results = await this.verifyAllAuthentications();
      return Object.values(results.services).some(service => service.success);
    } catch {
      return false;
    }
  }

  /**
   * Get human-readable status for a service
   */
  async getServiceStatus(service: 'gemini' | 'aistudio' | 'claude'): Promise<string> {
    try {
      const result = await this.verifyServiceAuth(service);
      
      if (result.success) {
        const method = result.status.method;
        const user = result.status.userInfo?.email ?? 'authenticated user';
        return `✅ ${service}: Authenticated via ${method} (${user})`;
      } else {
        return `❌ ${service}: ${result.error}`;
      }
    } catch (error) {
      return `❌ ${service}: Verification failed - ${(error as Error).message}`;
    }
  }

  /**
   * Check if service needs attention
   */
  async serviceNeedsAttention(service: 'gemini' | 'aistudio' | 'claude'): Promise<boolean> {
    try {
      const result = await this.verifyServiceAuth(service);
      return !result.success && result.requiresAction;
    } catch {
      return true;
    }
  }
}