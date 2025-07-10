import { AuthResult } from '../core/types.js';
import { logger } from '../utils/logger.js';

/**
 * Cached authentication result with expiry
 */
interface CachedAuth {
  auth: AuthResult;
  expiry: number;
  service: string;
}

/**
 * Authentication cache for optimizing repeated auth checks
 * Implements service-specific TTL strategies for optimal performance
 * Singleton pattern with exponential backoff for failures
 */
export class AuthCache {
  private static instance: AuthCache;
  private cache = new Map<string, CachedAuth>();
  private failureTracking = new Map<string, {
    count: number;
    firstFailureTime: number;
    lastFailureTime: number;
  }>();
  
  // Optimized TTL settings based on service characteristics
  private readonly TTL_SETTINGS = {
    // Gemini CLI: OAuth tokens with refresh capability - 6 hours
    gemini: 6 * 60 * 60 * 1000,
    
    // AI Studio: API keys are long-lived but need periodic validation - 24 hours  
    aistudio: 24 * 60 * 60 * 1000,
    
    // Claude Code: Session-based authentication - 12 hours
    claude: 12 * 60 * 60 * 1000,
  } as const;

  // Exponential backoff settings for failures
  private readonly FAILURE_BACKOFF = {
    delays: [30 * 1000, 60 * 1000, 5 * 60 * 1000], // 30s, 1m, 5m
    maxDelay: 5 * 60 * 1000, // 5 minutes max
    resetAfter: 24 * 60 * 60 * 1000, // Reset failure count after 24 hours
    jitterFactor: 0.1 // ±10% randomness
  } as const;

  private constructor() {}

  /**
   * Get singleton instance
   */
  static getInstance(): AuthCache {
    if (!AuthCache.instance) {
      AuthCache.instance = new AuthCache();
    }
    return AuthCache.instance;
  }

  /**
   * Set authentication result in cache with service-specific TTL
   * Implements exponential backoff for failures
   */
  set(service: keyof typeof this.TTL_SETTINGS, auth: AuthResult): void {
    let ttl: number;
    let expiry: number;
    
    if (auth.success) {
      // Success: use normal TTL and reset failure tracking
      ttl = this.TTL_SETTINGS[service];
      expiry = Date.now() + ttl;
      this.failureTracking.delete(service);
      
      logger.debug('Authentication success cached', {
        service,
        ttl: ttl / 1000 / 60, // minutes
        expiryTime: new Date(expiry).toISOString(),
      });
    } else {
      // Failure: use exponential backoff TTL
      const tracking = this.getOrCreateFailureTracking(service);
      tracking.count++;
      tracking.lastFailureTime = Date.now();
      
      ttl = this.calculateFailureTTL(tracking.count);
      expiry = Date.now() + ttl;
      
      logger.warn('Authentication failure cached with backoff', {
        service,
        failureCount: tracking.count,
        ttl: ttl / 1000, // seconds
        nextRetryTime: new Date(expiry).toLocaleTimeString(),
        error: auth.error,
      });
    }
    
    this.cache.set(service, {
      auth,
      expiry,
      service,
    });
  }

  /**
   * Get cached authentication result if still valid
   */
  get(service: keyof typeof this.TTL_SETTINGS): AuthResult | null {
    const cached = this.cache.get(service);
    
    if (!cached) {
      logger.debug('No cached auth found', { service });
      return null;
    }
    
    const now = Date.now();
    const isExpired = now >= cached.expiry;
    
    if (isExpired) {
      logger.debug('Cached auth expired', {
        service,
        expiredSince: (now - cached.expiry) / 1000 / 60, // minutes
      });
      this.cache.delete(service);
      return null;
    }
    
    const timeToExpiry = (cached.expiry - now) / 1000 / 60; // minutes
    logger.debug('Using cached auth', {
      service,
      timeToExpiry: timeToExpiry.toFixed(1),
      success: cached.auth.success,
    });
    
    return cached.auth;
  }

