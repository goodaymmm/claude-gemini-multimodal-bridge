import { logger } from './logger.js';

/**
 * Google AI Studio API Quota Monitor
 * Tracks API usage and warns when approaching limits
 */
export class QuotaMonitor {
  private readonly FREE_TIER_LIMITS = {
    requests_per_minute: 15,
    requests_per_day: 1500,
    tokens_per_minute: 32000,
    tokens_per_day: 50000,
  };

  private readonly PAID_TIER_LIMITS = {
    requests_per_minute: 360,
    requests_per_day: 30000,
    tokens_per_minute: 120000,
    tokens_per_day: 5000000,
  };

  private usage = {
    requests_today: 0,
    requests_this_minute: 0,
    tokens_today: 0,
    tokens_this_minute: 0,
    last_reset_daily: Date.now(),
    last_reset_minute: Date.now(),
  };

  private readonly WARNING_THRESHOLDS = {
    requests_daily: 0.8,    // 80% of daily limit
    requests_minute: 0.9,   // 90% of minute limit
    tokens_daily: 0.8,      // 80% of daily token limit
    tokens_minute: 0.9,     // 90% of minute token limit
  };

  private isPaidTier = false;

  constructor(isPaidTier: boolean = false) {
    this.isPaidTier = isPaidTier;
    this.loadStoredUsage();
    this.setupPeriodicReset();
  }

  /**
   * Track API request usage
   */
  trackRequest(tokensUsed: number = 0): void {
    this.resetCountersIfNeeded();
    
    this.usage.requests_today++;
    this.usage.requests_this_minute++;
    this.usage.tokens_today += tokensUsed;
    this.usage.tokens_this_minute += tokensUsed;
    
    this.saveUsage();
    this.checkAndWarnLimits();
  }

  /**
   * Check if request can be made without exceeding limits
   */
  canMakeRequest(estimatedTokens: number = 1000): {
    allowed: boolean;
    reason?: string;
    waitTime?: number;
  } {
    this.resetCountersIfNeeded();
    
    const limits = this.isPaidTier ? this.PAID_TIER_LIMITS : this.FREE_TIER_LIMITS;
    
    // Check daily limits
    if (this.usage.requests_today >= limits.requests_per_day) {
      return {
        allowed: false,
        reason: 'Daily request limit exceeded',
        waitTime: this.getTimeUntilDailyReset(),
      };
    }
    
    if (this.usage.tokens_today + estimatedTokens > limits.tokens_per_day) {
      return {
        allowed: false,
        reason: 'Daily token limit would be exceeded',
        waitTime: this.getTimeUntilDailyReset(),
      };
    }
    
    // Check per-minute limits
    if (this.usage.requests_this_minute >= limits.requests_per_minute) {
      return {
        allowed: false,
        reason: 'Per-minute request limit exceeded',
        waitTime: this.getTimeUntilMinuteReset(),
      };
    }
    
    if (this.usage.tokens_this_minute + estimatedTokens > limits.tokens_per_minute) {
      return {
        allowed: false,
        reason: 'Per-minute token limit would be exceeded',
        waitTime: this.getTimeUntilMinuteReset(),
      };
    }
    
    return { allowed: true };
  }

  /**
   * Get current usage statistics
   */
  getUsageStats(): {
    tier: string;
    requests: {
      today: number;
      this_minute: number;
      daily_limit: number;
      minute_limit: number;
      daily_remaining: number;
      minute_remaining: number;
    };
    tokens: {
      today: number;
      this_minute: number;
      daily_limit: number;
      minute_limit: number;
      daily_remaining: number;
      minute_remaining: number;
    };
    reset_times: {
      daily_reset_in: number;
      minute_reset_in: number;
    };
  } {
    this.resetCountersIfNeeded();
    
    const limits = this.isPaidTier ? this.PAID_TIER_LIMITS : this.FREE_TIER_LIMITS;
    
    return {
      tier: this.isPaidTier ? 'paid' : 'free',
      requests: {
        today: this.usage.requests_today,
        this_minute: this.usage.requests_this_minute,
        daily_limit: limits.requests_per_day,
        minute_limit: limits.requests_per_minute,
        daily_remaining: Math.max(0, limits.requests_per_day - this.usage.requests_today),
        minute_remaining: Math.max(0, limits.requests_per_minute - this.usage.requests_this_minute),
      },
      tokens: {
        today: this.usage.tokens_today,
        this_minute: this.usage.tokens_this_minute,
        daily_limit: limits.tokens_per_day,
        minute_limit: limits.tokens_per_minute,
        daily_remaining: Math.max(0, limits.tokens_per_day - this.usage.tokens_today),
        minute_remaining: Math.max(0, limits.tokens_per_minute - this.usage.tokens_this_minute),
      },
      reset_times: {
        daily_reset_in: this.getTimeUntilDailyReset(),
        minute_reset_in: this.getTimeUntilMinuteReset(),
      },
    };
  }

  /**
   * Get quota status as percentage
   */
  getQuotaStatus(): {
    requests_daily_percent: number;
    requests_minute_percent: number;
    tokens_daily_percent: number;
    tokens_minute_percent: number;
    overall_status: 'healthy' | 'warning' | 'critical';
  } {
    this.resetCountersIfNeeded();
    
    const limits = this.isPaidTier ? this.PAID_TIER_LIMITS : this.FREE_TIER_LIMITS;
    
    const requests_daily_percent = (this.usage.requests_today / limits.requests_per_day) * 100;
    const requests_minute_percent = (this.usage.requests_this_minute / limits.requests_per_minute) * 100;
    const tokens_daily_percent = (this.usage.tokens_today / limits.tokens_per_day) * 100;
    const tokens_minute_percent = (this.usage.tokens_this_minute / limits.tokens_per_minute) * 100;
    
    let overall_status: 'healthy' | 'warning' | 'critical' = 'healthy';
    
    if (requests_daily_percent >= 90 || tokens_daily_percent >= 90 || 
        requests_minute_percent >= 95 || tokens_minute_percent >= 95) {
      overall_status = 'critical';
    } else if (requests_daily_percent >= 80 || tokens_daily_percent >= 80 || 
               requests_minute_percent >= 90 || tokens_minute_percent >= 90) {
      overall_status = 'warning';
    }
    
    return {
      requests_daily_percent,
      requests_minute_percent,
      tokens_daily_percent,
      tokens_minute_percent,
      overall_status,
    };
  }

