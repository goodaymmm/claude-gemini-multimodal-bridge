import { AuthStatus } from '../core/types.js';
import { logger } from '../utils/logger.js';
import { safeExecute } from '../utils/errorHandler.js';
import { AuthVerifier } from './AuthVerifier.js';

/**
 * AuthStateManager handles authentication state caching and monitoring
 * Provides persistent authentication state management across sessions
 */
export class AuthStateManager {
  private authCache: Map<string, AuthStatus & { timestamp: number }> = new Map();
  private authVerifier: AuthVerifier;
  private monitoringInterval?: NodeJS.Timeout | undefined;
  private readonly CACHE_TTL = 3600000; // 1 hour in milliseconds
  private readonly MONITOR_INTERVAL = 1800000; // 30 minutes in milliseconds

  constructor() {
    this.authVerifier = new AuthVerifier();
  }

  /**
   * Get authentication status for a service with caching
   */
  async getAuthStatus(service: 'gemini' | 'aistudio' | 'claude'): Promise<AuthStatus> {
    return safeExecute(
      async () => {
        // Check cache first
        const cached = this.authCache.get(service);
        if (cached && this.isCacheValid(service)) {
          logger.debug(`Using cached auth status for ${service}`, {
            isAuthenticated: cached.isAuthenticated,
            method: cached.method,
            cacheAge: Date.now() - cached.timestamp,
          });
          
          // Return without timestamp
          const { timestamp: _timestamp, ...status } = cached;
          return status;
        }

        // Cache miss or expired, fetch fresh status
        logger.debug(`Fetching fresh auth status for ${service}`);
        
        const result = await this.authVerifier.verifyServiceAuth(service);
        const status = result.status;
        
        // Update cache
        this.setAuthStatus(service, status);
        
        return status;
      },
      {
        operationName: `get-auth-status-${service}`,
        layer: service as 'gemini' | 'aistudio' | 'claude',
        timeout: 10000,
      }
    );
  }

  /**
   * Set authentication status for a service
   */
  async setAuthStatus(service: string, status: AuthStatus): Promise<void> {
    const timestampedStatus = {
      ...status,
      timestamp: Date.now(),
    };
    
    this.authCache.set(service, timestampedStatus);
    
    logger.debug(`Auth status cached for ${service}`, {
      isAuthenticated: status.isAuthenticated,
      method: status.method,
    });
  }

  /**
   * Clear authentication cache for all services or specific service
   */
  async clearAuthCache(service?: string): Promise<void> {
    if (service) {
      this.authCache.delete(service);
      logger.debug(`Auth cache cleared for ${service}`);
    } else {
      this.authCache.clear();
      logger.debug('Auth cache cleared for all services');
    }
  }

  /**
   * Start periodic authentication monitoring
   */
  async startAuthMonitoring(): Promise<void> {
    if (this.monitoringInterval) {
      logger.warn('Auth monitoring already started');
      return;
    }

    logger.info('Starting authentication monitoring', {
      intervalMs: this.MONITOR_INTERVAL,
    });

    this.monitoringInterval = setInterval(async () => {
      await this.performPeriodicCheck();
    }, this.MONITOR_INTERVAL);

    // Perform initial check
    await this.performPeriodicCheck();
  }

