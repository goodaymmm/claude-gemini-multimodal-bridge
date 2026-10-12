import { config, type DotenvConfigOutput } from 'dotenv';
import { existsSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { logger } from './logger.js';

/**
 * Read one .env file into process.env without writing anything to stdout.
 *
 * CGMB's main mode is an MCP server on stdio, where stdout carries JSON-RPC and
 * nothing else. dotenv 17 started printing an "injected env" line on every
 * load unless told to be quiet, and dotenv 18 also takes ENCODING, PATH, QUIET,
 * DEBUG, OVERRIDE and FAST from DOTENV_* / DOTENV_CONFIG_* variables in the
 * environment. Its debug output goes to console.log -- stdout -- so a stray
 * DOTENV_DEBUG=true in the user's shell would corrupt the protocol, and a stray
 * DOTENV_OVERRIDE or DOTENV_PATH would change which values win or which file is
 * read. Every option is therefore pinned here: options given in code take
 * precedence over the environment ones, and these are the values dotenv 16 used.
 */
export function loadDotenvFile(path: string = resolve(process.cwd(), '.env')): DotenvConfigOutput {
  return config({
    path,
    encoding: 'utf8',
    quiet: true,
    debug: false,
    override: false,
    fast: false,
  });
}

/**
 * Every name the AI Studio key is read under, in AuthVerifier's search order:
 * the recommended one first, then the two deprecated fallbacks.
 */
export const AI_STUDIO_KEY_VARS = ['AI_STUDIO_API_KEY', 'GOOGLE_AI_STUDIO_API_KEY', 'GEMINI_API_KEY'] as const;

/** ENABLE_CACHING values that turn the search cache off. Anything else leaves it on. */
const FALSE_WORDS = new Set(['false', '0', 'no', 'off']);

/**
 * CACHE_TTL is in seconds, as the README has always documented
 * (`CACHE_TTL=3600` is an hour). Until 1.3.0 the Antigravity layer passed the
 * number to SearchCache as milliseconds, so the README's example gave a 3.6
 * second cache.
 *
 * Someone who read the code rather than the README may have set milliseconds
 * (the old default was 1800000). A value at or above this threshold -- about
 * 28 hours if it were seconds, longer than any in-memory search cache is
 * useful for -- is therefore still read as milliseconds, with a warning.
 */
export const CACHE_TTL_LEGACY_MS_THRESHOLD = 100_000;

const DEFAULT_CACHE_TTL_SECONDS = 1800; // 30 minutes
const DEFAULT_MAX_CACHE_ENTRIES = 1000;

export interface SearchCacheSettings {
  /** False when ENABLE_CACHING is false/0/no/off. Default true. */
  enabled: boolean;
  /** Entry lifetime in milliseconds, converted from CACHE_TTL. */
  ttlMs: number;
  /** MAX_CACHE_ENTRIES, a positive integer. */
  maxEntries: number;
}

/**
 * The search cache settings, read from ENABLE_CACHING, CACHE_TTL (seconds; see
 * CACHE_TTL_LEGACY_MS_THRESHOLD) and MAX_CACHE_ENTRIES. A value that is not a
 * positive number falls back to the default rather than to 0, which would make
 * every entry expire as it is written.
 */
export function searchCacheSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): SearchCacheSettings {
  const enabled = !FALSE_WORDS.has((env.ENABLE_CACHING ?? '').trim().toLowerCase());

  let ttlMs = DEFAULT_CACHE_TTL_SECONDS * 1000;
  const rawTtl = (env.CACHE_TTL ?? '').trim();
  const ttl = rawTtl === '' ? Number.NaN : Number(rawTtl);
  if (Number.isFinite(ttl) && ttl > 0) {
    if (ttl >= CACHE_TTL_LEGACY_MS_THRESHOLD) {
      ttlMs = Math.round(ttl);
      logger.warn('CACHE_TTL is in seconds; a value this large is read as milliseconds for compatibility', {
        CACHE_TTL: rawTtl,
        seconds: Math.round(ttl / 1000),
      });
    } else {
      ttlMs = Math.round(ttl * 1000);
    }
  } else if (rawTtl !== '') {
    logger.warn('CACHE_TTL is not a positive number of seconds; using the default', {
      CACHE_TTL: rawTtl,
      defaultSeconds: DEFAULT_CACHE_TTL_SECONDS,
    });
  }

  const entries = Number((env.MAX_CACHE_ENTRIES ?? '').trim() || Number.NaN);
  const maxEntries = Number.isInteger(entries) && entries > 0 ? entries : DEFAULT_MAX_CACHE_ENTRIES;

  return { enabled, ttlMs, maxEntries };
}

