import { config } from 'dotenv';
import { existsSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { logger } from './logger.js';

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
    const searchPaths = options.searchPaths ?? await this.getDefaultSearchPaths();
    
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
          const result = config({ path: envPath });
          
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
            hasGeminiKey: !!process.env.GEMINI_API_KEY,
            hasClaudeKey: !!process.env.CLAUDE_API_KEY
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
  private async getDefaultSearchPaths(): Promise<string[]> {
    const paths: string[] = [];

    // Where the user is, and the project they are in. Nothing else by default.
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

    const projectRoot = await this.findProjectRoot();
    if (projectRoot && !paths.includes(projectRoot)) {
      paths.push(projectRoot);
    }

    return paths;
  }

  /**
   * Find project root by looking for package.json
   */
  private async findProjectRoot(startPath: string = process.cwd()): Promise<string | null> {
    let currentPath = startPath;
    
    while (currentPath !== dirname(currentPath)) { // Stop at filesystem root
      const packageJsonPath = join(currentPath, 'package.json');
      if (existsSync(packageJsonPath)) {
        try {
          const pkg = await import(packageJsonPath, { assert: { type: 'json' } });
          // Check if this looks like the CGMB project
          if (pkg.default?.name === 'claude-gemini-multimodal-bridge' || 
              pkg.default?.bin?.cgmb) {
            return currentPath;
          }
        } catch {
          // If we can't read package.json, continue searching
        }
      }
      currentPath = dirname(currentPath);
    }
    
    return null;
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
    // Check for at least one of the key environment variables
    const requiredVars = [
      'GEMINI_API_KEY',
      'GOOGLE_AI_STUDIO_API_KEY',
      'CLAUDE_API_KEY'
    ];

    return requiredVars.some(varName => !!process.env[varName]);
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
    const importantVars = [
      'GEMINI_API_KEY',
      'GOOGLE_AI_STUDIO_API_KEY', 
      'CLAUDE_API_KEY',
      'CLAUDE_CODE_PATH',
      'GEMINI_CLI_PATH',
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