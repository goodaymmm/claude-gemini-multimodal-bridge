import { execSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { join, normalize } from 'path';
import { homedir } from 'os';

/**
 * Cross-platform utility functions for CGMB
 * Handles Windows/Unix differences transparently
 */

const isWindows = process.platform === 'win32';

/**
 * Find executable path for a command (cross-platform)
 * @param command - Command name to find (e.g., 'gemini', 'claude')
 * @returns Full path to executable or undefined if not found
 */
export function findExecutable(command: string): string | undefined {
  try {
    const cmd = isWindows
      ? `where ${command} 2>nul`
      : `which ${command} 2>/dev/null`;

    const output = execSync(cmd, {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    // Return first line (Windows 'where' may return multiple paths)
    return output.split('\n')[0]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Check if a command exists (cross-platform)
 * @param command - Command name to check
 * @returns true if command exists
 */
export function commandExists(command: string): boolean {
  try {
    const cmd = isWindows
      ? `where ${command} 2>nul`
      : `which ${command} 2>/dev/null`;

    execSync(cmd, { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get home directory (cross-platform)
 * @returns Home directory path
 */
export function getHomeDir(): string {
  // Try Node.js homedir() first (most reliable)
  const home = homedir();
  if (home) {
    return home;
  }

  // Fallback to environment variables
  if (isWindows) {
    return process.env.USERPROFILE || process.env.HOME || 'C:\\Users\\Default';
  }
  return process.env.HOME || '/home';
}

/**
 * Get config directory (cross-platform)
 * @returns Config directory path
 */
export function getConfigDir(): string {
  if (isWindows) {
    // Windows: %APPDATA%\claude-code or %USERPROFILE%\.config\claude-code
    const appData = process.env.APPDATA;
    if (appData) {
      return join(appData, 'claude-code');
    }
    return join(getHomeDir(), '.config', 'claude-code');
  }
  // Unix: ~/.config/claude-code
  return join(getHomeDir(), '.config', 'claude-code');
}

/**
 * Ensure directory exists, create if not (cross-platform)
 * @param dir - Directory path to ensure exists
 */
export function ensureDirectory(dir: string): void {
  const normalizedDir = normalize(dir);
  if (!existsSync(normalizedDir)) {
    mkdirSync(normalizedDir, { recursive: true });
  }
}

/**
 * Ensure output directory exists and return full path
 * @param type - Output type (images, audio, video, documents)
 * @returns Full path to output directory
 */
export function ensureOutputDirectory(type: 'images' | 'audio' | 'video' | 'documents'): string {
  const baseDir = process.cwd();
  const outputDir = join(baseDir, 'output', type);
  ensureDirectory(outputDir);
  return outputDir;
}

/**
 * Normalize output path (cross-platform)
 * @param relativePath - Relative path to normalize
 * @returns Normalized absolute path
 */
export function normalizeOutputPath(relativePath: string): string {
  return normalize(join(process.cwd(), relativePath));
}

/**
 * Get default executable path for a tool
 * @param tool - Tool name (gemini, claude)
 * @returns Default path or just the command name
 */
export function getDefaultExecutablePath(tool: 'gemini' | 'claude'): string {
  if (isWindows) {
    // On Windows, rely on PATH resolution
    return tool === 'gemini' ? 'gemini' : 'claude';
  }

  // Unix defaults
  const unixDefaults: Record<string, string[]> = {
    gemini: ['/usr/local/bin/gemini', '/opt/homebrew/bin/gemini'],
    claude: ['claude', '/opt/homebrew/bin/claude']
  };

  const paths = unixDefaults[tool] || [];
  for (const p of paths) {
    if (existsSync(p)) {
      return p;
    }
  }

  return tool;
}

/**
 * Get spawn options for cross-platform compatibility
 * @param additionalOptions - Additional spawn options to merge
 * @returns SpawnOptions with platform-specific settings
 */
export function getSpawnOptions(additionalOptions: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...additionalOptions,
    shell: isWindows
  };
}

/**
 * Find processes by name (cross-platform)
 * @param processName - Process name to search for
 * @returns Array of process info or empty array
 */
export function findProcesses(processName: string): string[] {
  try {
    if (isWindows) {
      // Windows: use tasklist
      const output = execSync(
        `tasklist /FI "IMAGENAME eq node.exe" /FO CSV 2>nul`,
        { encoding: 'utf8', timeout: 5000 }
      );

      // Filter lines containing the process name
      return output
        .split('\n')
        .filter(line => line.toLowerCase().includes(processName.toLowerCase()));
    } else {
      // Unix: use pgrep
      const output = execSync(
        `pgrep -f "${processName}" || true`,
        { encoding: 'utf8', timeout: 5000 }
      );

      return output.split('\n').filter(line => line.trim());
    }
  } catch {
    return [];
  }
}

/**
 * Check if platform is Windows
 */
export function isPlatformWindows(): boolean {
  return isWindows;
}

/**
 * Get npm global directory (cross-platform)
 * @returns npm global directory path
 */
export function getNpmGlobalDir(): string {
  if (isWindows) {
    return join(process.env.APPDATA || '', 'npm');
  }
  return '/usr/local/lib/node_modules';
}

/**
 * Normalize path for cross-platform compatibility (always uses forward slashes)
 * Use this for JSON responses, URLs, and cross-platform consistency
 * @param filePath - Path to normalize
 * @returns Normalized path with forward slashes
 */
export function normalizeCrossPlatformPath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

/**
 * Convert to platform-native path separators
 * Use this for filesystem operations
 * @param filePath - Cross-platform path (with forward slashes)
 * @returns Native platform path
 */
export function toPlatformPath(filePath: string): string {
  if (isWindows) {
    return filePath.replace(/\//g, '\\');
  }
  return filePath;
}

/**
 * Resolve and normalize output path with both formats
 * @param relativePath - Relative path from cwd (e.g., 'output/images/file.png')
 * @returns Object with normalized (cross-platform), absolute, and native paths
 */
export function resolveOutputPath(relativePath: string): {
  normalized: string;
  absolute: string;
  native: string;
} {
  const normalizedRelative = normalizeCrossPlatformPath(relativePath);
  const absolutePath = join(process.cwd(), ...normalizedRelative.split('/'));
  return {
    normalized: normalizedRelative,
    absolute: absolutePath,
    native: absolutePath // join() already produces native separators
  };
}

/**
 * Check if a path is a URL
 * @param path - Path to check
 * @returns true if path is a URL
 */
export function isUrl(path: string): boolean {
  return path.startsWith('http://') || path.startsWith('https://');
}