export interface RetryPolicy {
  /** Retries after the first attempt (ErrorHandler.retry's maxAttempts/maxRetries). */
  maxAttempts: number;
  /** Delay before the first retry, in milliseconds; later ones back off from it. */
  delay: number;
}

/** Upper bounds, so a typo cannot stall a request for hours. */
export const MAX_RETRIES_LIMIT = 10;
export const RETRY_DELAY_LIMIT_MS = 60_000;

function parseBoundedInt(raw: string | undefined, min: number, max: number): number | undefined {
  const text = (raw ?? '').trim();
  if (!/^\d+$/.test(text)) {
    return undefined;
  }
  const value = Number(text);
  return value >= min && value <= max ? value : undefined;
}

/**
 * The retry policy a layer should hand to `retry()`, with MAX_RETRIES and
 * RETRY_DELAY overriding the layer's own defaults.
 *
 * - MAX_RETRIES: retries after the first attempt, an integer 0..10. 0 means
 *   "do not retry".
 * - RETRY_DELAY: milliseconds before the first retry, an integer 0..60000;
 *   ErrorHandler.retry doubles it on each further attempt up to its maxDelay.
 *
 * A missing, malformed or out-of-range value keeps the layer's default, so a
 * layer that is tuned differently (AI Studio retries less than Claude Code)
 * keeps its tuning unless the user asks otherwise.
 */
export function retryPolicyFromEnv(defaults: RetryPolicy, env: NodeJS.ProcessEnv = process.env): RetryPolicy {
  const maxAttempts = parseBoundedInt(env.MAX_RETRIES, 0, MAX_RETRIES_LIMIT);
  const delay = parseBoundedInt(env.RETRY_DELAY, 0, RETRY_DELAY_LIMIT_MS);
  for (const [name, parsed] of [['MAX_RETRIES', maxAttempts], ['RETRY_DELAY', delay]] as const) {
    if (parsed === undefined && (env[name] ?? '').trim() !== '') {
      logger.warn(`${name} is not a valid value; using the default`, { [name]: env[name] });
    }
  }
  return {
    maxAttempts: maxAttempts ?? defaults.maxAttempts,
    delay: delay ?? defaults.delay,
  };
}

/**
 * Smart environment loader that finds .env files from multiple locations
 * Supports directory-independent execution of CGMB
 */

interface EnvLoadResult {
  success: boolean;
  loadedFrom?: string;
  foundFiles: string[];
  errors: string[];
}

export class SmartEnvLoader {
  private static instance: SmartEnvLoader;
  private isLoaded = false;
  private loadResult: EnvLoadResult = {
    success: false,
    foundFiles: [],
    errors: []
  };

  private constructor() {}

  static getInstance(): SmartEnvLoader {
    if (!SmartEnvLoader.instance) {
      SmartEnvLoader.instance = new SmartEnvLoader();
    }
    return SmartEnvLoader.instance;
  }

