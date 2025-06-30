import { config } from 'dotenv';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
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
    const searchPaths = options.searchPaths || await this.getDefaultSearchPaths();
    
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
                variablesLoaded: Object.keys(result.parsed || {}).length
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
   * Get default search paths for .env files
   */
  private async getDefaultSearchPaths(): Promise<string[]> {
    const paths: string[] = [];

    // 1. Current working directory
    paths.push(process.cwd());

    // 2. Look for package.json to find project root
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
      const npmRoot = execSync('npm root -g', { 
        encoding: 'utf8', 
        timeout: 5000,
        stdio: 'pipe'
      }).trim();
      
      const cgmbGlobalPath = join(npmRoot, 'claude-gemini-multimodal-bridge');
      if (existsSync(cgmbGlobalPath)) {
        return cgmbGlobalPath;
      }
    } catch (error) {
      // npm not available or command failed
    }

    // Try alternative: look for cgmb binary and trace back
    try {
      const cgmbPath = execSync('which cgmb', { 
        encoding: 'utf8', 
        timeout: 5000,
        stdio: 'pipe' 
      }).trim();
      
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