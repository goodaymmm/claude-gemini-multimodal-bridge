import { logger } from './logger.js';
import { findProcesses } from './platformUtils.js';


/**
 * Unified timeout management for CGMB operations
 * Resolves race conditions and ensures immediate response on completion
 */
export class TimeoutManager {
  private static readonly DEFAULT_TIMEOUT = 120000; // 2 minutes base
  private static readonly ENVIRONMENT_TIMEOUTS = {
    fresh_installation: 1.5, // 50% longer for fresh installations
    mcp_startup: 2.0, // 100% longer for MCP server startup
    authentication: 1.3, // 30% longer for auth operations
  };

  /**
   * Execute operation with unified timeout handling
   * Uses AbortController pattern to ensure immediate timeout clearing
   */
  public static async executeWithTimeout<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    options: {
      name: string;
      timeout?: number;
      environmentType?: keyof typeof TimeoutManager.ENVIRONMENT_TIMEOUTS;
      onWarning?: (timeElapsed: number) => void;
    }
  ): Promise<T> {
    const baseTimeout = options.timeout || this.DEFAULT_TIMEOUT;
    const multiplier = options.environmentType 
      ? this.ENVIRONMENT_TIMEOUTS[options.environmentType] 
      : 1.0;
    const finalTimeout = Math.round(baseTimeout * multiplier);

    const controller = new AbortController();
    const startTime = Date.now();
    
    logger.debug('Starting timeout-managed operation', {
      operation: options.name,
      baseTimeout,
      multiplier,
      finalTimeout,
      environmentType: options.environmentType ?? 'standard'
    });

    let timeoutId: NodeJS.Timeout | undefined;
    let warningTimeoutId: NodeJS.Timeout | undefined;

    try {
      // Set up warning timeout (at 70% of total timeout)
      const onWarning = options.onWarning;
      if (onWarning) {
        // Captured before the timer: narrowing an object property does not
        // survive into a callback, which is why this needed an assertion.
        const warningTime = Math.round(finalTimeout * 0.7);
        warningTimeoutId = setTimeout(() => {
          const elapsed = Date.now() - startTime;
          onWarning(elapsed);
        }, warningTime);
      }

      // Set up final timeout
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          controller.abort();
          const elapsed = Date.now() - startTime;
          logger.warn('Operation timeout exceeded', {
            operation: options.name,
            timeout: finalTimeout,
            elapsed,
            environmentType: options.environmentType
          });
          reject(new Error(
            `Operation "${options.name}" timed out after ${finalTimeout}ms ` +
            `(${Math.round(elapsed/1000)}s elapsed, environment: ${options.environmentType ?? 'standard'})`
          ));
        }, finalTimeout);
      });

      // Race between operation and timeout
      const result = await Promise.race([
        operation(controller.signal),
        timeoutPromise
      ]);

      // Clear timeouts immediately on success
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }
      if (warningTimeoutId) {
        clearTimeout(warningTimeoutId);
        warningTimeoutId = undefined;
      }

      const elapsed = Date.now() - startTime;
      logger.debug('Operation completed successfully', {
        operation: options.name,
        elapsed,
        timeoutUsed: finalTimeout,
        efficiency: Math.round((elapsed / finalTimeout) * 100) + '%'
      });

      return result;

    } catch (error) {
      // Whatever ended the wait, the caller is about to be told this failed --
      // so anything still running on its behalf has to stop.
      //
      // abort() used to live only inside the timer above, which meant it fired
      // for the one case that is not the common one. A document or multimodal
      // run has an inner budget of about 105 seconds against a CLI timeout of
      // 240 or 300, so the inner layer rejects first: measured, the signal
      // stayed unaborted and the listeners in cli.ts never ran, leaving the MCP
      // child billing away until its own ceiling. Failure is failure, and the
      // boundary contract is that nothing continues past a terminal result.
      //
      // What this does not do: retries *inside* the operation still spawn,
      // because the abort happens as the operation settles. Cancelling those
      // needs the signal threaded through ErrorHandler and LayerManager, which
      // is a separate piece of work.
      if (!controller.signal.aborted) {
        controller.abort();
      }

      // Ensure cleanup on any error
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (warningTimeoutId) {
        clearTimeout(warningTimeoutId);
      }
      
      const elapsed = Date.now() - startTime;
      logger.error('Operation failed', {
        operation: options.name,
        elapsed,
        error: error instanceof Error ? error.message : String(error)
      });
      
      throw error;
    }
  }

  /**
   * Detect environment characteristics for adaptive timeouts
   */
  public static detectEnvironment(): {
    type: keyof typeof TimeoutManager.ENVIRONMENT_TIMEOUTS | 'standard';
    reason: string;
  } {
    // Check for fresh installation indicators
    const isNewEnvironment = this.isFreshInstallation();
    if (isNewEnvironment) {
      return {
        type: 'fresh_installation',
        reason: 'Fresh installation detected - authentication and MCP startup may take longer'
      };
    }

    // Check for MCP server startup requirements
    const needsMCPStartup = this.needsMCPServerStartup();
    if (needsMCPStartup) {
      return {
        type: 'mcp_startup',
        reason: 'MCP server startup required - cold start may take longer'
      };
    }

    return {
      type: 'standard',
      reason: 'Standard environment with warm processes'
    };
  }

  /**
   * Check if this appears to be a fresh installation
   */
  private static isFreshInstallation(): boolean {
    try {
      // Check for typical fresh installation indicators
      const indicators = [
        // No previous authentication cache
        // Antigravity CLI keeps its state under ~/.gemini/antigravity-cli
        !process.env.HOME || !require('fs').existsSync(require('path').join(process.env.HOME, '.gemini', 'antigravity-cli')),
        // No local CGMB cache/config
        !require('fs').existsSync(require('path').join(process.cwd(), 'logs')),
        // Environment variables suggest fresh setup
        !process.env.CGMB_INITIALIZED,
      ];
      
      return indicators.filter(Boolean).length >= 2;
    } catch {
      return false;
    }
  }

  /**
   * Check if MCP server needs cold startup
   */
  private static needsMCPServerStartup(): boolean {
    try {
      // Check for node processes running AI Studio MCP server
      // (findProcesses does the work; a leftover require('child_process') here
      // was unused and would not resolve in this ESM module anyway.)
      try {
        const processes = findProcesses("ai-studio-mcp-server");
        return processes.length === 0; // No processes found = needs startup
      } catch {
        return true; // Assume needs startup if check fails
      }
    } catch {
      return true;
    }
  }

  /**
   * Create a timeout-aware promise wrapper for CLI commands
   */
  public static wrapCLICommand<T>(
    command: (signal: AbortSignal) => Promise<T>,
    commandName: string,
    baseTimeout: number = 120000
  ): Promise<T> {
    const environment = this.detectEnvironment();

    return this.executeWithTimeout(
      // The signal reaches the command now. It used to be discarded here under
      // a comment saying it was passed on, so a timeout only ever ended the
      // waiting: the work carried on. Every caller of this wrapper is a billed
      // AI Studio operation -- image, audio, document, multimodal -- so the CLI
      // reported failure while the request kept running, and a retry on top of
      // it paid twice for output nobody would see.
      async (signal) => command(signal),
      {
        name: `CLI-${commandName}`,
        timeout: baseTimeout,
        ...(environment.type !== 'standard' && { environmentType: environment.type }),
        onWarning: (elapsed) => {
          logger.info(`⚠️ ${commandName} is taking longer than expected (${Math.round(elapsed/1000)}s)...`);
          logger.info(`💡 ${environment.reason}`);
        }
      }
    );
  }

  /**
   * Create timeout for MCP operations with layer-specific settings
   */
  public static createMCPTimeout(
    layer: 'claude' | 'antigravity' | 'gemini' | 'aistudio',
    operation: string,
    hasFiles: boolean = false
  ): {
    timeout: number;
    environmentType: keyof typeof TimeoutManager.ENVIRONMENT_TIMEOUTS | 'standard';
  } {
    const environment = this.detectEnvironment();
    
    const baseTimeouts = {
      claude: 300000,      // 5 minutes for complex reasoning
      antigravity: 60000,  // 1 minute for search/text processing
      gemini: 60000,       // deprecated alias for 'antigravity'
      aistudio: 180000,    // 3 minutes for multimodal processing
    };

    let baseTimeout = baseTimeouts[layer];
    
    // Adjust for file processing
    if (hasFiles) {
      baseTimeout = Math.round(baseTimeout * 1.5);
    }
    
    // Adjust for specific operations
    if (operation.includes('generate_image') || operation.includes('image_generation')) {
      baseTimeout = Math.round(baseTimeout * 0.8); // Images often complete faster
    } else if (operation.includes('generate_audio') || operation.includes('audio_generation')) {
      baseTimeout = Math.round(baseTimeout * 0.6); // Audio completes quickly
    }

    return {
      timeout: baseTimeout,
      environmentType: environment.type === 'standard' ? 'standard' : environment.type
    };
  }
}

/**
 * Convenience function for wrapping operations with timeout management
 */
export async function withTimeout<T>(
  operation: () => Promise<T>,
  name: string,
  timeoutMs: number = 120000
): Promise<T> {
  return TimeoutManager.executeWithTimeout(
    async () => operation(),
    { name, timeout: timeoutMs }
  );
}

/**
 * Convenience function for CLI commands with environment detection
 */
export async function withCLITimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  commandName: string,
  baseTimeout: number = 120000
): Promise<T> {
  return TimeoutManager.wrapCLICommand(operation, commandName, baseTimeout);
}