  /**
   * Load environment variables with smart discovery
   */
  async loadEnvironment(options: { 
    verbose?: boolean; 
    forceReload?: boolean;
    searchPaths?: string[];
  } = {}): Promise<EnvLoadResult> {
    if (this.isLoaded && !options.forceReload) {
      return this.loadResult;
    }

    const { verbose = false } = options;
    const searchPaths = options.searchPaths ?? this.getDefaultSearchPaths();
    
    this.loadResult = {
      success: false,
      foundFiles: [],
      errors: []
    };

    if (verbose) {
      logger.debug('Starting smart environment loading', {
        searchPaths: searchPaths.length,
        cwd: process.cwd()
      });
    }

    // Try loading from each search path in order
    for (const searchPath of searchPaths) {
      // An entry may name the file to read or the directory holding it. Always
      // appending '.env' turned a path that ended in .env into <file>/.env,
      // which exists nowhere -- and a search that finds nothing is silent, so
      // the only symptom was a key that appeared to be missing.
      //
      // The named file is used as given rather than via dirname(), so that
      // CGMB_ENV_PATH=<dir>/prod.env reads prod.env and not the .env beside it.
      const envPath = this.namesAFile(searchPath) ? searchPath : join(searchPath, '.env');

      if (verbose) {
        logger.debug('Checking for .env file', { path: envPath });
      }

      if (existsSync(envPath)) {
        this.loadResult.foundFiles.push(envPath);
        
        try {
          // Load this .env file
          const result = loadDotenvFile(envPath);
          
          if (result.error) {
            this.loadResult.errors.push(`Failed to load ${envPath}: ${result.error.message}`);
            if (verbose) {
              logger.warn('Failed to load .env file', { 
                path: envPath, 
                error: result.error.message 
              });
            }
          } else {
            this.loadResult.success = true;
            this.loadResult.loadedFrom = envPath;
            
            if (verbose) {
              logger.info('Successfully loaded .env file', { 
                path: envPath,
                variablesLoaded: Object.keys(result.parsed ?? {}).length
              });
            }
            
            // Successfully loaded, we can stop here
            break;
          }
        } catch (error) {
          const errorMsg = `Error loading ${envPath}: ${(error as Error).message}`;
          this.loadResult.errors.push(errorMsg);
          if (verbose) {
            logger.error('Error loading .env file', { path: envPath, error });
          }
        }
      }
    }

    // If no .env file was found, check if we have environment variables already set
    if (!this.loadResult.success) {
      const hasRequiredEnvVars = this.checkEnvironmentVariables();
      if (hasRequiredEnvVars) {
        this.loadResult.success = true;
        this.loadResult.loadedFrom = 'environment variables';
        
        if (verbose) {
          logger.info('Using environment variables (no .env file needed)', {
            hasAIStudioKey: AI_STUDIO_KEY_VARS.some(name => !!process.env[name])
          });
        }
      }
    }

    this.isLoaded = true;

    // Log final result
    if (verbose || this.loadResult.errors.length > 0) {
      logger.info('Environment loading completed', {
        success: this.loadResult.success,
        loadedFrom: this.loadResult.loadedFrom,
        foundFiles: this.loadResult.foundFiles.length,
        errors: this.loadResult.errors.length
      });
    }

    return this.loadResult;
  }

  /**
   * Does this path name the file to read, rather than a directory to look in?
   *
   * statSync rather than the name: a path ending in `.env` is the usual case
   * but not the only one, and a directory that happens to be called `.env`
   * would otherwise be read as a file.
   */
  private namesAFile(path: string): boolean {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  }

