import { config } from 'dotenv';
import { existsSync } from 'fs';
import { findExecutable } from './platformUtils.js';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';
import { probeCommand } from './processUtils.js';

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
      const envPath = join(searchPath, '.env');
      
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
          // Reports the keys the decision above actually consulted. It used to
          // log hasClaudeKey, which no longer takes part in that decision --
          // and never named AI_STUDIO_API_KEY, so the diagnostic could not have
          // explained why the verdict came out the way it did.
          logger.info('Using environment variables (no .env file needed)', {
            hasAiStudioKey: !!process.env.AI_STUDIO_API_KEY,
            usingDeprecatedFallback:
              !process.env.AI_STUDIO_API_KEY &&
              (!!process.env.GOOGLE_AI_STUDIO_API_KEY || !!process.env.GEMINI_API_KEY),
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
   * Get default search paths for .env files
   */
  private async getDefaultSearchPaths(): Promise<string[]> {
    const paths: string[] = [];

    // 1. Current working directory
    paths.push(process.cwd());

    // 2. Ancestors of the working directory, up to the project root.
    //
    // Running a CLI from a subdirectory of your project is ordinary, and the
    // .env belongs at the root. Without this, a run from <proj>/subdir skipped
    // straight past <proj>/.env and -- measured -- landed on step 3, CGMB's own
    // package directory, quietly using whatever credential lived there. Not
    // finding the file would have been better than finding a different one.
    //
    // findProjectRoot below cannot serve here: it only returns a directory
    // whose package.json is CGMB itself, so a host project's root is invisible
    // to it. Different question, different answer.
    for (const ancestor of this.ancestorsUpToProjectRoot(process.cwd())) {
      if (!paths.includes(ancestor)) {
        paths.push(ancestor);
      }
    }

    // 3. Look for package.json to find project root
    const projectRoot = await this.findProjectRoot();
    if (projectRoot && projectRoot !== process.cwd()) {
      paths.push(projectRoot);
    }

    // 3. Look for CGMB installation directory (from current file location)
    try {
      const currentFileUrl = import.meta.url;
      const currentFilePath = fileURLToPath(currentFileUrl);
      const projectFromFile = this.findProjectRootFromPath(currentFilePath);
      if (projectFromFile && !paths.includes(projectFromFile)) {
        paths.push(projectFromFile);
      }
    } catch (error) {
      // Ignore errors in finding file-based project root
    }

    // 4. Global npm installation directory
    try {
      const globalDir = await this.findGlobalNpmInstallation();
      if (globalDir && !paths.includes(globalDir)) {
        paths.push(globalDir);
      }
    } catch (error) {
      // Ignore errors in finding global installation
    }

    // 5. User home directory with .cgmb subdirectory
    try {
      const homeDir = process.env.HOME || process.env.USERPROFILE;
      if (homeDir) {
        const cgmbHome = join(homeDir, '.cgmb');
        paths.push(cgmbHome);
      }
    } catch (error) {
      // Ignore errors in home directory detection
    }

    return paths;
  }

  /**
   * Directories between `start` and the project root that contains it.
   *
   * A project root is a directory holding package.json or .git -- the same
   * markers every other tool uses. The walk stops there rather than continuing
   * to the filesystem root, so a stray $HOME/.env or /.env is never picked up
   * by a run that happens to be deep in a tree. When no marker is found the
   * result is empty: nothing establishes where a "project" would even be.
   *
   * `start` itself is excluded; the caller already searched the working
   * directory.
   */
  ancestorsUpToProjectRoot(start: string): string[] {
    const ancestors: string[] = [];
    let current = start;

    while (current !== dirname(current)) {
      const isProjectRoot = existsSync(join(current, 'package.json'))
        || existsSync(join(current, '.git'));

      if (current !== start) {
        ancestors.push(current);
      }

      if (isProjectRoot) {
        return ancestors;
      }

      current = dirname(current);
    }

    return [];
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
   * Find project root from a specific file path
   */
  private findProjectRootFromPath(filePath: string): string | null {
    let currentPath = dirname(filePath);
    
    while (currentPath !== dirname(currentPath)) {
      const packageJsonPath = join(currentPath, 'package.json');
      if (existsSync(packageJsonPath)) {
        return currentPath;
      }
      currentPath = dirname(currentPath);
    }
    
    return null;
  }

  /**
   * Find global npm installation directory
   */
  private async findGlobalNpmInstallation(): Promise<string | null> {
    try {
      // Try to find global npm directory
      // Resolved and run by absolute path like every other probe: `npm` via a
      // shell resolves against PATH -- and on Windows the current directory --
      // so a repository could supply its own npm here.
      const npmRoot = (probeCommand('npm', ['root', '-g'], { timeoutMs: 5000 }) ?? '').trim();
      if (npmRoot === '') {
        return null;
      }
      
      const cgmbGlobalPath = join(npmRoot, 'claude-gemini-multimodal-bridge');
      if (existsSync(cgmbGlobalPath)) {
        return cgmbGlobalPath;
      }
    } catch (error) {
      // npm not available or command failed
    }

    // Try alternative: look for cgmb binary and trace back
    try {
      const cgmbPath = findExecutable('cgmb');
      
      if (cgmbPath) {
        // cgmb binary found, trace back to package directory
        const binDir = dirname(cgmbPath);
        const possibleProjectRoot = dirname(binDir);
        
        if (existsSync(join(possibleProjectRoot, 'package.json'))) {
          return possibleProjectRoot;
        }
      }
    } catch (error) {
      // cgmb binary not found or which command failed
    }

    return null;
  }

  /**
   * Check if required environment variables are already set
   */
  private checkEnvironmentVariables(): boolean {
    // The keys AuthVerifier actually resolves, in the order it tries them.
    //
    // AI_STUDIO_API_KEY -- the one the README tells everyone to set -- was
    // missing from this list, so anyone who exported it instead of writing a
    // .env file was told the environment had not loaded. Measured: with only
    // that variable set, this returned false.
    //
    // CLAUDE_API_KEY used to be here and is gone: nothing in src/ reads it
    // (Claude Code carries its own session auth) and .env.example dropped it
    // long ago, yet its presence alone was enough to report a configured
    // environment while the AI Studio layer had no credential at all.
    const credentialVars = [
      'AI_STUDIO_API_KEY',
      'GOOGLE_AI_STUDIO_API_KEY',  // deprecated fallback
      'GEMINI_API_KEY',            // deprecated fallback
    ];

    return credentialVars.some(varName => !!process.env[varName]);
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
    requiredVars: string[];
    deprecatedVars: string[];
    foundFiles: string[];
    errors: string[];
  } {
    // What this reports had drifted a whole migration behind what CGMB reads.
    // AI_STUDIO_API_KEY -- the only credential the README asks for -- was
    // absent, while GEMINI_CLI_PATH was shown as a healthy entry pointing at
    // the CLI Google discontinued. Someone checking their setup was told the
    // wrong things were fine and the right thing was missing.
    const requiredVars = ['AI_STUDIO_API_KEY'];

    const optionalVars = [
      'ANTIGRAVITY_MODEL',
      'ANTIGRAVITY_CLI_PATH',
      'CLAUDE_CODE_PATH',
      // Decides which directories may have their contents uploaded to Google,
      // so it belongs in any account of how this install is configured.
      'CGMB_ALLOWED_ROOTS',
      'LOG_LEVEL',
    ];

    // Listed only when actually set: naming them unconditionally invites people
    // to set a deprecated key, which is the opposite of the intent.
    const deprecatedVars = ['GOOGLE_AI_STUDIO_API_KEY', 'GEMINI_API_KEY']
      .filter(varName => !!process.env[varName]);

    const availableVars: Record<string, boolean> = {};
    [...requiredVars, ...optionalVars, ...deprecatedVars].forEach(varName => {
      availableVars[varName] = !!process.env[varName];
    });

    return {
      loaded: this.isLoaded && this.loadResult.success,
      source: this.loadResult.loadedFrom || null,
      availableVars,
      requiredVars,
      deprecatedVars,
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