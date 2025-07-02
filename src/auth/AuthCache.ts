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
 */
export class AuthCache {
  private cache = new Map<string, CachedAuth>();
  
  // Optimized TTL settings based on service characteristics
  private readonly TTL_SETTINGS = {
    // Gemini CLI: OAuth tokens with refresh capability - 6 hours
    gemini: 6 * 60 * 60 * 1000,
    
    // AI Studio: API keys are long-lived but need periodic validation - 24 hours  
    aistudio: 24 * 60 * 60 * 1000,
    
    // Claude Code: Session-based authentication - 12 hours
    claude: 12 * 60 * 60 * 1000,
  } as const;

  /**
   * Set authentication result in cache with service-specific TTL
   */
  set(service: keyof typeof this.TTL_SETTINGS, auth: AuthResult): void {
    const ttl = this.TTL_SETTINGS[service];
    const expiry = Date.now() + ttl;
    
    this.cache.set(service, {
      auth,
      expiry,
      service,
    });
    
    logger.debug('Authentication cached', {
      service,
      ttl: ttl / 1000 / 60, // minutes
      expiryTime: new Date(expiry).toISOString(),
      success: auth.success,
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
    logger.info('Forced authentication refresh', { service });
  }
}