  /**
   * Stop periodic authentication monitoring
   */
  async stopAuthMonitoring(): Promise<void> {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = undefined;
      logger.info('Authentication monitoring stopped');
    }
  }

  /**
   * Force refresh authentication status for all services
   */
  async refreshAllAuthStatus(): Promise<Record<string, AuthStatus>> {
    return safeExecute(
      async () => {
        logger.info('Refreshing authentication status for all services...');
        
        // Clear cache to force fresh verification
        await this.clearAuthCache();
        
        const services = ['gemini', 'aistudio', 'claude'] as const;
        const results: Record<string, AuthStatus> = {};
        
        for (const service of services) {
          try {
            results[service] = await this.getAuthStatus(service);
          } catch (error) {
            logger.error(`Failed to refresh auth status for ${service}`, { 
              error: (error as Error).message 
            });
            
            // Set default failed status
            results[service] = {
              isAuthenticated: false,
              method: 'oauth',
              userInfo: undefined,
            };
          }
        }
        
        logger.info('Authentication status refresh completed', {
          authenticated: Object.values(results).filter(s => s.isAuthenticated).length,
          total: services.length,
        });
        
        return results;
      },
      {
        operationName: 'refresh-all-auth-status',
        layer: 'claude',
        timeout: 30000,
      }
    );
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): {
    totalEntries: number;
    validEntries: number;
    expiredEntries: number;
    services: string[];
  } {
    const totalEntries = this.authCache.size;
    const services = Array.from(this.authCache.keys());
    
    let validEntries = 0;
    let expiredEntries = 0;
    
    for (const service of services) {
      if (this.isCacheValid(service)) {
        validEntries++;
      } else {
        expiredEntries++;
      }
    }
    
    return {
      totalEntries,
      validEntries,
      expiredEntries,
      services,
    };
  }

  /**
   * Check if a service is currently authenticated (from cache)
   */
  isServiceAuthenticated(service: string): boolean {
    const cached = this.authCache.get(service);
    return cached?.isAuthenticated === true && this.isCacheValid(service);
  }

  /**
   * Get authentication method for a service (from cache)
   */
  getServiceAuthMethod(service: string): string | undefined {
    const cached = this.authCache.get(service);
    if (cached && this.isCacheValid(service)) {
      return cached.method;
    }
    return undefined;
  }

  /**
   * Check if there are any authentication issues that need attention
   */
  async checkForAuthIssues(): Promise<{
    hasIssues: boolean;
    issues: string[];
    recommendations: string[];
  }> {
    return safeExecute(
      async () => {
        const issues: string[] = [];
        const recommendations: string[] = [];
        
        const services = ['gemini', 'aistudio', 'claude'] as const;
        
        for (const service of services) {
          try {
            const status = await this.getAuthStatus(service);
            
            if (!status.isAuthenticated) {
              issues.push(`${service} is not authenticated`);
              recommendations.push(`Run authentication setup for ${service}`);
            } else if (status.expiresAt && status.expiresAt < new Date()) {
              issues.push(`${service} authentication has expired`);
              recommendations.push(`Refresh authentication for ${service}`);
            }
          } catch (error) {
            issues.push(`Cannot verify ${service} authentication`);
            recommendations.push(`Check ${service} configuration and try again`);
          }
        }
        
        if (issues.length === 0) {
          recommendations.push('All services are properly authenticated');
        } else {
          recommendations.push('Run "cgmb auth --interactive" for guided setup');
        }
        
        return {
          hasIssues: issues.length > 0,
          issues,
          recommendations,
        };
      },
      {
        operationName: 'check-auth-issues',
        layer: 'claude',
        timeout: 15000,
      }
    );
  }

  /**
   * Perform periodic authentication check
   */
  private async performPeriodicCheck(): Promise<void> {
    try {
      logger.debug('Performing periodic authentication check...');
      
      const stats = this.getCacheStats();
      logger.debug('Auth cache stats', stats);
      
      // Clean expired entries
      if (stats.expiredEntries > 0) {
        await this.cleanExpiredEntries();
      }
      
      // Check for critical authentication issues
      const issues = await this.checkForAuthIssues();
      if (issues.hasIssues) {
        logger.warn('Authentication issues detected during periodic check', {
          issues: issues.issues,
        });
      }
      
    } catch (error) {
      logger.error('Periodic authentication check failed', {
        error: (error as Error).message,
      });
    }
  }

  /**
   * Validate stored authentication for a service
   */
  private async validateStoredAuth(service: string): Promise<boolean> {
    try {
      const result = await this.authVerifier.verifyServiceAuth(service as 'gemini' | 'aistudio' | 'claude');
      return result.success;
    } catch {
      return false;
    }
  }

  /**
   * Check if cached authentication status is still valid
   */
  private isCacheValid(service: string): boolean {
    const cached = this.authCache.get(service);
    if (!cached) {
      return false;
    }
    
    const age = Date.now() - cached.timestamp;
    return age < this.CACHE_TTL;
  }

  /**
   * Clean expired entries from cache
   */
  private async cleanExpiredEntries(): Promise<void> {
    const expiredServices: string[] = [];
    
    for (const [service, _status] of this.authCache.entries()) {
      if (!this.isCacheValid(service)) {
        expiredServices.push(service);
      }
    }
    
    for (const service of expiredServices) {
      this.authCache.delete(service);
    }
    
    if (expiredServices.length > 0) {
      logger.debug('Cleaned expired auth cache entries', {
        expiredServices,
        count: expiredServices.length,
      });
    }
  }

  /**
   * Get detailed authentication report
   */
  async getAuthReport(): Promise<{
    summary: {
      totalServices: number;
      authenticatedServices: number;
      issuesFound: number;
    };
    services: Record<string, {
      isAuthenticated: boolean;
      method: string;
      status: string;
      cacheAge?: number;
    }>;
    issues: string[];
    recommendations: string[];
  }> {
    const services = ['gemini', 'aistudio', 'claude'] as const;
    const serviceDetails: Record<string, {
      isAuthenticated: boolean;
      method: string;
      status: string;
      cacheAge?: number;
    }> = {};
    
    for (const service of services) {
      const status = await this.getAuthStatus(service);
      const cached = this.authCache.get(service);
      
      serviceDetails[service] = {
        isAuthenticated: status.isAuthenticated,
        method: status.method,
        status: status.isAuthenticated ? 'OK' : 'Not Authenticated',
        ...(cached ? { cacheAge: Date.now() - cached.timestamp } : {}),
      };
    }
    
    const issues = await this.checkForAuthIssues();
    
    return {
      summary: {
        totalServices: services.length,
        authenticatedServices: Object.values(serviceDetails).filter(s => s.isAuthenticated).length,
        issuesFound: issues.issues.length,
      },
      services: serviceDetails,
      issues: issues.issues,
      recommendations: issues.recommendations,
    };
  }
}