  /**
   * Invalidate cached authentication for a service
   */
  invalidate(service: keyof typeof this.TTL_SETTINGS): void {
    const removed = this.cache.delete(service);
    logger.debug('Authentication cache invalidated', { service, removed });
  }

  /**
   * Clear all cached authentications
   */
  clear(): void {
    const count = this.cache.size;
    this.cache.clear();
    logger.debug('All authentication cache cleared', { count });
  }

  /**
   * Get cache statistics for monitoring
   */
  getStats(): {
    totalEntries: number;
    services: Array<{
      service: string;
      cached: boolean;
      timeToExpiry?: number;
      success?: boolean;
    }>;
  } {
    const now = Date.now();
    const services = Object.keys(this.TTL_SETTINGS).map(service => {
      const cached = this.cache.get(service);
      
      if (!cached) {
        return { service, cached: false };
      }
      
      const timeToExpiry = (cached.expiry - now) / 1000 / 60; // minutes
      
      return {
        service,
        cached: true,
        timeToExpiry: timeToExpiry > 0 ? timeToExpiry : 0,
        success: cached.auth.success,
      };
    });
    
    return {
      totalEntries: this.cache.size,
      services,
    };
  }

  /**
   * Cleanup expired entries (called periodically)
   */
  cleanup(): number {
    const now = Date.now();
    let removedCount = 0;
    
    for (const [service, cached] of this.cache.entries()) {
      if (now >= cached.expiry) {
        this.cache.delete(service);
        removedCount++;
        
        logger.debug('Expired auth cache removed', {
          service,
          expiredSince: (now - cached.expiry) / 1000 / 60, // minutes
        });
      }
    }
    
    if (removedCount > 0) {
      logger.debug('Auth cache cleanup completed', { removedCount });
    }
    
    return removedCount;
  }

  /**
   * Check if auth is cached and valid for a service
   */
  isCached(service: keyof typeof this.TTL_SETTINGS): boolean {
    const cached = this.cache.get(service);
    return cached ? Date.now() < cached.expiry : false;
  }

  /**
   * Force refresh authentication for a service (invalidate + return false)
   */
  forceRefresh(service: keyof typeof this.TTL_SETTINGS): void {
    this.invalidate(service);
    this.failureTracking.delete(service);
    logger.info('Forced authentication refresh', { service });
  }

  /**
   * Get or create failure tracking for a service
   */
  private getOrCreateFailureTracking(service: string) {
    if (!this.failureTracking.has(service)) {
      this.failureTracking.set(service, {
        count: 0,
        firstFailureTime: Date.now(),
        lastFailureTime: Date.now()
      });
    }
    
    const tracking = this.failureTracking.get(service);
    if (!tracking) {
      throw new Error(`Failure tracking not found for service: ${service}`);
    }
    
    // Reset if 24 hours have passed since first failure
    if (Date.now() - tracking.firstFailureTime > this.FAILURE_BACKOFF.resetAfter) {
      tracking.count = 0;
      tracking.firstFailureTime = Date.now();
    }
    
    return tracking;
  }

  /**
   * Calculate TTL for failed authentication with exponential backoff
   */
  private calculateFailureTTL(failureCount: number): number {
    const index = Math.min(failureCount - 1, this.FAILURE_BACKOFF.delays.length - 1);
    const baseDelay = this.FAILURE_BACKOFF.delays[index] ?? this.FAILURE_BACKOFF.maxDelay;
    
    // Add jitter (±10%) to prevent thundering herd
    const jitter = baseDelay * this.FAILURE_BACKOFF.jitterFactor;
    const randomJitter = (Math.random() - 0.5) * 2 * jitter;
    
    return Math.round(baseDelay + randomJitter);
  }

  /**
   * Get failure tracking info for a service
   */
  getFailureInfo(service: string): { count: number; nextRetryTime?: Date } | null {
    const tracking = this.failureTracking.get(service);
    if (!tracking) {return null;}
    
    const cached = this.cache.get(service);
    if (cached && !cached.auth.success) {
      return {
        count: tracking.count,
        nextRetryTime: new Date(cached.expiry)
      };
    }
    
    return { count: tracking.count };
  }
}