  /**
   * Get default search paths for .env files
   */
  private getDefaultSearchPaths(): string[] {
    const paths: string[] = [];

    // Where the user is. Nothing else by default.
    //
    // The list used to include the package's own installation directory, the
    // global npm directory and ~/.cgmb unconditionally -- measured on WSL, that
    // meant ~/.nvm/versions/node/v22/lib/node_modules/claude-gemini-multimodal-bridge
    // was read on every run of every project. A .env left in an installation
    // directory therefore supplied AI_STUDIO_API_KEY, billed to whoever owns
    // that key, and CGMB_ALLOWED_ROOTS, which decides which files this process
    // is willing to send to Google. Widening that silently is the serious half:
    // the user is never told the boundary moved.
    //
    // Those locations are still usable, but they have to be asked for --
    // CGMB_ENV_PATH names a file or directory explicitly.
    //
    // It goes first. Loading stops at the first file that parses, so an opt-in
    // placed after the defaults is only consulted when the working directory
    // happens to hold no .env -- which makes it look like it works in a clean
    // directory and do nothing everywhere else. Something named outright
    // outranks something inferred.
    const explicit = process.env.CGMB_ENV_PATH?.trim();
    if (explicit) {
      paths.push(explicit);
    }

    if (!paths.includes(process.cwd())) {
      paths.push(process.cwd());
    }

    // There was a third entry, the "project root": the nearest directory
    // above the working directory whose package.json named this package. Its
    // lookup imported package.json with `assert: { type: 'json' }`, which
    // Node 22 rejects (ERR_IMPORT_ATTRIBUTE_MISSING); the error was caught, so
    // it always returned null and never added anything. It is gone rather
    // than repaired, so the default search stays exactly what it has been in
    // practice: CGMB_ENV_PATH, then the working directory.

    return paths;
  }

  /**
   * Removed with the search-path narrowing above: findProjectRootFromPath and
   * findGlobalNpmInstallation existed only to add the installation and global
   * npm directories to the default list, which is exactly what must not happen
   * by default. Nothing else called them.
   */


  /**
   * Check if required environment variables are already set
   */
  private checkEnvironmentVariables(): boolean {
    // The AI Studio key, under any name AuthVerifier accepts. This list used to
    // be GEMINI_API_KEY, GOOGLE_AI_STUDIO_API_KEY and CLAUDE_API_KEY -- so the
    // recommended AI_STUDIO_API_KEY, set on its own, counted as "not
    // configured", while CLAUDE_API_KEY, which nothing in CGMB reads (Claude
    // Code signs itself in), counted as configured.
    return AI_STUDIO_KEY_VARS.some(varName => !!process.env[varName]);
  }

  /**
   * Get environment loading status
   */
  getLoadResult(): EnvLoadResult {
    return { ...this.loadResult };
  }

  /**
   * Check if environment is loaded
   */
  isEnvironmentLoaded(): boolean {
    return this.isLoaded && this.loadResult.success;
  }

  /**
   * Force reload environment
   */
  async reload(options: { verbose?: boolean; searchPaths?: string[] } = {}): Promise<EnvLoadResult> {
    this.isLoaded = false;
    return this.loadEnvironment({ ...options, forceReload: true });
  }

  /**
   * Get environment status report
   */
  getEnvironmentStatus(): {
    loaded: boolean;
    source: string | null;
    availableVars: Record<string, boolean>;
    foundFiles: string[];
    errors: string[];
  } {
    // What `cgmb info` lists. GEMINI_CLI_PATH is gone from it: the Gemini CLI
    // was retired in 1.3.0, and showing it as "Not set" invited people to set
    // a variable that is now only ever rejected. ANTIGRAVITY_CLI_PATH is its
    // successor.
    const importantVars = [
      ...AI_STUDIO_KEY_VARS,
      'ANTIGRAVITY_CLI_PATH',
      'CLAUDE_CODE_PATH',
      'LOG_LEVEL'
    ];

    const availableVars: Record<string, boolean> = {};
    importantVars.forEach(varName => {
      availableVars[varName] = !!process.env[varName];
    });

    return {
      loaded: this.isLoaded && this.loadResult.success,
      source: this.loadResult.loadedFrom || null,
      availableVars,
      foundFiles: [...this.loadResult.foundFiles],
      errors: [...this.loadResult.errors]
    };
  }
}

/**
 * Convenient function to load environment with smart discovery
 */
export async function loadEnvironmentSmart(options: {
  verbose?: boolean;
  forceReload?: boolean;
  searchPaths?: string[];
} = {}): Promise<EnvLoadResult> {
  const loader = SmartEnvLoader.getInstance();
  return loader.loadEnvironment(options);
}

/**
 * Get environment status
 */
export function getEnvironmentStatus() {
  const loader = SmartEnvLoader.getInstance();
  return loader.getEnvironmentStatus();
}