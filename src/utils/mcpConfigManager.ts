import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'fs';
import { mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { logger } from './logger.js';

/**
 * MCP Configuration Manager
 * Safely manages Claude Code MCP server configurations without overwriting existing settings
 */

export interface MCPServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface MCPConfiguration {
  mcpServers: Record<string, MCPServerConfig>;
}

export interface ConfigManagerResult {
  success: boolean;
  message: string;
  backupPath?: string | undefined;
  configPath?: string | undefined;
  action?: 'added' | 'updated' | 'skipped' | 'error' | undefined;
}

export class MCPConfigManager {
  private readonly CONFIG_PATHS = [
    // Claude Code configuration locations (common paths)
    join(homedir(), '.claude-code', 'mcp_servers.json'),
    join(homedir(), '.config', 'claude-code', 'mcp_servers.json'),
    join(homedir(), '.claude', 'mcp_servers.json'),
    join(homedir(), 'Library', 'Application Support', 'Claude Code', 'mcp_servers.json'),
    // Windows paths
    join(homedir(), 'AppData', 'Roaming', 'Claude Code', 'mcp_servers.json'),
    join(homedir(), 'AppData', 'Local', 'Claude Code', 'mcp_servers.json'),
  ];

  private readonly CGMB_SERVER_NAME = 'claude-gemini-multimodal-bridge';

  /**
   * Find the Claude Code MCP configuration file
   */
  private findConfigPath(): string | null {
    for (const path of this.CONFIG_PATHS) {
      if (existsSync(path)) {
        logger.debug('Found MCP config file', { path });
        return path;
      }
    }
    
    // Return the most likely default path for creation
    const defaultPath = this.CONFIG_PATHS[0];
    if (!defaultPath) {
      return null;
    }
    logger.debug('No existing MCP config found, will use default', { path: defaultPath });
    return defaultPath;
  }

  /**
   * Read existing MCP configuration
   */
  private readExistingConfig(configPath: string): MCPConfiguration {
    if (!existsSync(configPath)) {
      return { mcpServers: {} };
    }

    try {
      const content = readFileSync(configPath, 'utf8');
      const parsed = JSON.parse(content);
      
      // Ensure the structure is correct
      if (!parsed.mcpServers) {
        parsed.mcpServers = {};
      }
      
      return parsed as MCPConfiguration;
    } catch (error) {
      logger.warn('Failed to parse existing MCP config, starting with empty config', {
        error: (error as Error).message,
        configPath
      });
      return { mcpServers: {} };
    }
  }

  /**
   * Create backup of existing configuration
   */
  private createBackup(configPath: string): string | null {
    if (!existsSync(configPath)) {
      return null;
    }

    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = `${configPath}.backup.${timestamp}`;
      copyFileSync(configPath, backupPath);
      
      logger.info('Created configuration backup', {
        original: configPath,
        backup: backupPath
      });
      
      return backupPath;
    } catch (error) {
      logger.error('Failed to create backup', {
        error: (error as Error).message,
        configPath
      });
      return null;
    }
  }

  /**
   * Generate CGMB server configuration
   */
  private generateCGMBConfig(): MCPServerConfig {
    // Try to find the CGMB installation
    const possiblePaths = [
      // Current project (development)
      process.cwd(),
      // Global npm installation
      join(homedir(), '.npm-global', 'lib', 'node_modules', 'claude-gemini-multimodal-bridge'),
      join('/usr', 'local', 'lib', 'node_modules', 'claude-gemini-multimodal-bridge'),
      // Alternative global paths
      join('/usr', 'lib', 'node_modules', 'claude-gemini-multimodal-bridge'),
    ];

    let cgmbPath = '';
    
    // Find the best path
    for (const path of possiblePaths) {
      const distPath = join(path, 'dist', 'index.js');
      if (existsSync(distPath)) {
        cgmbPath = distPath;
        break;
      }
    }

    if (!cgmbPath) {
      // Fallback to npx
      return {
        command: 'npx',
        args: ['claude-gemini-multimodal-bridge'],
        env: {
          NODE_ENV: 'production'
        }
      };
    }

    return {
      command: 'node',
      args: [cgmbPath],
      env: {
        NODE_ENV: 'production'
      }
    };
  }

  /**
   * Check if CGMB is already configured
   */
  async checkCGMBConfiguration(): Promise<{
    isConfigured: boolean;
    configPath: string | null;
    currentConfig?: MCPServerConfig | undefined;
  }> {
    const configPath = this.findConfigPath();
    
    if (!configPath || !existsSync(configPath)) {
      return {
        isConfigured: false,
        configPath
      };
    }

    const existingConfig = this.readExistingConfig(configPath);
    const cgmbConfig = existingConfig.mcpServers[this.CGMB_SERVER_NAME];

    const result: {
      isConfigured: boolean;
      configPath: string | null;
      currentConfig?: MCPServerConfig | undefined;
    } = {
      isConfigured: !!cgmbConfig,
      configPath,
    };

    if (cgmbConfig) {
      result.currentConfig = cgmbConfig;
    }

    return result;
  }

  /**
   * Add CGMB configuration safely
   */
  async addCGMBConfiguration(options: {
    force?: boolean;
    skipBackup?: boolean;
    dryRun?: boolean;
  } = {}): Promise<ConfigManagerResult> {
    const { force = false, skipBackup = false, dryRun = false } = options;

    try {
      const configPath = this.findConfigPath();
      if (!configPath) {
        return {
          success: false,
          message: 'Could not determine Claude Code configuration path',
          action: 'error'
        };
      }

      // Read existing configuration
      const existingConfig = this.readExistingConfig(configPath);
      
      // Check if CGMB is already configured
      if (existingConfig.mcpServers[this.CGMB_SERVER_NAME] && !force) {
        return {
          success: true,
          message: 'CGMB is already configured in Claude Code MCP settings',
          configPath,
          action: 'skipped'
        };
      }

      if (dryRun) {
        const cgmbConfig = this.generateCGMBConfig();
        return {
          success: true,
          message: `Would add CGMB configuration to ${configPath}`,
          configPath,
          action: force ? 'updated' : 'added'
        };
      }

      // Create backup if config exists and backup is not skipped
      let backupPath: string | null = null;
      if (existsSync(configPath) && !skipBackup) {
        backupPath = this.createBackup(configPath);
        if (!backupPath) {
          return {
            success: false,
            message: 'Failed to create backup of existing configuration',
            action: 'error'
          };
        }
      }

      // Ensure directory exists
      const configDir = dirname(configPath);
      if (!existsSync(configDir)) {
        await mkdir(configDir, { recursive: true });
        logger.info('Created configuration directory', { path: configDir });
      }

      // Generate CGMB configuration
      const cgmbConfig = this.generateCGMBConfig();
      
      // Add CGMB configuration to existing config
      existingConfig.mcpServers[this.CGMB_SERVER_NAME] = cgmbConfig;

      // Write updated configuration
      const configContent = JSON.stringify(existingConfig, null, 2);
      writeFileSync(configPath, configContent, 'utf8');

      const action = existingConfig.mcpServers[this.CGMB_SERVER_NAME] ? 'updated' : 'added';
      
      logger.info('Successfully updated Claude Code MCP configuration', {
        configPath,
        backupPath,
        action,
        cgmbConfig
      });

      return {
        success: true,
        message: `Successfully ${action} CGMB configuration in Claude Code`,
        configPath,
        backupPath: backupPath !== null ? backupPath : undefined,
        action
      };

    } catch (error) {
      logger.error('Failed to add CGMB configuration', {
        error: (error as Error).message
      });

      return {
        success: false,
        message: `Failed to update MCP configuration: ${(error as Error).message}`,
        action: 'error'
      };
    }
  }

  /**
   * Remove CGMB configuration
   */
  async removeCGMBConfiguration(options: {
    skipBackup?: boolean;
    dryRun?: boolean;
  } = {}): Promise<ConfigManagerResult> {
    const { skipBackup = false, dryRun = false } = options;

    try {
      const configPath = this.findConfigPath();
      
      if (!configPath || !existsSync(configPath)) {
        return {
          success: true,
          message: 'No MCP configuration file found',
          action: 'skipped'
        };
      }

      const existingConfig = this.readExistingConfig(configPath);
      
      if (!existingConfig.mcpServers[this.CGMB_SERVER_NAME]) {
        return {
          success: true,
          message: 'CGMB is not configured in Claude Code MCP settings',
          configPath,
          action: 'skipped'
        };
      }

      if (dryRun) {
        return {
          success: true,
          message: `Would remove CGMB configuration from ${configPath}`,
          configPath,
          action: 'updated'
        };
      }

      // Create backup
      let backupPath: string | null = null;
      if (!skipBackup) {
        backupPath = this.createBackup(configPath);
      }

      // Remove CGMB configuration
      delete existingConfig.mcpServers[this.CGMB_SERVER_NAME];

      // Write updated configuration
      const configContent = JSON.stringify(existingConfig, null, 2);
      writeFileSync(configPath, configContent, 'utf8');

      logger.info('Successfully removed CGMB from Claude Code MCP configuration', {
        configPath,
        backupPath
      });

      return {
        success: true,
        message: 'Successfully removed CGMB configuration from Claude Code',
        configPath,
        backupPath: backupPath !== null ? backupPath : undefined,
        action: 'updated'
      };

    } catch (error) {
      logger.error('Failed to remove CGMB configuration', {
        error: (error as Error).message
      });

      return {
        success: false,
        message: `Failed to remove MCP configuration: ${(error as Error).message}`,
        action: 'error'
      };
    }
  }

  /**
   * Get configuration status and recommendations
   */
  async getConfigurationStatus(): Promise<{
    isConfigured: boolean;
    configPath: string | null;
    currentConfig?: MCPServerConfig | undefined;
    recommendations: string[];
    issues: string[];
  }> {
    const status = await this.checkCGMBConfiguration();
    const recommendations: string[] = [];
    const issues: string[] = [];

    if (!status.isConfigured) {
      recommendations.push('Run "cgmb setup-mcp" to configure Claude Code MCP integration');
      issues.push('CGMB is not configured as an MCP server in Claude Code');
    } else {
      recommendations.push('CGMB MCP integration is properly configured');
      
      // Validate current configuration
      if (status.currentConfig) {
        const config = status.currentConfig;
        
        if (config.command === 'npx') {
          recommendations.push('Consider installing CGMB globally for better performance');
        }
        
        if (!config.env || !config.env.NODE_ENV) {
          issues.push('Missing environment variables in MCP configuration');
        }
      }
    }

    return {
      ...status,
      recommendations,
      issues
    };
  }

  /**
   * Generate manual setup instructions
   */
  generateManualSetupInstructions(): string {
    const cgmbConfig = this.generateCGMBConfig();
    
    return `
# Manual Claude Code MCP Setup Instructions

## 1. Find your Claude Code configuration directory
Common locations:
- ~/.claude-code/
- ~/.config/claude-code/
- ~/Library/Application Support/Claude Code/ (macOS)
- ~/AppData/Roaming/Claude Code/ (Windows)

## 2. Create or edit mcp_servers.json
Add the following configuration to your mcp_servers.json file:

\`\`\`json
{
  "mcpServers": {
    "${this.CGMB_SERVER_NAME}": {
      "command": "${cgmbConfig.command}",
      "args": ${JSON.stringify(cgmbConfig.args, null, 2)},
      "env": ${JSON.stringify(cgmbConfig.env, null, 2)}
    }
  }
}
\`\`\`

## 3. Restart Claude Code
After saving the configuration, restart Claude Code to load the new MCP server.

## 4. Verify connection
Run: cgmb verify
Then check if CGMB tools are available in Claude Code.
`;
  }
}

/**
 * Convenient functions for common operations
 */

export async function setupCGMBMCP(options: {
  force?: boolean;
  interactive?: boolean;
  dryRun?: boolean;
} = {}): Promise<ConfigManagerResult> {
  const manager = new MCPConfigManager();
  
  if (options.interactive) {
    // Interactive setup would go here
    // For now, just use the automatic setup
  }
  
  return manager.addCGMBConfiguration({
    force: options.force || false,
    dryRun: options.dryRun || false
  });
}

export async function getMCPStatus() {
  const manager = new MCPConfigManager();
  return manager.getConfigurationStatus();
}

export function getManualSetupInstructions(): string {
  const manager = new MCPConfigManager();
  return manager.generateManualSetupInstructions();
}