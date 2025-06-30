import { execSync } from 'child_process';
import { AuthResult, VerificationResult } from '../core/types.js';
import { logger } from '../utils/logger.js';
import { safeExecute } from '../utils/errorHandler.js';
import { OAuthManager } from './OAuthManager.js';

/**
 * AuthVerifier handles authentication verification for all services
 * Provides clear error messages and guidance for authentication failures
 */
export class AuthVerifier {
  private oauthManager: OAuthManager;

  constructor() {
    this.oauthManager = new OAuthManager();
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
   * Verify Gemini authentication
   */
  async verifyGeminiAuth(): Promise<AuthResult> {
    return safeExecute(
      async () => {
        logger.info('Verifying Gemini authentication...');

        try {
          const status = await this.oauthManager.checkGeminiAuthentication();
          
          if (status.isAuthenticated) {
            return {
              success: true,
              status,
              requiresAction: false,
            };
          } else {
            const method = await this.oauthManager.getAuthMethod('gemini');
            return {
              success: false,
              status,
              error: 'Gemini not authenticated',
              requiresAction: true,
              actionInstructions: method === 'api_key' 
                ? 'Set GEMINI_API_KEY environment variable'
                : 'Run "gemini auth" to authenticate via OAuth',
            };
          }
        } catch (error) {
          logger.error('Gemini authentication verification failed', { error: (error as Error).message });
          
          return {
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
   * Verify AI Studio authentication
   * Enhanced to address authentication issues from Error.md
   */
  async verifyAIStudioAuth(): Promise<AuthResult> {
    return safeExecute(
      async () => {
        logger.info('Verifying AI Studio authentication...');

        // Enhanced environment variable resolution with priority order
        const preferredKey = process.env.AI_STUDIO_API_KEY;
        const fallback1 = process.env.GOOGLE_AI_STUDIO_API_KEY;
        const fallback2 = process.env.GEMINI_API_KEY; // Deprecated
        
        const apiKey = preferredKey || fallback1 || fallback2;
        
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
          
          return {
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

        // Check if aistudio-mcp-server is available with enhanced error reporting
        const hasAIStudioMCP = await this.checkAIStudioMCPAvailable();
        
        if (!hasAIStudioMCP) {
          logger.warn('AI Studio MCP server not available, but API key is valid', {
            apiKeyStatus: 'valid',
            mcpServerStatus: 'not available',
            solution: 'Install aistudio-mcp-server package',
            installCommand: 'npm install -g aistudio-mcp-server'
          });
          
          return {
            success: false,
            status: {
              isAuthenticated: true, // API key is valid
              method: 'api_key',
              userInfo: {
                planType: 'free',
              },
            },
            error: 'AI Studio MCP server not available (but API key is valid)',
            requiresAction: true,
            actionInstructions: 'Install AI Studio MCP: npm install -g aistudio-mcp-server',
          };
        }

        logger.info('AI Studio authentication verification successful', {
          method: 'api_key',
          keySource: preferredKey ? 'AI_STUDIO_API_KEY' : fallback1 ? 'GOOGLE_AI_STUDIO_API_KEY' : 'GEMINI_API_KEY',
          mcpServerAvailable: true,
          status: 'ready'
        });

        return {
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
   * Verify Claude Code authentication
   */
  async verifyClaudeCodeAuth(): Promise<AuthResult> {
    return safeExecute(
      async () => {
        logger.info('Verifying Claude Code authentication...');

        try {
          // Check if Claude Code is installed
          const isInstalled = await this.checkClaudeCodeInstalled();
          
          if (!isInstalled) {
            return {
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
          }

          // Test Claude Code functionality
          const isWorking = await this.testClaudeCodeFunctionality();
          
          if (!isWorking) {
            return {
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
          }

          return {
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
   * Check if AI Studio MCP server is available
   */
  private async checkAIStudioMCPAvailable(): Promise<boolean> {
    try {
      // Try to find aistudio-mcp-server
      execSync('npx -y aistudio-mcp-server --version', { 
        stdio: 'ignore',
        timeout: 5000 
      });
      return true;
    } catch {
      try {
        // Alternative check
        execSync('which aistudio-mcp-server', { stdio: 'ignore' });
        return true;
      } catch {
        return false;
      }
    }
  }

  /**
   * Check if Claude Code is installed
   */
  private async checkClaudeCodeInstalled(): Promise<boolean> {
    try {
      execSync('which claude', { stdio: 'ignore' });
      return true;
    } catch {
      try {
        execSync('claude --version', { stdio: 'ignore' });
        return true;
      } catch {
        return false;
      }
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
        const user = result.status.userInfo?.email || 'authenticated user';
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