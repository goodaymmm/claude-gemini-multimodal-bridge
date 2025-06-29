import winston from 'winston';
import path from 'path';

// ===================================
// Logging Utility
// ===================================

export interface LoggerConfig {
  level: string;
  file?: string;
  console: boolean;
  json: boolean;
}

class Logger {
  private logger: winston.Logger;
  private static instance: Logger;

  private constructor(config: LoggerConfig) {
    const transports: winston.transport[] = [];

    // Console transport
    if (config.console) {
      transports.push(
        new winston.transports.Console({
          format: config.json
            ? winston.format.json()
            : winston.format.combine(
                winston.format.colorize(),
                winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
                winston.format.printf(({ timestamp, level, message, ...meta }) => {
                  const metaStr = Object.keys(meta).length ? JSON.stringify(meta, null, 2) : '';
                  return `${timestamp} [${level}]: ${message} ${metaStr}`;
                })
              ),
        })
      );
    }

    // File transport
    if (config.file) {
      transports.push(
        new winston.transports.File({
          filename: config.file,
          format: winston.format.combine(
            winston.format.timestamp(),
            winston.format.json()
          ),
        })
      );
    }

    this.logger = winston.createLogger({
      level: config.level,
      transports,
      defaultMeta: { service: 'cgmb' },
    });
  }

  public static getInstance(config?: LoggerConfig): Logger {
    if (!Logger.instance) {
      const defaultConfig: LoggerConfig = {
        level: process.env.LOG_LEVEL || 'info',
        file: process.env.LOG_FILE,
        console: true,
        json: process.env.NODE_ENV === 'production',
      };
      Logger.instance = new Logger(config || defaultConfig);
    }
    return Logger.instance;
  }

  public info(message: string, meta?: Record<string, any>): void {
    this.logger.info(message, meta);
  }

  public error(message: string, error?: Error | Record<string, any>): void {
    this.logger.error(message, error);
  }

  public warn(message: string, meta?: Record<string, any>): void {
    this.logger.warn(message, meta);
  }

  public debug(message: string, meta?: Record<string, any>): void {
    this.logger.debug(message, meta);
  }

  public verbose(message: string, meta?: Record<string, any>): void {
    this.logger.verbose(message, meta);
  }

  // Specialized logging methods for CGMB
  public layerOperation(
    layer: string,
    operation: string,
    duration: number,
    success: boolean,
    meta?: Record<string, any>
  ): void {
    this.info(`Layer operation completed`, {
      layer,
      operation,
      duration,
      success,
      ...meta,
    });
  }

  public workflowStep(
    stepId: string,
    status: 'started' | 'completed' | 'failed',
    meta?: Record<string, any>
  ): void {
    this.info(`Workflow step ${status}`, {
      stepId,
      status,
      ...meta,
    });
  }

  public apiCall(
    service: string,
    endpoint: string,
    duration: number,
    statusCode?: number,
    meta?: Record<string, any>
  ): void {
    this.debug(`API call to ${service}`, {
      service,
      endpoint,
      duration,
      statusCode,
      ...meta,
    });
  }

  public performance(
    operation: string,
    duration: number,
    meta?: Record<string, any>
  ): void {
    this.info(`Performance metric`, {
      operation,
      duration,
      ...meta,
    });
  }

  public security(
    event: string,
    level: 'low' | 'medium' | 'high',
    meta?: Record<string, any>
  ): void {
    const logLevel = level === 'high' ? 'error' : level === 'medium' ? 'warn' : 'info';
    this.logger.log(logLevel, `Security event: ${event}`, {
      securityLevel: level,
      ...meta,
    });
  }
}

// Export singleton instance
export const logger = Logger.getInstance();

// Export class for testing
export { Logger };