  /**
   * Reset usage counters if time periods have passed
   */
  private resetCountersIfNeeded(): void {
    const now = Date.now();
    
    // Reset daily counter (every 24 hours)
    if (now - this.usage.last_reset_daily >= 24 * 60 * 60 * 1000) {
      this.usage.requests_today = 0;
      this.usage.tokens_today = 0;
      this.usage.last_reset_daily = now;
      logger.info('Daily quota counters reset');
    }
    
    // Reset minute counter (every minute)
    if (now - this.usage.last_reset_minute >= 60 * 1000) {
      this.usage.requests_this_minute = 0;
      this.usage.tokens_this_minute = 0;
      this.usage.last_reset_minute = now;
      logger.debug('Minute quota counters reset');
    }
  }

  /**
   * Check limits and issue warnings
   */
  private checkAndWarnLimits(): void {
    const status = this.getQuotaStatus();
    const limits = this.isPaidTier ? this.PAID_TIER_LIMITS : this.FREE_TIER_LIMITS;
    
    // Daily request warnings
    if (status.requests_daily_percent >= 90) {
      logger.warn('⚠️  API quota critical: 90%+ of daily requests used', {
        used: this.usage.requests_today,
        limit: limits.requests_per_day,
        remaining: limits.requests_per_day - this.usage.requests_today,
        resetIn: this.formatDuration(this.getTimeUntilDailyReset()),
      });
    } else if (status.requests_daily_percent >= 80) {
      logger.warn('📊 API quota warning: 80%+ of daily requests used', {
        used: this.usage.requests_today,
        limit: limits.requests_per_day,
        percent: Math.round(status.requests_daily_percent),
      });
    }
    
    // Daily token warnings
    if (status.tokens_daily_percent >= 90) {
      logger.warn('⚠️  Token quota critical: 90%+ of daily tokens used', {
        used: this.usage.tokens_today,
        limit: limits.tokens_per_day,
        remaining: limits.tokens_per_day - this.usage.tokens_today,
        resetIn: this.formatDuration(this.getTimeUntilDailyReset()),
      });
    } else if (status.tokens_daily_percent >= 80) {
      logger.warn('📊 Token quota warning: 80%+ of daily tokens used', {
        used: this.usage.tokens_today,
        limit: limits.tokens_per_day,
        percent: Math.round(status.tokens_daily_percent),
      });
    }
    
    // Per-minute warnings
    if (status.requests_minute_percent >= 95) {
      logger.warn('🚨 Rate limit critical: 95%+ of per-minute requests used', {
        used: this.usage.requests_this_minute,
        limit: limits.requests_per_minute,
        waitTime: this.formatDuration(this.getTimeUntilMinuteReset()),
      });
    }
  }

  /**
   * Get time until daily reset in milliseconds
   */
  private getTimeUntilDailyReset(): number {
    const nextReset = this.usage.last_reset_daily + (24 * 60 * 60 * 1000);
    return Math.max(0, nextReset - Date.now());
  }

  /**
   * Get time until minute reset in milliseconds
   */
  private getTimeUntilMinuteReset(): number {
    const nextReset = this.usage.last_reset_minute + (60 * 1000);
    return Math.max(0, nextReset - Date.now());
  }

  /**
   * Format duration in human-readable format
   */
  private formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    
    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }

  /**
   * Load stored usage from environment or cache
   */
  private loadStoredUsage(): void {
    // In a real implementation, this would load from persistent storage
    // For now, we start fresh each session
    logger.debug('Quota monitor initialized', {
      tier: this.isPaidTier ? 'paid' : 'free',
      limits: this.isPaidTier ? this.PAID_TIER_LIMITS : this.FREE_TIER_LIMITS,
    });
  }

  /**
   * Save current usage (placeholder for persistent storage)
   */
  private saveUsage(): void {
    // In a real implementation, this would save to persistent storage
    // For development, we could use a simple file or database
  }

  /**
   * Setup periodic reset checks
   */
  private setupPeriodicReset(): void {
    // Check every 30 seconds for resets
    setInterval(() => {
      this.resetCountersIfNeeded();
    }, 30000);
  }

  /**
   * Estimate tokens for a request
   */
  static estimateTokens(text: string, files: number = 0): number {
    // Rough estimation: 1 token ≈ 4 characters for text
    const textTokens = Math.ceil(text.length / 4);
    
    // File processing tokens (rough estimates)
    const fileTokens = files * 1000; // Assume 1000 tokens per file
    
    return textTokens + fileTokens;
  }
}

// Global quota monitor instance
let globalQuotaMonitor: QuotaMonitor | null = null;

/**
 * Get global quota monitor instance
 */
export function getQuotaMonitor(isPaidTier?: boolean): QuotaMonitor {
  if (!globalQuotaMonitor) {
    globalQuotaMonitor = new QuotaMonitor(isPaidTier);
  }
  return globalQuotaMonitor;
}

/**
 * Reset global quota monitor (for testing)
 */
export function resetQuotaMonitor(): void {
  globalQuotaMonitor = null;
}