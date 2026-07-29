import { config } from 'dotenv';
import { existsSync, realpathSync, statSync } from 'fs';
import { findExecutable } from './platformUtils.js';
import { homedir, userInfo } from 'os';
import { dirname, isAbsolute, join, resolve } from 'path';
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
    // Wrapped like steps 3-5: one leg of the search failing should narrow the
    // search, not stop the environment from loading at all.
    try {
      for (const ancestor of this.ancestorsUpToProjectRoot(process.cwd())) {
        if (!paths.includes(ancestor)) {
          paths.push(ancestor);
        }
      }
    } catch (error) {
      // Ignore errors walking up from the working directory
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
   * One path, in the form comparisons can be made on.
   *
   * Symlinks are resolved because a home directory is often one, and Windows
   * comparisons ignore case because C:\Users\x and c:\users\x are the same
   * directory. A path that does not exist is left as resolved -- realpath
   * cannot answer for it, and it cannot be the home directory either.
   */
  private static canonical(target: string): string {
    let path = resolve(target);
    try {
      path = realpathSync(path);
    } catch {
      // not on disk; the resolved form is the best available
    }
    return process.platform === 'win32' ? path.toLowerCase() : path;
  }

  /**
   * Whether two paths name the same directory on disk.
   *
   * Comparing canonical paths is not enough. realpath resolves symlinks but
   * says nothing about bind mounts: mount /home/u at /mnt/u and the two paths
   * stay distinct while being one directory. Reproduced in a user namespace --
   * a walk entered through the alias put the home directory on the search list
   * and read its .env, which is the credential boundary this ceiling exists to
   * hold.
   *
   * The inode identity is POSIX-only on purpose. Windows fs.Stats does not
   * populate dev/ino dependably, and the aliases Windows does offer --
   * junctions and symlinks -- are already collapsed by realpath.
   */
  static sameDirectory(a: string, b: string): boolean {
    if (SmartEnvLoader.canonical(a) === SmartEnvLoader.canonical(b)) {
      return true;
    }

    if (process.platform === 'win32') {
      return false;
    }

    try {
      const left = statSync(a);
      const right = statSync(b);
      return left.dev === right.dev && left.ino === right.ino;
    } catch {
      // One of them is not on disk, so it is not the home directory.
      return false;
    }
  }

  /**
   * The home directory to use as a ceiling, or undefined if there is none.
   *
   * homedir() used to be a default parameter, which meant it ran before the
   * function body and its result went unchecked. Two ways that hurt: with
   * HOME='' it returns '', and resolve('') is the working directory -- so the
   * ceiling became cwd and the walk stopped before it started, losing a real
   * project's .env one level up. And in a container running as an arbitrary UID
   * with no passwd entry, homedir() throws outright, which took down the whole
   * environment load before it could even look at the variables already set.
   *
   * Anything relative or blank is rejected for the same reason: it would
   * resolve against cwd. When nothing usable turns up the caller gets
   * undefined and does not walk at all -- without a ceiling there is no safe
   * place to stop, and the working directory is still searched regardless.
   */
  private resolveHomeDirectory(explicit?: string): string | undefined {
    const candidates = [
      () => explicit,
      () => homedir(),
      () => userInfo().homedir,
    ];

    for (const candidate of candidates) {
      let value: string | undefined;
      try {
        value = candidate();
      } catch {
        continue; // no passwd entry, or no HOME to fall back on
      }

      const trimmed = value?.trim();
      if (trimmed && isAbsolute(trimmed)) {
        return trimmed;
      }
    }

    return undefined;
  }

  /**
   * Directories between `start` and the project root that contains it.
   *
   * A project root holds package.json or .git -- the markers every other tool
   * uses. The walk stops there rather than continuing upward, and returns
   * nothing when it finds none: without a marker there is nothing to say where
   * a project would even begin.
   *
   * The home directory is a hard ceiling, checked before the marker. Stopping
   * at "the first marker" alone was not enough, because that marker can be the
   * home directory itself -- ~/.git is an ordinary dotfiles setup, and measured
   * with it in place, a run from ~/scratch/subdir put ~ on the search list and
   * loaded ~/.env. That crosses a credential boundary: another project's
   * AI_STUDIO_API_KEY would be billed silently, and its CGMB_ALLOWED_ROOTS
   * would widen which files may be uploaded to Google. A project that genuinely
   * lives at ~ gets nothing from this walk, which is the safe direction to
   * fail: the working directory is still searched, and the path can be set
   * explicitly.
   *
   * `start` itself is excluded; the caller already searched it.
   */
  ancestorsUpToProjectRoot(start: string, home?: string): string[] {
    const ceiling = this.resolveHomeDirectory(home);
    if (ceiling === undefined) {
      return [];
    }

    const from = resolve(start);
    const ancestors: string[] = [];
    let current = from;

    while (current !== dirname(current)) {
      if (SmartEnvLoader.sameDirectory(current, ceiling)) {
        return [];
      }

      if (current !== from) {
        ancestors.push(current);
      }

      if (existsSync(join(current, 'package.json')) || existsSync(join(current, '.git'))) {
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