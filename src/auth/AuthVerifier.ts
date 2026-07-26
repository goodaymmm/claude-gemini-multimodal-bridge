import { commandExists } from '../utils/platformUtils.js';
import { execFileSync, execSync } from 'child_process';
import { AuthResult, VerificationResult } from '../core/types.js';
import { logger } from '../utils/logger.js';
import { AGY_INSTALL_HINT } from '../utils/antigravityCli.js';
import { buildSpawnTarget, commandAvailable } from '../utils/processUtils.js';
import { safeExecute } from '../utils/errorHandler.js';
import { OAuthManager } from './OAuthManager.js';
import { AuthCache } from './AuthCache.js';

/** Why an AI Studio credential probe failed. */
type AIStudioProbeFailure = 'invalid_credential' | 'permanent_configuration' | 'transient_service';

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
    
    // Setup periodic cache cleanup (every 30 minutes).
    //
    // unref'd so it never by itself keeps the process alive: the long-running
    // MCP server has plenty of other handles, but a one-shot `cgmb` command
    // that merely constructs an AuthVerifier would otherwise hang for 30
    // minutes at exit. That is why the CLI has to call process.exit()
    // explicitly, and why a test importing LayerManager never terminates.
    const cleanupTimer = setInterval(() => {
      this.authCache.cleanup();
    }, 30 * 60 * 1000);
    cleanupTimer.unref();
  }

  /**
   * Verify all service authentications.
   *
   * @param options.live Re-probe every service instead of trusting the cache.
   *
   * Successful results are cached for hours, which is right for hot internal
   * paths but wrong for a user who explicitly asks "am I authenticated?".
   * After a sign-out, a revoked credential, an uninstalled binary or a network
   * failure, the cache would keep answering "authenticated" for up to 6 hours
   * and the user would only discover otherwise on their next real request --
   * the same delayed-failure pattern this migration set out to remove.
   * `cgmb auth-status` and `cgmb verify` therefore pass live: true.
   */
  async verifyAllAuthentications(options: { live?: boolean } = {}): Promise<VerificationResult> {
    if (options.live) {
      // Drop cached verdicts and failure backoff so every service is re-probed.
      // This is an explicit user action, so the extra latency is warranted.
      for (const service of ['antigravity', 'gemini', 'aistudio', 'claude'] as const) {
        this.authCache.forceRefresh(service);
      }
    }

    return safeExecute(
      async () => {
        logger.info('Starting comprehensive authentication verification...');

        const services = {
          gemini: await this.verifyGeminiAuth(),
          aistudio: await this.verifyAIStudioAuth(options),
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

          // There is deliberately no API-key fallback here.
          //
          // This used to validate GEMINI_API_KEY against the Gemini API and, on
          // success, report the search layer as authenticated for 6 hours. But
          // Antigravity authenticates solely through OAuth tokens in the OS
          // keyring and never consumes that key, so the check proved nothing
          // about the layer. On a machine with a leftover key but no agy -- or
          // no sign-in, or a network fault -- the layer was reported healthy and
          // only failed on the first real request. A successful `agy models`
          // above is the only evidence that counts.

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
            actionInstructions: 'Run `agy` once interactively and complete the Google sign-in (tokens are stored in the OS keyring)',
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
            actionInstructions: `Install the Antigravity CLI (${AGY_INSTALL_HINT}), then run \`agy\` once to sign in`,
          };
          
          return result;
        }
      },
      {
        operationName: 'verify-gemini-auth',
        layer: 'antigravity',
        timeout: 10000,
      }
    );
  }

  /**
   * Verify AI Studio authentication with intelligent caching
   * Enhanced to address authentication issues from Error.md with 24-hour cache
   */
  async verifyAIStudioAuth(options: { live?: boolean } = {}): Promise<AuthResult> {
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

        // A well-formed key is not a working key.
        //
        // The format check only asserts "starts with AI, at least 20 chars", so
        // a revoked, deleted or entirely fabricated key of the right shape was
        // reported as authenticated. That defeated the point of the live
        // verification added for the setup wizard and `cgmb auth-status`, which
        // exist precisely to answer "does this actually work right now?".
        // The probe is skipped for cached//routine checks to avoid a network
        // round trip on every call.
        if (options.live) {
          const probe = await this.probeAIStudioKey(apiKey);

          if (!probe.ok) {
            const transient = probe.kind === 'transient_service';

            const guidance = probe.kind === 'invalid_credential'
              ? 'Reissue the key at https://aistudio.google.com/app/apikey and update AI_STUDIO_API_KEY'
              : probe.kind === 'permanent_configuration'
                ? 'Check that the Generative Language API is enabled for this project and that the account may use the model'
                : 'Check network connectivity and retry';

            const summary = probe.kind === 'invalid_credential'
              ? `AI Studio rejected the API key: ${probe.error}`
              : probe.kind === 'permanent_configuration'
                ? `AI Studio refused the request for a configuration reason (not the key itself): ${probe.error}`
                : `Could not reach the Gemini API to verify the key: ${probe.error}`;

            const result: AuthResult = {
              success: false,
              status: {
                isAuthenticated: false,
                method: 'api_key',
                userInfo: undefined,
              },
              error: summary,
              // A configuration problem is just as actionable as a bad key;
              // only a genuine service/network fault is not.
              requiresAction: !transient,
              actionInstructions: guidance,
            };

            // Never cache a transient fault as a credential verdict.
            if (!transient) {
              this.authCache.set('aistudio', result);
            }
            return result;
          }
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
  async verifyServiceAuth(service: 'antigravity' | 'gemini' | 'aistudio' | 'claude'): Promise<AuthResult> {
    switch (service) {
      case 'antigravity':
      case 'gemini': // deprecated alias
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
   * Ask the Gemini API whether a key actually works.
   *
   * Uses a metadata read rather than a generation call: it is cheap, consumes
   * no generation quota, and still requires a valid credential. Distinguishes a
   * rejected key from a network fault so a blip is never reported as "your key
   * is invalid".
   */
  private async probeAIStudioKey(
    apiKey: string
  ): Promise<{ ok: boolean; kind?: AIStudioProbeFailure; error?: string }> {
    const TIMEOUT_MS = 8000;

    try {
      const { GoogleGenAI } = await import('@google/genai');
      const client = new GoogleGenAI({ apiKey });

      const probe = client.models.get({ model: 'gemini-2.5-flash' });
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS).unref()
      );

      await Promise.race([probe, timeout]);
      return { ok: true };
    } catch (error) {
      const err = error as Error & { status?: number; code?: number; reason?: string };
      const message = err.message ?? String(error);

      const status = typeof err.status === 'number' ? err.status
        : typeof err.code === 'number' ? err.code
        : undefined;

      // Three outcomes, not two.
      //
      // A boolean "transient" flag forced permanent client errors into the
      // retry bucket: the Gemini API returns 400 API_KEY_INVALID for a bad key,
      // and 403/404 for a disabled API or a misconfigured model. All of those
      // were reported as "check your network and retry" with requiresAction
      // false, so the real problem was never fixed. Google documents 400 and
      // 403 as non-retryable client errors.
      const reason = err.reason ?? '';
      const looksLikeKeyProblem =
        /API_KEY_INVALID|API key not valid|api[_ ]?key|invalid.*credential|unauthenticated/i
          .test(`${reason} ${message}`);

      if (status === 401 || (status === 400 && looksLikeKeyProblem) ||
          (status === 403 && looksLikeKeyProblem)) {
        return { ok: false, kind: 'invalid_credential', error: message };
      }

      if (status === 400 || status === 403 || status === 404) {
        return { ok: false, kind: 'permanent_configuration', error: message };
      }

      if (status === 429 || (typeof status === 'number' && status >= 500)) {
        return { ok: false, kind: 'transient_service', error: message };
      }

      // No usable status: timeouts, DNS, offline.
      return { ok: false, kind: 'transient_service', error: message };
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
  clearAuthCache(service?: 'antigravity' | 'gemini' | 'aistudio' | 'claude'): void {
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
  async forceRefreshAuth(service: 'antigravity' | 'gemini' | 'aistudio' | 'claude'): Promise<AuthResult> {
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
      // Trusted resolution: a shell string here re-resolved `claude` against
      // PATH and the working directory, outside every check.
      if (!commandAvailable('claude')) {
        throw new Error('claude is not available');
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Test Claude Code functionality
   */
  private async testClaudeCodeFunctionality(): Promise<boolean> {
    // `claude auth status --json` reports the session directly. The previous
    // check ran `claude --help` and scanned the help TEXT for "auth" plus
    // "required"/"login" -- but the help lists an `auth` subcommand and
    // includes a JSON schema example containing "required", so the condition
    // was true on every machine. The Claude layer was therefore reported
    // unauthenticated for everyone, cached, and never used.
    try {
      // Must go through the shared launcher: npm installs Claude Code as a
      // `claude.cmd` shim on Windows, and execFileSync on a .cmd fails with
      // EINVAL. Probing it directly reported an installed, signed-in Claude as
      // unauthenticated and cached that, disabling the whole layer.
      const target = buildSpawnTarget('claude', ['auth', 'status', '--json']);
      const output = execFileSync(target.file, target.args, {
        encoding: 'utf8',
        timeout: 10000,
        stdio: 'pipe',
        windowsHide: true,
        ...target.spawnOptions,
      });

      const status = JSON.parse(output) as { loggedIn?: boolean };
      if (status.loggedIn === true) {
        return true;
      }

      logger.debug('Claude Code is installed but not signed in');
      return false;
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
  async getServiceStatus(service: 'antigravity' | 'gemini' | 'aistudio' | 'claude'): Promise<string> {
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
  async serviceNeedsAttention(service: 'antigravity' | 'gemini' | 'aistudio' | 'claude'): Promise<boolean> {
    try {
      const result = await this.verifyServiceAuth(service);
      return !result.success && result.requiresAction;
    } catch {
      return true;
    }
  }
}