import winston from 'winston';
import { firstLineForLog, redactUrls } from '../core/types.js';

// ===================================
// Logging Utility
// ===================================

export interface LoggerConfig {
  level: string;
  file?: string;
  console: boolean;
  json: boolean;
}

/** winston's npm levels, most to least severe. */
export const LOG_LEVELS = ['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly'] as const;
export type LogLevel = typeof LOG_LEVELS[number];

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value);
}

class Logger {
  private logger: winston.Logger;
  private static instance: Logger | null;
  private static quietInstance: Logger | null;

  private constructor(config: LoggerConfig) {
    const transports: winston.transport[] = [];

    // Every level goes to stderr, never stdout.
    //
    // CGMB's main mode of operation is an MCP server speaking JSON-RPC over
    // stdio, where stdout is the protocol channel: a single log line written
    // there is a parse error for the host. This transport used to force all
    // levels to stdout (`stderrLevels: []`) for CLI readability, and the only
    // thing standing between that and a broken server was the MCP registration
    // happening to carry NODE_ENV=production, which disabled the transport
    // entirely. Measured without it: 86 of 87 stdout lines were log output.
    //
    // stderr costs the CLI nothing -- its human-facing output goes through
    // console.log, not through this logger -- and it is where MCP hosts look
    // for diagnostics.
    if (config.console) {
      transports.push(
        new winston.transports.Console({
          stderrLevels: ['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly'],
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
      // Enhanced environment variable control for debugging
      const debugMode = process.env.CGMB_DEBUG === 'true';
      const cliMode = process.env.CGMB_CLI_MODE === 'true';
      const productionMode = process.env.NODE_ENV === 'production';
      
      // Determine log level with priority: CGMB_DEBUG > LOG_LEVEL > defaults
      let logLevel = 'info';
      if (debugMode) {
        logLevel = 'debug';
      } else if (process.env.LOG_LEVEL) {
        logLevel = process.env.LOG_LEVEL;
      } else if (cliMode) {
        logLevel = 'warn'; // Reduce noise for CLI commands
      } else if (productionMode) {
        logLevel = 'info';
      }

      const defaultConfig: LoggerConfig = {
        level: logLevel,
        ...(process.env.LOG_FILE && { file: process.env.LOG_FILE }),
        // Always on, now that it writes to stderr.
        //
        // This was `!productionMode || debugMode`, which silenced the console
        // transport entirely under the NODE_ENV=production that MCP
        // registrations carry -- so a server that was misbehaving produced no
        // diagnostics at all, and `cgmb serve --debug` printed nothing. The
        // reason to suppress it was stdout pollution, which no longer applies.
        // Volume is controlled by `level`.
        console: true,
        json: productionMode && !debugMode,
      };
      Logger.instance = new Logger(config ?? defaultConfig);
    }
    return Logger.instance;
  }

  // Create a quieter logger for CLI commands to reduce noise
  public static getQuietInstance(): Logger {
    if (!Logger.quietInstance) {
      const quietConfig: LoggerConfig = {
        level: 'warn', // Only show warnings and errors for CLI
        console: true,
        json: false,
      };
      Logger.quietInstance = new Logger(quietConfig);
    }
    return Logger.quietInstance;
  }

  // Force reset logger instance for CLI commands
  public static resetForCLI(): void {
    Logger.instance = null;
    Logger.quietInstance = null;
    process.env.LOG_LEVEL = 'warn';
  }

  /**
   * Change this logger's level after it has been built.
   *
   * The exported `logger` is created when this module is first imported,
   * which in the CLI is before commander has parsed anything. `--debug` used
   * to set LOG_LEVEL / CGMB_DEBUG inside the command's action -- by then the
   * level had already been read, so the flag changed nothing. This is the
   * runtime switch the CLI calls instead.
   */
  public setLevel(level: LogLevel): void {
    this.logger.level = level;
    for (const transport of this.logger.transports) {
      // A transport given its own level keeps it unless told otherwise; ours
      // are created without one, but make the intent explicit.
      if (transport.level !== undefined) {
        transport.level = level;
      }
    }
  }

  public getLevel(): string {
    return this.logger.level;
  }

  public info(message: string, meta?: Record<string, unknown>): void {
    this.logger.info(message, meta);
  }

  /**
   * Log at error level. Given an Error, the line carries its message's first
   * line, URLs cut to their hosts and at most 200 characters, and the stack
   * goes to debug only (redacted the same way). winston would otherwise append
   * the whole message and stack -- which can quote signed URLs, prompts or a
   * child's output -- to stderr and LOG_FILE.
   */
  public error(message: string, error?: Error | Record<string, unknown>): void {
    if (error instanceof Error) {
      this.logger.error(message, { error: firstLineForLog(error.message) });
      if (error.stack) {
        this.logger.debug(`Error stack: ${message}`, { stack: redactUrls(error.stack) });
      }
      return;
    }
    this.logger.error(message, error);
  }

  public warn(message: string, meta?: Record<string, unknown>): void {
    this.logger.warn(message, meta);
  }

  public debug(message: string, meta?: Record<string, unknown>): void {
    this.logger.debug(message, meta);
  }

  public verbose(message: string, meta?: Record<string, unknown>): void {
    this.logger.verbose(message, meta);
  }

  // Specialized logging methods for CGMB
  public layerOperation(
    layer: string,
    operation: string,
    duration: number,
    success: boolean,
    meta?: Record<string, unknown>
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
    meta?: Record<string, unknown>
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
    meta?: Record<string, unknown>
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
    meta?: Record<string, unknown>
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
    meta?: Record<string, unknown>
  ): void {
    const logLevel = level === 'high' ? 'error' : level === 'medium' ? 'warn' : 'info';
    this.logger.log(logLevel, `Security event: ${event}`, {
      securityLevel: level,
      ...meta,
    });
  }

  // Debug helpers for development and troubleshooting
  public debugConfig(): void {
    if (process.env.CGMB_DEBUG === 'true') {
      this.debug('CGMB Debug Configuration', {
        NODE_ENV: process.env.NODE_ENV,
        LOG_LEVEL: process.env.LOG_LEVEL,
        CGMB_DEBUG: process.env.CGMB_DEBUG,
        CGMB_CLI_MODE: process.env.CGMB_CLI_MODE,
        hasAiStudioKey: !!process.env.AI_STUDIO_API_KEY,
        hasGeminiKey: !!process.env.GEMINI_API_KEY,
        currentLogLevel: this.logger.level,
      });
    }
  }

  public static getDebugStatus(): Record<string, unknown> {
    return {
      debugMode: process.env.CGMB_DEBUG === 'true',
      cliMode: process.env.CGMB_CLI_MODE === 'true',
      logLevel: process.env.LOG_LEVEL,
      nodeEnv: process.env.NODE_ENV,
      hasDebugEnv: process.env.CGMB_DEBUG !== undefined,
    };
  }
}

// Export singleton instance - use CLI-friendly logger if in CLI mode
export const logger = process.env.CGMB_CLI_MODE === 'true' 
  ? Logger.getQuietInstance() 
  : Logger.getInstance();

/**
 * Set the level of the shared `logger` at runtime, e.g. from `--debug`. Also
 * records it in LOG_LEVEL so that a logger built later starts at the same
 * level.
 */
export function setLogLevel(level: LogLevel): void {
  logger.setLevel(level);
  process.env.LOG_LEVEL = level;
}

// Export class for testing
export { Logger };