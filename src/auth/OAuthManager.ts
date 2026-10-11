import { AuthenticationError, AuthErrorCode, AuthStatus } from '../core/types.js';
import { logger } from '../utils/logger.js';
import { safeExecute } from '../utils/errorHandler.js';
import { AGY_INSTALL_HINT, findAntigravityBinary, probeAntigravityAuth } from '../utils/antigravityCli.js';

/**
 * OAuthManager handles Antigravity CLI (`agy`) authentication.
 *
 * agy signs in through Google OAuth with its tokens in the OS keyring; the only
 * evidence of that session is a live `agy models` probe (probeAntigravityAuth).
 * API keys in the environment are never taken as an agy sign-in.
 */
export class OAuthManager {
  private authCache: Map<string, AuthStatus> = new Map();
  private readonly CACHE_TTL = 3600000; // 1 hour in milliseconds

  /**
   * Check Antigravity CLI authentication status with a live `agy models` probe
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
        layer: 'antigravity',
        timeout: 10000,
      }
    );
  }

  /**
   * Check the Antigravity CLI sign-in and tell the user how to complete it.
   *
   * The answer comes from a live `agy models` probe and nothing else. This used
   * to short-circuit on GEMINI_API_KEY / GOOGLE_API_KEY: any value longer than
   * ten characters -- including the `your_gemini_api_key_here` placeholder the
   * postinstall script writes into a fresh .env -- reported agy as signed in
   * while the keyring was empty. agy never receives that key (see
   * buildAgyChildEnv), so it proves nothing about the session the layer uses.
   *
   * Resolves true when agy is signed in and false when it is not. Throws an
   * AuthenticationError when the sign-in state could not be established at all
   * (agy not installed, unreachable, or timed out), because none of those is a
   * sign-in failure and must not be reported as one.
   */
  async promptGeminiLogin(): Promise<boolean> {
    return safeExecute(
      async () => {
        logger.info('Checking Antigravity CLI sign-in...');

        const probe = await probeAntigravityAuth();

        if (probe.authenticated) {
          const status: AuthStatus = {
            isAuthenticated: true,
            method: 'oauth',
            userInfo: {
              planType: 'free',
              email: undefined,
              quotaRemaining: undefined,
            },
          };
          this.updateCache('gemini', status);
          logger.info('Antigravity CLI is signed in');
          return true;
        }

        // Never cache a negative answer here: the user is about to go and fix it.
        this.authCache.delete('gemini');

        switch (probe.outcome) {
          case 'not-installed':
            throw new AuthenticationError(
              `Antigravity CLI (agy) is not installed. Install it with: ${AGY_INSTALL_HINT}`,
              'gemini',
              AuthErrorCode.AUTH_SETUP_REQUIRED,
              {
                method: 'oauth',
                instructions: AGY_INSTALL_HINT,
                canRetry: true,
              }
            );

          case 'timeout':
          case 'unavailable': {
            const what = probe.outcome === 'timeout'
              ? 'did not answer in time'
              : 'could not reach its service';
            throw new AuthenticationError(
              `Antigravity CLI ${what}, so its sign-in state is unknown ` +
              `(${probe.error ?? probe.outcome}). This is not a sign-in failure; ` +
              'check your network and try again.',
              'gemini',
              AuthErrorCode.NOT_AUTHENTICATED,
              {
                method: 'oauth',
                instructions: 'Check your network connection, then run `agy models` to confirm agy can answer',
                canRetry: true,
              }
            );
          }

          case 'unauthenticated':
          default:
            logger.warn(
              'Antigravity CLI is not signed in. Sign in again by running `agy` in a terminal.',
              { error: probe.error }
            );
            return false;
        }
      },
      {
        operationName: 'prompt-antigravity-login',
        layer: 'antigravity',
        timeout: 60000,
      }
    );
  }

  /**
   * Re-check the Antigravity CLI sign-in.
   *
   * There is no token for CGMB to refresh: agy keeps and renews its own OAuth
   * tokens in the OS keyring. "Refreshing" therefore means dropping the cached
   * answer and probing again. An API key in the environment is not consulted,
   * for the reason given on promptGeminiLogin().
   */
  async refreshGeminiToken(): Promise<boolean> {
    return safeExecute(
      async () => {
        this.authCache.delete('gemini');
        logger.info('Re-checking Antigravity CLI sign-in...');

        try {
          return await this.promptGeminiLogin();
        } catch (error) {
          // promptGeminiLogin only throws when the sign-in state is unknown
          // (not installed, unreachable, timed out); its message says which.
          logger.warn('Could not re-check the Antigravity CLI sign-in', {
            error: (error as Error).message,
          });
          return false;
        }
      },
      {
        operationName: 'refresh-gemini-token',
        layer: 'antigravity',
        timeout: 70000, // above promptGeminiLogin's own 60s window
      }
    );
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
   * Get authentication method for a service.
   *
   * The Antigravity CLI ('antigravity', or its deprecated name 'gemini') only
   * ever signs in through Google OAuth stored in the OS keyring, so its method
   * is always 'oauth'; whether that sign-in is present is a separate question
   * answered by checkGeminiAuthentication(). AI Studio uses an API key, looked
   * up in the same order AuthVerifier.verifyAIStudioAuth() uses.
   */
  async getAuthMethod(service: 'antigravity' | 'gemini' | 'aistudio' | 'claude'): Promise<string> {
    if (service === 'antigravity' || service === 'gemini') {
      return 'oauth';
    }

    if (service === 'aistudio') {
      const apiKey = process.env.AI_STUDIO_API_KEY ??
                     process.env.GOOGLE_AI_STUDIO_API_KEY ??
                     process.env.GEMINI_API_KEY; // deprecated for AI Studio
      return apiKey ? 'api_key' : 'none';
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