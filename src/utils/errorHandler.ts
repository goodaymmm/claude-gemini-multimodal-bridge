import { CGMBError, LayerError, WorkflowError, LayerType } from '../core/types.js';
import { logger } from './logger.js';

// ===================================
// Error Handling Utilities
// ===================================

export interface RetryOptions {
  maxRetries: number;
  delay: number;
  backoffMultiplier: number;
  maxDelay: number;
}

export class ErrorHandler {
  private static defaultRetryOptions: RetryOptions = {
    maxRetries: 3,
    delay: 1000,
    backoffMultiplier: 2,
    maxDelay: 10000,
  };

  /**
   * Retry a function with exponential backoff
   */
  public static async retry<T>(
    operation: () => Promise<T>,
    options: Partial<RetryOptions> = {}
  ): Promise<T> {
    const opts = { ...this.defaultRetryOptions, ...options };
    let lastError: Error;

    for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as Error;
        
        if (attempt === opts.maxRetries) {
          throw new CGMBError(
            `Operation failed after ${opts.maxRetries} retries: ${lastError.message}`,
            'MAX_RETRIES_EXCEEDED',
            undefined,
            { originalError: lastError, attempts: attempt + 1 }
          );
        }

        // Don't retry certain types of errors
        if (this.shouldNotRetry(error as Error)) {
          throw error;
        }

        const delay = Math.min(
          opts.delay * Math.pow(opts.backoffMultiplier, attempt),
          opts.maxDelay
        );

        logger.warn(`Attempt ${attempt + 1} failed, retrying in ${delay}ms`, {
          error: lastError.message,
          attempt: attempt + 1,
          maxRetries: opts.maxRetries,
        });

        await this.sleep(delay);
      }
    }

    throw lastError!;
  }

  /**
   * Wrap async operations with comprehensive error handling
   */
  public static async safeExecute<T>(
    operation: () => Promise<T>,
    context: {
      operationName: string;
      layer?: LayerType;
      timeout?: number;
    }
  ): Promise<T> {
    const startTime = Date.now();
    
    try {
      logger.debug(`Starting operation: ${context.operationName}`, context);

      let result: T;
      
      if (context.timeout) {
        result = await Promise.race([
          operation(),
          this.createTimeoutPromise(context.timeout, context.operationName),
        ]);
      } else {
        result = await operation();
      }

      const duration = Date.now() - startTime;
      logger.debug(`Operation completed: ${context.operationName}`, {
        ...context,
        duration,
        success: true,
      });

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      const enhancedError = this.enhanceError(error as Error, context);
      
      logger.error(`Operation failed: ${context.operationName}`, {
        ...context,
        duration,
        error: enhancedError.message,
        stack: enhancedError.stack,
      });

      throw enhancedError;
    }
  }

  /**
   * Create a circuit breaker for external services
   */
  public static createCircuitBreaker<T extends any[], R>(
    operation: (...args: T) => Promise<R>,
    options: {
      failureThreshold: number;
      timeout: number;
      resetTimeout: number;
    }
  ): (...args: T) => Promise<R> {
    let failureCount = 0;
    let lastFailureTime = 0;
    let state: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED';

    return async (...args: T): Promise<R> => {
      const now = Date.now();

      // Check if we should reset the circuit breaker
      if (state === 'OPEN' && now - lastFailureTime > options.resetTimeout) {
        state = 'HALF_OPEN';
        failureCount = 0;
      }

      // If circuit is open, fail fast
      if (state === 'OPEN') {
        throw new CGMBError(
          'Circuit breaker is OPEN',
          'CIRCUIT_BREAKER_OPEN',
          undefined,
          { failureCount, lastFailureTime }
        );
      }

      try {
        const result = await operation(...args);
        
        // Reset on success
        if (state === 'HALF_OPEN') {
          state = 'CLOSED';
          failureCount = 0;
        }
        
        return result;
      } catch (error) {
        failureCount++;
        lastFailureTime = now;

        if (failureCount >= options.failureThreshold) {
          state = 'OPEN';
          logger.warn('Circuit breaker opened', {
            failureCount,
            threshold: options.failureThreshold,
          });
        }

        throw error;
      }
    };
  }

  /**
   * Handle layer-specific errors
   */
  public static handleLayerError(error: Error, layer: LayerType): LayerError {
    if (error instanceof LayerError) {
      return error;
    }

    let code = 'UNKNOWN_ERROR';
    let message = error.message;

    // Categorize common errors
    if (error.message.includes('timeout')) {
      code = 'TIMEOUT_ERROR';
    } else if (error.message.includes('rate limit')) {
      code = 'RATE_LIMIT_ERROR';
    } else if (error.message.includes('authentication')) {
      code = 'AUTH_ERROR';
    } else if (error.message.includes('not found')) {
      code = 'NOT_FOUND_ERROR';
    } else if (error.message.includes('permission')) {
      code = 'PERMISSION_ERROR';
    }

    return new LayerError(message, layer, {
      originalError: error,
      code,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Create error recovery strategies
   */
  public static async recoverFromError<T>(
    error: Error,
    recoveryStrategies: Array<() => Promise<T>>
  ): Promise<T> {
    logger.warn('Attempting error recovery', {
      error: error.message,
      strategiesCount: recoveryStrategies.length,
    });

    for (let i = 0; i < recoveryStrategies.length; i++) {
      try {
        const result = await recoveryStrategies[i]!();
        logger.info(`Recovery successful using strategy ${i + 1}`);
        return result;
      } catch (recoveryError) {
        logger.debug(`Recovery strategy ${i + 1} failed`, {
          error: (recoveryError as Error).message,
        });
        
        if (i === recoveryStrategies.length - 1) {
          throw new CGMBError(
            'All recovery strategies failed',
            'RECOVERY_FAILED',
            undefined,
            { originalError: error, recoveryErrors: recoveryError }
          );
        }
      }
    }

    throw error;
  }

  private static async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private static async createTimeoutPromise<T>(
    timeout: number,
    operationName: string
  ): Promise<T> {
    return new Promise((_, reject) => {
      setTimeout(() => {
        reject(new CGMBError(
          `Operation '${operationName}' timed out after ${timeout}ms`,
          'TIMEOUT_ERROR'
        ));
      }, timeout);
    });
  }

  private static shouldNotRetry(error: Error): boolean {
    const nonRetryableErrors = [
      'AUTH_ERROR',
      'PERMISSION_ERROR',
      'VALIDATION_ERROR',
      'NOT_FOUND_ERROR',
    ];

    return nonRetryableErrors.some(code => 
      error.message.includes(code) || 
      (error as CGMBError).code === code
    );
  }

  private static enhanceError(
    error: Error,
    context: { operationName: string; layer?: LayerType; timeout?: number }
  ): CGMBError {
    if (error instanceof CGMBError) {
      return error;
    }

    const enhancedError = context.layer
      ? new LayerError(error.message, context.layer, {
          originalError: error,
          context,
          timestamp: new Date().toISOString(),
        })
      : new CGMBError(error.message, 'ENHANCED_ERROR', context.layer, {
          originalError: error,
          context,
          timestamp: new Date().toISOString(),
        });

    // Preserve stack trace
    enhancedError.stack = error.stack;
    
    return enhancedError;
  }
}

// Export convenience functions
export const retry = ErrorHandler.retry.bind(ErrorHandler);
export const safeExecute = ErrorHandler.safeExecute.bind(ErrorHandler);
export const handleLayerError = ErrorHandler.handleLayerError.bind(ErrorHandler);
export const recoverFromError = ErrorHandler.recoverFromError.bind(ErrorHandler);