#!/usr/bin/env node

import { Command } from 'commander';
import { CGMBServer } from './core/CGMBServer.js';
import { DEFAULT_ANTIGRAVITY_MODEL } from './core/types.js';
import { AGY_INSTALL_HINT, MIN_AGY_VERSION, findAntigravityBinary } from './utils/antigravityCli.js'; // eslint-disable-line sort-imports
import { logger } from './utils/logger.js';
import { loadEnvironmentSmart, getEnvironmentStatus } from './utils/envLoader.js';
import { setupCGMBMCP, getMCPStatus, getManualSetupInstructions } from './utils/mcpConfigManager.js';
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { OAuthManager } from './auth/OAuthManager.js';
import { AuthVerifier } from './auth/AuthVerifier.js';
import { InteractiveSetup } from './auth/InteractiveSetup.js';
import { AuthCache } from './auth/AuthCache.js';
import { LayerManager } from './core/LayerManager.js';
import { Logger } from './utils/logger.js';
import { TimeoutManager, withCLITimeout } from './utils/TimeoutManager.js';

// ===================================
// Helper Functions for CLI Commands
// ===================================

function showChatHelp() {
  console.log('💬 CGMB Chat - Primary interface for questions and research');
  console.log('');
  console.log('✨ Simple usage:');
  console.log('  cgmb chat "your question"');
  console.log('  cgmb c "your question"');
  console.log('');
  console.log('🔧 Advanced usage:');
  console.log('  cgmb chat "question" --model gemini-3.6-flash-low');
  console.log('  cgmb chat "question" --fast');
  console.log('');
  console.log('🌐 Web search is automatic - just ask about current events!');
  console.log('');
  console.log('📋 Task examples:');
  console.log('  cgmb chat "What are the latest AI trends in 2025?"');
  console.log('  cgmb c "Android security best practices"');
  console.log('  cgmb chat "Current cryptocurrency market status"');
  console.log('');
  console.log('🎨 For other tasks:');
  console.log('  cgmb generate-image "description"  # Create images');
  console.log('  cgmb analyze file.pdf             # Analyze documents');
  console.log('');
  console.log('❓ Having issues? Try: cgmb auth-status');
}

function showGeminiHelp() {
  console.log('🔧 CGMB Gemini - Advanced/Troubleshooting tool only');
  console.log('');
  console.log('⚠️  WARNING: This is an advanced troubleshooting command.');
  console.log('    For normal use, avoid this command and use the recommended ones below.');
  console.log('');
  console.log('✅ Recommended for normal use:');
  console.log('  cgmb chat "your question"             # Primary chat interface');
  console.log('  cgmb generate-image "description"     # Image generation');
  console.log('  cgmb analyze file.pdf                 # Document analysis');
  console.log('');
  console.log('❌ Advanced/Troubleshooting only:');
  console.log('  cgmb gemini -p "question"             # Direct CLI access');
  console.log('  cgmb gemini "question" --fast         # Performance testing');
  console.log('');
  console.log('💡 Use standard cgmb commands for reliable results!');
  console.log('🔐 Authentication issues? Try: cgmb auth-status');
}

// ===================================
// CLI Interface for CGMB
// ===================================

const program = new Command();

// Read version from package.json
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const packageJson = require('../package.json') as { version: string };

program
  .name('cgmb')
  .description('Claude-Gemini Multimodal Bridge - Enterprise-grade AI integration tool')
  .version(packageJson.version);

// Server command
program
  .command('serve')
  .description('Start the CGMB MCP server')
  .option('-c, --config <path>', 'Path to configuration file')
  .option('-v, --verbose', 'Enable verbose logging')
  .option('--debug', 'Enable debug logging')
  .action(async (options) => {
    try {
      // Set environment variables to prevent Claude Code duplication
      process.env.CGMB_SERVE_MODE = 'true';
      process.env.CGMB_NO_CLAUDE_EXEC = 'true';
      
      // Set log level first if specified
      if (options.verbose) {
        process.env.LOG_LEVEL = 'debug';
      }
      
      if (options.debug) {
        process.env.LOG_LEVEL = 'debug';
      }

      // Load environment variables with smart discovery
      const loadOptions: { verbose: boolean; searchPaths?: string[] } = { 
        verbose: options.verbose || options.debug
      };
      if (options.config) {
        loadOptions.searchPaths = [path.dirname(options.config)];
      }
      const envResult = await loadEnvironmentSmart(loadOptions);

      if (!envResult.success && envResult.errors.length > 0) {
        logger.warn('Environment loading had issues', {
          errors: envResult.errors,
          foundFiles: envResult.foundFiles
        });
      }

      if (envResult.loadedFrom) {
        logger.info('Environment loaded successfully', {
          source: envResult.loadedFrom,
          hasAIStudioKey: !!process.env.AI_STUDIO_API_KEY
        });
      }

      const server = new CGMBServer();
      await server.start();
      
      // Keep the process running with proper cleanup
      const gracefulShutdown = async () => {
        logger.info('Shutting down CGMB server...');
        try {
          if (server && typeof server.stop === 'function') {
            await server.stop();
          }
        } catch (error) {
          logger.error('Error during server shutdown', error as Error);
        }
        process.exit(0);
      };

      process.on('SIGINT', gracefulShutdown);
      process.on('SIGTERM', gracefulShutdown);
      
    } catch (error) {
      logger.error('Failed to start CGMB server', error as Error);
      process.exit(1);
    }
  });

// Setup command
program
  .command('setup')
  .description('Set up CGMB dependencies and configuration')
  .option('--force', 'Force reinstall dependencies')
  .action(async (options) => {
    try {
      logger.info('Setting up CGMB...');
      
      // Check Node.js version
      const nodeVersion = process.version;
      const requiredVersion = 'v22.0.0';
      if (nodeVersion < requiredVersion) {
        throw new Error(`Node.js ${requiredVersion} or higher is required. Current: ${nodeVersion}`);
      }
      
      logger.info('✓ Node.js version check passed');
      
      // Check for required tools
      await checkDependency('claude', 'Claude Code CLI');
      await checkAntigravityDependency();
      
      // Create configuration file if it doesn't exist
      const envPath = path.join(process.cwd(), '.env');
      if (!fs.existsSync(envPath)) {
        const examplePath = path.join(process.cwd(), '.env.example');
        if (fs.existsSync(examplePath)) {
          fs.copyFileSync(examplePath, envPath);
          logger.info('✓ Created .env configuration file');
          logger.info('Note: API keys are optional if using OAuth authentication');
        }
      }
      
      // Create logs directory
      const logsDir = path.join(process.cwd(), 'logs');
      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
        logger.info('✓ Created logs directory');
      }
      
      logger.info('Setup completed successfully!');
      logger.info('Next steps:');
      logger.info('1. Set up authentication: cgmb auth --interactive');
      logger.info('2. Verify installation: cgmb verify');
      logger.info('3. Start the server: cgmb serve');
      logger.info('');
      logger.info('💡 Tip: OAuth authentication is recommended (no API keys needed)');
      
    } catch (error) {
      logger.error('Setup failed', error as Error);
      process.exit(1);
    }
  });

// Authentication command
program
  .command('auth')
  .description('Manage authentication for all services')
  .option('--service <service>', 'Specific service to authenticate (gemini|aistudio|claude)')
  .option('--method <method>', 'Authentication method (oauth|apikey)')
  .option('--interactive', 'Interactive authentication setup')
  .option('--reset-cache', 'Reset authentication cache')
  .action(async (options) => {
    try {
      // Load environment variables
      await loadEnvironmentSmart({ verbose: false });
      
      const authManager = new OAuthManager();
      const interactiveSetup = new InteractiveSetup();
      
      logger.info('CGMB Authentication Manager');
      
      // Handle cache reset
      if (options.resetCache) {
        const authCache = AuthCache.getInstance();
        if (options.service) {
          authCache.forceRefresh(options.service as keyof typeof authCache['TTL_SETTINGS']);
          console.log(`✅ Authentication cache cleared for ${options.service}`);
        } else {
          authCache.clear();
          console.log('✅ All authentication cache cleared');
        }
        console.log('💡 Next authentication check will verify fresh credentials');
        process.exit(0);
      }
      
      if (options.interactive) {
        await interactiveSetup.runAuthSetupWizard();
      } else if (options.service) {
        logger.info(`Setting up authentication for ${options.service}...`);
        await interactiveSetup.setupServiceAuth(options.service as any);
      } else {
        logger.info('Running full authentication setup...');
        await interactiveSetup.runAuthSetupWizard();
      }
      
      // Explicit exit after authentication completion
      logger.info('Authentication setup completed successfully');
      process.exit(0);
      
    } catch (error) {
      logger.error('Authentication setup failed', error as Error);
      process.exit(1);
    }
  });

// Authentication status command
program
  .command('auth-status')
  .description('Check authentication status for all services')
  .option('--verbose', 'Show detailed authentication information')
  .action(async (options) => {
    try {
      // Load environment variables
      await loadEnvironmentSmart({ verbose: false });
      
      const verifier = new AuthVerifier();
      const result = await verifier.verifyAllAuthentications();
      
      console.log('\n🔐 Authentication Status Report\n');
      console.log('═'.repeat(50));
      
      Object.entries(result.services).forEach(([service, status]) => {
        const icon = status.success ? '✅' : '❌';
        const serviceName = service.charAt(0).toUpperCase() + service.slice(1);
        console.log(`${icon} ${serviceName}: ${status.success ? 'Authenticated' : 'Not Authenticated'}`);
        
        if (options.verbose && status.status.userInfo) {
          console.log(`   Method: ${status.status.method}`);
          console.log(`   User: ${status.status.userInfo.email || 'N/A'}`);
          if (status.status.userInfo.quotaRemaining !== undefined) {
            console.log(`   Quota: ${status.status.userInfo.quotaRemaining} requests remaining`);
          }
          if (status.status.userInfo.planType) {
            console.log(`   Plan: ${status.status.userInfo.planType}`);
          }
        }
        
        if (!status.success && status.actionInstructions) {
          console.log(`   ⚠️  Action needed: ${status.actionInstructions}`);
        }
        console.log('');
      });
      
      console.log('═'.repeat(50));
      console.log(`Overall Status: ${result.overall ? '🟢 READY' : '🟡 NEEDS ATTENTION'}`);
      
      if (result.recommendations.length > 0) {
        console.log('\n💡 Recommendations:');
        result.recommendations.forEach(rec => console.log(`   • ${rec}`));
      }
      
      console.log('');
      
      // Exit immediately after displaying results (matching image/audio generation pattern)
      process.exit(0);
      
    } catch (error) {
      logger.error('Failed to check authentication status', error as Error);
      process.exit(1);
    }
  });

// Quota status command
program
  .command('quota-status')
  .description('Check Gemini API quota usage')
  .option('--detailed', 'Show detailed information')
  .action(async (options) => {
    // Set CLI mode environment variable FIRST
    process.env.CGMB_CLI_MODE = 'true';
    
    console.log('📊 Gemini API (Generative Language API) Quota Status');
    console.log('====================================================');
    console.log();
    console.log('To check your actual API usage and quota:');
    console.log();
    console.log('1. Visit Google Cloud Console:');
    console.log('   🔗 https://console.cloud.google.com');
    console.log();
    console.log('2. Navigate to:');
    console.log('   APIs & Services → Dashboard → Generative Language API');
    console.log();
    console.log('3. View your real-time quota and usage metrics there.');
    console.log();
    console.log('📚 Official Documentation:');
    console.log('   • Rate Limits: https://ai.google.dev/gemini-api/docs/rate-limits');
    console.log('   • Pricing: https://ai.google.dev/gemini-api/docs/pricing');
    console.log();
    console.log('💡 For current free tier limits and pricing details,');
    console.log('   please refer to the official documentation above.');
    
    process.exit(0);
  });

// Path detection command
program
  .command('detect-paths')
  .description('Detect and show paths for required CLI tools')
  .option('--fix', 'Attempt to fix PATH issues automatically')
          .action(async (options) => {
          try {
            console.log('🔍 Detecting CLI Tool Paths');      console.log('===========================');
      
      const tools = [
        { name: 'Claude Code', commands: ['claude', 'claude-code'], env: 'CLAUDE_CODE_PATH' },
        { name: 'Antigravity CLI', commands: ['agy'], env: 'ANTIGRAVITY_CLI_PATH' },
        { name: 'Node.js', commands: ['node'], env: 'NODE_PATH' },
        { name: 'NPM', commands: ['npm'], env: 'NPM_PATH' }
      ];
      
      for (const tool of tools) {
        console.log(`\n${tool.name}:`);
        
        let foundPath = null;
        for (const command of tool.commands) {
          try {
            const output = execSync(`which ${command} 2>/dev/null || where ${command} 2>nul`, {
              encoding: 'utf8',
              stdio: 'pipe',
              timeout: 5000,
            });
            foundPath = output.trim().split('\n')[0];
            if (foundPath) {
              console.log(`  ✅ Found: ${foundPath}`);
              
              // Test if it works
              try {
                execSync(`${foundPath} --version 2>/dev/null || ${foundPath} -v 2>/dev/null`, {
                  stdio: 'ignore',
                  timeout: 3000,
                });
                console.log(`     Works: ✅`);
              } catch {
                console.log(`     Works: ❌ (command failed)`);
              }
              break;
            }
          } catch {
            continue;
          }
        }
        
        if (!foundPath) {
          console.log(`  ❌ Not found in PATH`);
          if (tool.env) {
            console.log(`     Set ${tool.env}=/path/to/${tool.commands[0]} in your environment`);
          }
          
          if (options.fix && tool.name === 'Gemini CLI') {
            console.log(`     💡 Install with: ${AGY_INSTALL_HINT}`);
          }
        }
      }
      
      // Check environment variables
      console.log('\n📋 Environment Variables:');
      const envVars = ['AI_STUDIO_API_KEY', 'CLAUDE_CODE_PATH', 'GEMINI_CLI_PATH'];
      for (const envVar of envVars) {
        const value = process.env[envVar];
        if (value) {
          // Mask API keys
          const displayValue = envVar.includes('API_KEY') ? 
            `${value.substring(0, 8)}...` : value;
          console.log(`  ✅ ${envVar}: ${displayValue}`);
        } else {
          console.log(`  ❌ ${envVar}: Not set`);
        }
      }
      
      // Check for deprecated environment variables and warn with specific guidance
      console.log('');
      console.log('🔧 Environment Variable Migration:');
      const deprecatedVars = [
        { old: 'GEMINI_API_KEY', new: 'AI_STUDIO_API_KEY', purpose: 'AI Studio authentication' },
        { old: 'GOOGLE_AI_STUDIO_API_KEY', new: 'AI_STUDIO_API_KEY', purpose: 'AI Studio authentication' }
      ];
      
      for (const { old, new: newVar, purpose } of deprecatedVars) {
        const value = process.env[old];
        if (value) {
          console.log(`  ⚠️  ${old}: ${value.substring(0, 8)}... (DEPRECATED)`);
          console.log(`     → Migrate to: ${newVar} (for ${purpose})`);
          console.log(`     → Add to .env: ${newVar}=${value}`);
        }
      }
      
      // Check for proper AI Studio configuration
      const hasProperAIStudioKey = !!process.env.AI_STUDIO_API_KEY;
      const hasDeprecatedKeys = deprecatedVars.some(v => !!process.env[v.old]);
      
      if (!hasProperAIStudioKey && hasDeprecatedKeys) {
        console.log('');
        console.log('🔄 Migration Required:');
        console.log('  AI Studio authentication detected using deprecated variable names.');
        console.log('  This may cause the authentication failures seen in Error.md.');
        console.log('  Please update your .env file to use AI_STUDIO_API_KEY.');
      } else if (hasProperAIStudioKey) {
        console.log('');
        console.log('✅ Environment Configuration: Using recommended variable names');
      }
      
    } catch (error) {
      logger.error('Failed to detect paths', error as Error);
      console.error('❌ Failed to detect paths:', (error as Error).message);
      process.exit(1);
    }
  });

// Setup guide command
program
  .command('setup-guide')
  .description('Show step-by-step authentication setup guide')
  .action(() => {
    const interactiveSetup = new InteractiveSetup();
    interactiveSetup.displaySetupGuide();
  });

// MCP setup command
program
  .command('setup-mcp')
  .description('Configure Claude Code MCP integration for CGMB')
  .option('--force', 'Force update existing configuration')
  .option('--dry-run', 'Show what would be done without making changes')
  .option('--manual', 'Show manual setup instructions instead of automatic setup')
  .action(async (options) => {
    try {
      // Load environment variables
      await loadEnvironmentSmart({ verbose: false });
      
      if (options.manual) {
        console.log('📋 Manual Claude Code MCP Setup Instructions');
        console.log('═'.repeat(50));
        console.log(getManualSetupInstructions());
        return;
      }
      
      console.log('🔧 Setting up Claude Code MCP integration...\n');
      
      // Check Claude Code CLI version and use appropriate method
      let claudeVersion = '';
      
      // Skip claude command execution if in serve mode to prevent duplication
      if (process.env.CGMB_NO_CLAUDE_EXEC === 'true') {
        console.log('🔄 Claude command execution skipped (serve mode protection)');
        console.log('💡 Manual setup required. See: cgmb setup-mcp --manual');
        return;
      }
      
      try {
        claudeVersion = execSync('claude --version', { encoding: 'utf8' }).trim();
        console.log(`Claude Code CLI version: ${claudeVersion}`);
      } catch (error) {
        console.log('⚠️  Could not detect Claude Code CLI version');
      }
      
      // Check if claude mcp command is available (v1.0.35+)
      let hasNewMCPCommand = false;
      
      if (process.env.CGMB_NO_CLAUDE_EXEC !== 'true') {
        try {
          execSync('claude mcp --help', { stdio: 'ignore' });
          hasNewMCPCommand = true;
          console.log('✅ Detected new Claude Code CLI with mcp command support\n');
        } catch {
          console.log('ℹ️  Using legacy MCP configuration method\n');
        }
      }
      
      // If new MCP command is available, use it instead
      if (hasNewMCPCommand && !options.force && process.env.CGMB_NO_CLAUDE_EXEC !== 'true') {
        try {
          // Check if already configured with new method
          const mcpListOutput = execSync('claude mcp list', { encoding: 'utf8' });
          if (mcpListOutput.includes('claude-gemini-multimodal-bridge')) {
            console.log('✅ CGMB is already configured in Claude Code MCP');
            console.log('\nCurrent configuration:');
            const mcpGetOutput = execSync('claude mcp get claude-gemini-multimodal-bridge', { encoding: 'utf8' });
            console.log(mcpGetOutput);
            
            if (!options.force) {
              console.log('\n💡 To reconfigure, use: cgmb setup-mcp --force');
              return;
            }
          }
          
          // Add CGMB using new method
          console.log('Adding CGMB to Claude Code using new MCP command...');
          const addCommand = 'claude mcp add claude-gemini-multimodal-bridge cgmb serve -e NODE_ENV=production';
          
          if (options.dryRun) {
            console.log(`🧪 Dry Run: Would execute: ${addCommand}`);
            return;
          }
          
          execSync(addCommand, { stdio: 'inherit' });
          console.log('\n✅ Successfully added CGMB to Claude Code MCP!');
          console.log('\nNext steps:');
          console.log('1. Restart Claude Code to load the new MCP configuration');
          console.log('2. Run "cgmb verify" to test the connection');
          console.log('3. Check that CGMB tools are available in Claude Code');
          return;
        } catch (error) {
          console.log('⚠️  Failed to use new MCP command, falling back to legacy method');
          logger.debug('MCP command error', { error: (error as Error).message });
        }
      }
      
      // Check current status first (legacy method)
      const status = await getMCPStatus();
      
      console.log('📊 Current MCP Configuration Status');
      console.log('═'.repeat(60));
      console.log(`Configuration Path: ${status.configPath || '❌ Claude Code config not found'}`);
      console.log(`CGMB Configured: ${status.isConfigured ? '✅ Yes' : '❌ No'}`);
      
      if (status.currentConfig) {
        console.log(`Current Command: ${status.currentConfig.command}`);
        console.log(`Current Args: ${status.currentConfig.args.join(' ')}`);
      }
      
      if (status.recommendations.length > 0) {
        console.log('\n💡 System Status:');
        status.recommendations.forEach(rec => {
          const icon = rec.includes('properly configured') ? '✅' : 'ℹ️';
          console.log(`   ${icon} ${rec}`);
        });
      }
      
      if (status.issues.length > 0) {
        console.log('\n⚠️  Issues Detected:');
        status.issues.forEach(issue => console.log(`   • ${issue}`));
      }
      
      console.log('');
      
      if (options.dryRun) {
        console.log('🧪 Dry Run Mode - Showing what would be done:');
        console.log('');
      }
      
      // Perform setup
      const result = await setupCGMBMCP({
        force: options.force,
        dryRun: options.dryRun
      });
      
      if (result.success) {
        const actionText = options.dryRun ? 'Would be' : 'Successfully';
        console.log(`✅ ${actionText} ${result.action} CGMB MCP configuration`);
        
        if (result.configPath) {
          console.log(`📁 Configuration file: ${result.configPath}`);
        }
        
        if (result.backupPath) {
          console.log(`💾 Backup created: ${result.backupPath}`);
        }
        
        if (!options.dryRun) {
          console.log('');
          console.log('🎉 Setup Complete!');
          console.log('');
          console.log('Next steps:');
          console.log('1. Restart Claude Code to load the new MCP configuration');
          console.log('2. Run "cgmb verify" to test the connection');
          console.log('3. Check that CGMB tools are available in Claude Code');
          
          if (status.recommendations.length > 0) {
            console.log('');
            console.log('💡 Recommendations:');
            status.recommendations.forEach(rec => console.log(`   • ${rec}`));
          }
        }
      } else {
        console.log(`❌ ${result.message}`);
        
        if (result.action === 'error') {
          console.log('');
          console.log('🔧 Manual Setup Alternative:');
          console.log('Run: cgmb setup-mcp --manual');
        }
        
        process.exit(1);
      }
      
    } catch (error) {
      logger.error('MCP setup failed', error as Error);
      console.log('❌ Failed to setup MCP configuration');
      console.log('');
      console.log('🔧 Try manual setup instead:');
      console.log('   cgmb setup-mcp --manual');
      process.exit(1);
    }
  });

// MCP status command
program
  .command('mcp-status')
  .description('Check Claude Code MCP configuration status')
  .action(async () => {
    try {
      // Load environment variables
      await loadEnvironmentSmart({ verbose: false });
      
      console.log('📊 Claude Code MCP Configuration Status');
      console.log('═'.repeat(50));
      
      const status = await getMCPStatus();
      
      console.log(`Configuration Path: ${status.configPath || 'Not found'}`);
      console.log(`CGMB Configured: ${status.isConfigured ? '✅ Yes' : '❌ No'}`);
      console.log('');
      
      if (status.currentConfig) {
        console.log('🔧 Current CGMB Configuration:');
        console.log(`   Command: ${status.currentConfig.command}`);
        console.log(`   Arguments: ${status.currentConfig.args.join(' ')}`);
        if (status.currentConfig.env) {
          console.log(`   Environment: ${Object.keys(status.currentConfig.env).join(', ')}`);
        }
        console.log('');
      }
      
      if (status.issues.length > 0) {
        console.log('⚠️  Issues:');
        status.issues.forEach(issue => console.log(`   • ${issue}`));
        console.log('');
      }
      
      if (status.recommendations.length > 0) {
        console.log('💡 Recommendations:');
        status.recommendations.forEach(rec => console.log(`   • ${rec}`));
        console.log('');
      }
      
      if (!status.isConfigured) {
        console.log('🚀 To setup MCP integration, run:');
        console.log('   cgmb setup-mcp');
        console.log('');
        console.log('📋 For manual setup instructions, run:');
        console.log('   cgmb setup-mcp --manual');
      }
      
    } catch (error) {
      logger.error('Failed to check MCP status', error as Error);
      process.exit(1);
    }
  });

// Verify command
program
  .command('verify')
  .description('Verify CGMB installation and authentication')
  .option('--fix', 'Attempt to fix authentication issues automatically')
  .action(async (options) => {
    try {
      logger.info('🔍 Verifying CGMB installation and authentication...');
      
      // Load configuration
      // Load environment variables
      await loadEnvironmentSmart({ verbose: false });
      
      const authVerifier = new AuthVerifier();
      const interactiveSetup = new InteractiveSetup();
      
      // Basic system checks
      const systemChecks = [
        {
          name: 'Node.js version',
          check: () => {
            const version = process.version;
            const required = 'v22.0.0';
            if (version < required) {
              throw new Error(`Node.js ${required}+ required, found ${version}`);
            }
            return true;
          }
        },
        {
          name: 'Project dependencies',
          check: () => {
            const packagePath = path.join(process.cwd(), 'package.json');
            return fs.existsSync(packagePath);
          }
        },
        {
          name: 'Claude Code CLI',
          check: () => checkCommand('claude --version')
        },
        {
          name: 'Antigravity CLI',
          check: async () => {
            const binary = await findAntigravityBinary();
            return binary !== undefined && binary.versionSupported;
          }
        }
      ];
      
      // Run system checks first
      logger.info('\n📋 System Requirements Check:');
      let systemChecksPassed = true;
      
      for (const { name, check } of systemChecks) {
        try {
          await check();
          logger.info(`✓ ${name}`);
        } catch (error) {
          logger.error(`✗ ${name}: ${(error as Error).message}`);
          systemChecksPassed = false;
        }
      }
      
      // Run authentication verification
      logger.info('\n🔐 Authentication Verification:');
      const authResults = await authVerifier.verifyAllAuthentications();
      
      // Display authentication results
      let authChecksPassed = true;
      Object.entries(authResults.services).forEach(([service, result]) => {
        const icon = result.success ? '✅' : '❌';
        const serviceName = service.charAt(0).toUpperCase() + service.slice(1);
        logger.info(`${icon} ${serviceName}: ${result.success ? 'Authenticated' : 'Not Authenticated'}`);
        
        if (!result.success) {
          authChecksPassed = false;
          if (result.error) {
            logger.info(`   Error: ${result.error}`);
          }
          if (result.actionInstructions) {
            logger.info(`   Action: ${result.actionInstructions}`);
          }
        }
      });
      
      // Run MCP configuration verification
      logger.info('\n🔗 MCP Configuration Verification:');
      const mcpStatus = await getMCPStatus();
      let mcpChecksPassed = true;
      
      const mcpIcon = mcpStatus.isConfigured ? '✅' : '❌';
      logger.info(`${mcpIcon} Claude Code MCP Integration: ${mcpStatus.isConfigured ? 'Configured' : 'Not Configured'}`);
      
      if (!mcpStatus.isConfigured) {
        mcpChecksPassed = false;
        logger.info('   Action: Run "cgmb setup-mcp" to configure MCP integration');
      } else if (mcpStatus.currentConfig) {
        logger.info(`   Command: ${mcpStatus.currentConfig.command}`);
        logger.info(`   Args: ${mcpStatus.currentConfig.args.join(' ')}`);
      }
      
      if (mcpStatus.issues.length > 0) {
        mcpStatus.issues.forEach(issue => {
          logger.info(`   ⚠️  ${issue}`);
        });
      }
      
      // Overall status
      const allPassed = systemChecksPassed && authChecksPassed && mcpChecksPassed;
      
      logger.info('\n' + '═'.repeat(50));
      if (allPassed) {
        logger.info('🎉 All verification checks passed!');
        
        // Test server initialization (lightweight test)
        logger.info('\n🚀 Testing server initialization...');
        try {
          const server = new CGMBServer();
          await server.initialize();
          logger.info('✓ Server initialization test passed');
          
          // Ensure any resources are cleaned up
          if (server && typeof (server as any).cleanup === 'function') {
            await (server as any).cleanup();
          }
        } catch (initError) {
          logger.warn('Server initialization test failed, but basic checks passed', {
            error: (initError as Error).message
          });
          logger.info('✓ Basic verification completed (server test skipped)');
        }
        
        logger.info('\n✨ CGMB is ready to use!');
        logger.info('💡 Try: cgmb serve');
        
        // Explicitly exit after successful verification
        process.exit(0);
        
      } else {
        logger.error('⚠️  Some verification checks failed', new Error('Verification checks failed'));
        
        if (options.fix && !authChecksPassed) {
          logger.info('\n🔧 Attempting to fix authentication issues...');
          try {
            await interactiveSetup.runAuthSetupWizard();
            logger.info('✓ Authentication setup completed');
            logger.info('💡 Please run "cgmb verify" again to confirm fixes');
          } catch (fixError) {
            logger.error('❌ Automatic fix failed', fixError as Error);
            logger.info('💡 Please run "cgmb auth --interactive" for manual setup');
          }
        } else if (!authChecksPassed) {
          logger.info('\n💡 To fix authentication issues:');
          logger.info('   Run: cgmb verify --fix');
          logger.info('   Or: cgmb auth --interactive');
        }
        
        if (!systemChecksPassed) {
          logger.info('\n💡 To fix system issues:');
          logger.info('   1. Install missing CLI tools');
          logger.info('   2. Run: cgmb setup');
          logger.info('   3. Run: cgmb verify');
        }
        
        if (!mcpChecksPassed) {
          logger.info('\n💡 To fix MCP integration:');
          logger.info('   1. Run: cgmb setup-mcp');
          logger.info('   2. Restart Claude Code');
          logger.info('   3. Run: cgmb verify');
        }
        
        if (authResults.recommendations.length > 0) {
          logger.info('\n📝 Recommendations:');
          authResults.recommendations.forEach(rec => logger.info(`   • ${rec}`));
        }
        
        if (mcpStatus.recommendations.length > 0) {
          logger.info('\n🔗 MCP Recommendations:');
          mcpStatus.recommendations.forEach(rec => logger.info(`   • ${rec}`));
        }
        
        process.exit(1);
      }
      
    } catch (error) {
      logger.error('❌ Verification failed', error as Error);
      logger.info('\n💡 Try:');
      logger.info('   1. cgmb setup');
      logger.info('   2. cgmb auth --interactive');
      logger.info('   3. cgmb verify');
      process.exit(1);
    }
  });

// Test command - Enhanced with actual multimodal processing
program
  .command('test')
  .description('Run a test multimodal processing request')
  .option('-f, --file <path>', 'Path to test file')
  .option('-p, --prompt <text>', 'Test prompt', 'Analyze this content')
  .option('--timeout <ms>', 'Timeout in milliseconds', '120000')
  .action(async (options) => {
    try {
      // Load environment variables
      await loadEnvironmentSmart({ verbose: false });
      
      logger.info('Running CGMB test...');
      
      const server = new CGMBServer();
      await server.initialize();
      
      // Import MultimodalProcess for actual testing
      const { MultimodalProcess } = await import('./tools/multimodalProcess.js');
      const processor = new MultimodalProcess();
      
      if (options.file) {
        // Test with provided file
        logger.info(`Testing with file: ${options.file}`);
        
        const result = await processor.processSingleFile(
          options.file,
          options.prompt,
          { timeout: parseInt(options.timeout) }
        );
        
        logger.info('✅ File processing test completed successfully!');
        logger.info(`Result: ${result.content.substring(0, 200)}...`);
        logger.info(`Processing time: ${result.processing_time}ms`);
        logger.info(`Layers involved: ${result.layers_involved?.join(', ')}`);
        
      } else {
        // Test with text-only prompt
        logger.info('Testing with text-only prompt...');
        
        const result = await processor.processMultimodal({
          prompt: options.prompt,
          files: [],
          workflow: 'analysis',
          options: { timeout: parseInt(options.timeout) }
        });
        
        logger.info('✅ Text processing test completed successfully!');
        logger.info(`Result: ${result.content.substring(0, 200)}...`);
        logger.info(`Processing time: ${result.processing_time}ms`);
        logger.info(`Layers involved: ${result.layers_involved?.join(', ')}`);
      }
      
      logger.info('🎉 CGMB test completed successfully!');
      logger.info('All systems are working correctly');
      
      // Exit immediately after test completion
      process.exit(0);
      
    } catch (error) {
      logger.error('❌ Test failed', error as Error);
      logger.error('This might indicate authentication or configuration issues');
      logger.info('💡 Try running: cgmb verify');
      process.exit(1);
    }
  });

// User-friendly chat command
program
  .command('chat')
  .alias('c')
  .description('Chat with Gemini (user-friendly interface)')
  .argument('[prompt...]', 'Your question or prompt')
  .option('-m, --model <model>', 'Antigravity model to use (see `agy models`)', DEFAULT_ANTIGRAVITY_MODEL)
  .option('--fast', 'Use fast path for better performance')
  .action(async (promptArgs, options) => {
    try {
      const prompt = promptArgs.join(' ');
      
      if (!prompt) {
        showChatHelp();
        process.exit(1);
      }

      // Check if user is trying to generate images with chat command
      const imageGenerationPatterns = [
        /generate.*image/i,
        /create.*image/i,
        /make.*image/i,
        /draw.*image/i,
        /generate.*picture/i,
        /create.*picture/i,
        /image.*of/i,
        /picture.*of/i
      ];
      
      if (imageGenerationPatterns.some(pattern => pattern.test(prompt))) {
        console.log('\n💡 It looks like you want to generate an image!');
        console.log('');
        console.log('The chat command doesn\'t generate images. Use the dedicated command:');
        console.log(`   cgmb generate-image "${prompt}"`);
        console.log('');
        console.log('This will automatically:');
        console.log('   • Sanitize your prompt (cute → friendly-looking)');
        console.log('   • Add safety prefixes');
        console.log('   • Generate the image properly');
        console.log('');
        process.exit(0);
      }

      console.log('💡 Auto-detected prompt (using chat mode)');
      
      // Internally execute the same processing as the gemini command
      // However, the -p flag is set automatically
      options.prompt = prompt;
      await executeGeminiCommand(options);
      
    } catch (error) {
      const errorMessage = (error as Error).message;
      
      if (errorMessage.includes('function response parts') || errorMessage.includes('function call parts')) {
        logger.error('❌ Chat API Error', error as Error);
        logger.info('🔧 This looks like an authentication issue:');
        logger.info('   • Sign in: run `agy` in a terminal');
        logger.info('   • Check status: cgmb auth-status --verbose');
      } else {
        logger.error('❌ Chat command failed', error as Error);
        logger.info('💡 Troubleshooting:');
        logger.info('   • Check auth: cgmb auth-status');
        logger.info('   • Verify setup: cgmb verify');
      }
      process.exit(1);
    }
  });

// ADVANCED/TROUBLESHOOTING: Direct Gemini CLI command  
program
  .command('gemini')
  .description('⚠️  ADVANCED: Direct Antigravity CLI access (troubleshooting only - use cgmb chat instead)')
  .argument('[prompt...]', 'Direct prompt (auto-detects if -p missing)')
  .option('-p, --prompt <text>', 'Explicit prompt for Antigravity CLI')
  .option('-m, --model <model>', 'Antigravity model to use (see `agy models`)', DEFAULT_ANTIGRAVITY_MODEL)
  .option('-f, --file <path>', 'File to analyze with prompt')
  .option('--fast', 'Skip the search cache (text prompts only)')
  .action(async (promptArgs, options) => {
    try {
      let prompt = options.prompt;
      
      // Smart detection: When there are arguments but no -p flag
      if (!prompt && promptArgs.length > 0) {
        prompt = promptArgs.join(' ');
        console.log('💡 Auto-detected prompt (tip: use -p for explicit mode)');
      }
      
      if (!prompt) {
        showGeminiHelp();
        process.exit(1);
      }

      // Check if user is trying to generate images with gemini command
      const imageGenerationPatterns = [
        /generate.*image/i,
        /create.*image/i,
        /make.*image/i,
        /draw.*image/i,
        /generate.*picture/i,
        /create.*picture/i,
        /image.*of/i,
        /picture.*of/i
      ];
      
      if (imageGenerationPatterns.some(pattern => pattern.test(prompt))) {
        console.log('\n💡 It looks like you want to generate an image!');
        console.log('');
        console.log('The gemini command doesn\'t generate images. Use the dedicated command:');
        console.log(`   cgmb generate-image "${prompt}"`);
        console.log('');
        console.log('This will automatically:');
        console.log('   • Sanitize your prompt (cute → friendly-looking)');
        console.log('   • Add safety prefixes');
        console.log('   • Generate the image properly');
        console.log('');
        process.exit(0);
      }

      options.prompt = prompt;
      await executeGeminiCommand(options);
      
    } catch (error) {
      const errorMessage = (error as Error).message;
      
      // Enhanced error handling with specific guidance
      if (errorMessage.includes('function response parts') || errorMessage.includes('function call parts')) {
        logger.error('❌ API Function Call Error', error as Error);
        logger.info('🔧 This error usually indicates an authentication issue:');
        logger.info('   1. Sign in: run `agy` in a terminal');
        logger.info('   2. Check API key configuration');
        logger.info('   3. Verify Antigravity CLI version: agy --version');
        logger.info('   4. Check status: cgmb auth-status --verbose');
      } else if (errorMessage.includes('UNAUTHENTICATED') || errorMessage.includes('API_KEY')) {
        logger.error('❌ Authentication Error', error as Error);
        logger.info('🔧 Fix authentication:');
        logger.info('   • Sign in (recommended): run `agy` in a terminal');
        logger.info('   • Check status: cgmb auth-status');
      } else if (errorMessage.includes('quota exceeded') || errorMessage.includes('Quota exceeded') || errorMessage.includes('Resource exhausted')) {
        logger.error('❌ Antigravity CLI Service Quota Exceeded', error as Error);
        logger.info('🔧 This is an Antigravity CLI service limitation (separate from the Gemini API):');
        logger.info('   • Wait a few minutes for quota reset');
        logger.info('   • Try AI Studio layer: cgmb aistudio -p "your question"');
        logger.info('   • Check AI Studio quota: cgmb quota-status');
        logger.info('   💡 Note: Antigravity quota ≠ Gemini API quota (different services)');
      } else if (errorMessage.includes('not found') || errorMessage.includes('command not found')) {
        logger.error('❌ Antigravity CLI Not Found', error as Error);
        logger.info('🔧 Install Antigravity CLI:');
        logger.info('   • Run setup: cgmb setup');
        logger.info(`   • Manual install: ${AGY_INSTALL_HINT}`);
      } else if (errorMessage.includes('timeout')) {
        logger.error('❌ Request Timeout', error as Error);
        logger.info('💡 Try:');
        logger.info('   • Shorter prompt');
        logger.info('   • Check network connection');
        logger.info('   • Use --fast flag for direct calls');
      } else {
        logger.error('❌ Antigravity CLI processing failed', error as Error);
        logger.info('💡 General troubleshooting:');
        logger.info('   • Check authentication: cgmb auth-status');
        logger.info('   • Verify setup: cgmb verify');
        logger.info('   • View help: cgmb gemini --help');
      }
      process.exit(1);
    }
  });

// Common Gemini execution function
async function executeGeminiCommand(options: any) {
  try {
    if (!options.prompt) {
      throw new Error('Prompt is required');
    }

    // Handle common incorrect option usage
    if (process.argv.includes('--search')) {
      console.log('\n💡 Note: Web search is automatically enabled in Antigravity CLI.');
      console.log('   No --search flag needed. Just ask about current events or trends!');
      console.log('   Example: cgmb gemini -p "latest AI security trends 2025"\n');
      // Continue processing without the flag
    }

    await loadEnvironmentSmart({ verbose: false });
    
    logger.info('🔍 Processing with Antigravity CLI...');

    // Fast path used to spawn the retired `gemini` binary directly, with its own
    // 90s timeout, no workspace isolation and no environment allowlist. Every
    // agy invocation now goes through AntigravityCLILayer so the hardening lives
    // in exactly one place; `--fast` simply skips CGMB's search cache.
    const useSearch = !(options.fast && !options.file);
    if (!useSearch) {
      logger.info('Using fast path (search cache bypassed)...');
    }

    const { AntigravityCLILayer } = await import('./layers/AntigravityCLILayer.js');
    const antigravityLayer = new AntigravityCLILayer();

    await antigravityLayer.initialize();

    let result;
    if (options.file) {
      // Process with file
      result = await antigravityLayer.processFiles([{ path: options.file, type: 'document' }], options.prompt);
    } else {
      // Text-only processing
      result = await antigravityLayer.execute({
        type: 'text_processing',
        prompt: options.prompt,
        ...(options.model ? { model: options.model } : {}),
        useSearch,
      });
    }
    
    logger.info('✅ Antigravity CLI processing completed');
    console.log('\n📋 Result:');
    console.log('═'.repeat(50));
    
    if ('data' in result) {
      console.log(result.data);
    } else if ('content' in result) {
      console.log(result.content);
    } else {
      console.log('Processing completed');
    }
    
    if (result.metadata) {
      console.log('\n📊 Metadata:');
      const metadata = result.metadata as any;
      console.log(`Processing time: ${metadata.duration || metadata.processing_time || 'N/A'}ms`);
      console.log(`Model: ${metadata.model || 'N/A'}`);
      console.log(`Tokens used: ${metadata.tokens_used || 'N/A'}`);
    }
    
    // Exit immediately after displaying results
    process.exit(0);
    
  } catch (error) {
    logger.error('❌ Antigravity CLI processing failed', error as Error);
    logger.info('💡 Check authentication: cgmb auth-status');
    process.exit(1);
  }
}

// ADVANCED: Direct AI Studio command
program
  .command('aistudio')
  .description('⚠️  ADVANCED: Direct AI Studio access (use cgmb analyze instead for documents)')
  .option('-p, --prompt <text>', 'Prompt for AI Studio')
  .option('-f, --files <paths...>', 'Files to process (images, documents, etc.)')
  .option('-m, --model <model>', 'AI Studio model to use', 'gemini-2.0-flash-exp')
  .action(async (options) => {
    try {
      if (!options.prompt) {
        logger.error('Prompt is required. Use: cgmb aistudio -p "your question" -f file1 file2');
        process.exit(1);
      }

      // Check if user is trying to generate images with aistudio command
      const imageGenerationPatterns = [
        /generate.*image/i,
        /create.*image/i,
        /make.*image/i,
        /draw.*image/i,
        /generate.*picture/i,
        /create.*picture/i,
        /image.*of/i,
        /picture.*of/i
      ];
      
      if (imageGenerationPatterns.some(pattern => pattern.test(options.prompt))) {
        console.log('\n⚠️  WARNING: You seem to be trying to generate an image.');
        console.log('');
        console.log('The "cgmb aistudio" command does NOT generate images - it only analyzes text!');
        console.log('');
        console.log('✅ To generate images, use the correct command:');
        console.log(`   cgmb generate-image "${options.prompt}"`);
        console.log('');
        console.log('Example:');
        console.log('   cgmb generate-image "cute cat"  # This will generate an image');
        console.log('');
        console.log('The generate-image command includes:');
        console.log('   • Automatic prompt sanitization (cute → friendly-looking)');
        console.log('   • Safety prefixes to avoid content policy issues');
        console.log('   • Proper image generation with Gemini 2.0 Flash');
        console.log('');
        console.log('Would you like to continue with text analysis anyway? (y/N)');
        
        const readline = await import('readline');
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout
        });
        
        const answer = await new Promise<string>((resolve) => {
          rl.question('', (answer) => {
            rl.close();
            resolve(answer.toLowerCase());
          });
        });
        
        if (answer !== 'y' && answer !== 'yes') {
          console.log('\n💡 Redirecting to image generation command...');
          console.log(`   Run: cgmb generate-image "${options.prompt}"`);
          process.exit(0);
        }
      }

      await loadEnvironmentSmart({ verbose: false });
      
      logger.info('🎨 Processing with AI Studio...');
      
      // Import and use AI Studio layer directly
      const { AIStudioLayer } = await import('./layers/AIStudioLayer.js');
      const aiStudioLayer = new AIStudioLayer();
      
      await aiStudioLayer.initialize();
      
      const files = options.files || [];
      
      // Enforce multimodal architecture: AI Studio requires files
      if (files.length === 0) {
        console.log('\n❌ ERROR: AI Studio layer requires multimodal content (files)');
        console.log('');
        console.log('📋 AI Studio is designed for multimodal processing with files.');
        console.log('   For text-only queries, use the appropriate layer:');
        console.log('');
        console.log('✅ For web search & current information:');
        console.log(`   cgmb chat "${options.prompt}"`);
        console.log(`   cgmb gemini -p "${options.prompt}"`);
        console.log('');
        console.log('✅ For complex reasoning & analysis:');
        console.log(`   cgmb process -p "${options.prompt}"`);
        console.log('');
        console.log('✅ For AI Studio with files:');
        console.log(`   cgmb aistudio -p "${options.prompt}" -f file1.pdf file2.jpg`);
        console.log('');
        console.log('💡 This enforces CGMB\'s architectural separation of concerns.');
        process.exit(1);
      }
      
      logger.info(`Processing ${files.length} files with AI Studio`);
      
      const result = await aiStudioLayer.execute({
        type: 'multimodal_processing',
        prompt: options.prompt,
        files: files.map((f: string) => ({ path: f, type: 'document' })),
        model: options.model
      });
      
      logger.info('✅ AI Studio processing completed');
      console.log('\n📋 Result:');
      console.log('═'.repeat(50));
      
      if ('data' in result) {
        console.log(result.data);
      } else if ('content' in result) {
        console.log(result.content);
      } else {
        console.log('Processing completed');
      }
      
      if (result.metadata) {
        console.log('\n📊 Metadata:');
        const metadata = result.metadata as any;
        console.log(`Processing time: ${metadata.duration || metadata.processing_time || 'N/A'}ms`);
        console.log(`Model: ${metadata.model || 'N/A'}`);
        console.log(`Tokens used: ${metadata.tokens_used || 'N/A'}`);
        console.log(`Files processed: ${files.length}`);
      }
      
      // Exit immediately after displaying results
      process.exit(0);
      
    } catch (error) {
      logger.error('❌ AI Studio processing failed', error as Error);
      logger.info('💡 Check authentication: cgmb auth-status');
      process.exit(1);
    }
  });

// Enhanced multimodal command for complex tasks
program
  .command('process')
  .description('Process multimodal content with intelligent layer routing')
  .option('-p, --prompt <text>', 'Processing prompt')
  .option('-f, --files <paths...>', 'Files to process')
  .option('-w, --workflow <type>', 'Workflow type: analysis, generation, conversion, extraction', 'analysis')
  .option('--strategy <strategy>', 'Processing strategy: claude-first, gemini-first, aistudio-first, adaptive', 'adaptive')
  .action(async (options) => {
    try {
      if (!options.prompt) {
        logger.error('Prompt is required. Use: cgmb process -p "your task" -f file1 file2');
        process.exit(1);
      }

      await loadEnvironmentSmart({ verbose: false });
      
      logger.info('🔀 Processing with intelligent layer routing...');
      
      const { MultimodalProcess } = await import('./tools/multimodalProcess.js');
      const processor = new MultimodalProcess();
      
      const files = options.files ? options.files.map((path: string) => ({ path, type: 'document' })) : [];
      
      const result = await processor.processMultimodal({
        prompt: options.prompt,
        files,
        workflow: options.workflow,
        options: {
          layer_priority: options.strategy === 'claude-first' ? 'claude' :
                         options.strategy === 'gemini-first' ? 'gemini' :
                         options.strategy === 'aistudio-first' ? 'aistudio' : 'adaptive',
          detailed: true
        }
      });
      
      logger.info('✅ Multimodal processing completed');
      console.log('\n📋 Result:');
      console.log('═'.repeat(50));
      console.log(result.content);
      
      console.log('\n📊 Processing Details:');
      console.log(`Workflow: ${result.workflow_used}`);
      console.log(`Processing time: ${result.processing_time}ms`);
      console.log(`Layers involved: ${result.layers_involved?.join(', ')}`);
      console.log(`Files processed: ${result.files_processed?.length || 0}`);
      
      if (result.metadata) {
        console.log(`Total tokens: ${result.metadata.tokens_used || 'N/A'}`);
        console.log(`Estimated cost: ${result.metadata.cost || 'N/A'}`);
      }
      
      // Exit immediately after displaying results
      process.exit(0);
      
    } catch (error) {
      logger.error('❌ Multimodal processing failed', error as Error);
      logger.info('💡 Try: cgmb verify');
      process.exit(1);
    }
  });

// Generate Image command
program
  .command('generate-image <prompt>')
  .description('Generate an image using AI Studio')
  .option('-s, --style <style>', 'Art style (photorealistic, cartoon, digital-art)', 'digital-art')
  .option('-o, --output <path>', 'Output file path')
  .option('--safe-mode', 'Use extra-safe prompt formatting', true)
  .action(async (prompt, options) => {
    // Set CLI mode environment variable FIRST before any imports or logger initialization
    process.env.CGMB_CLI_MODE = 'true';
    
    try {
      // Reset logger to quiet mode for CLI commands to avoid Error: display in Bash tool
      Logger.resetForCLI();
      
      // Load environment variables
      await loadEnvironmentSmart({ verbose: false });
      
      console.log('🎨 Generating image with AI Studio...');
      console.log('💡 Tip: For best results, use CGMB within Claude Code:');
      console.log('   "CGMB generate an image of a futuristic city"\n');

      // Add safety prefix if safe mode is enabled
      let safePrompt = prompt;
      if (options.safeMode) {
        // Add safe prefixes to avoid content policy issues
        const safetyPrefixes = [
          'digital illustration of',
          'artistic rendering of',
          'professional diagram showing',
          'creative visualization of',
          'stylized representation of'
        ];
        const prefix = safetyPrefixes[Math.floor(Math.random() * safetyPrefixes.length)];
        safePrompt = `${prefix} ${prompt}`;
      }
      
      const defaultConfig = {
        claude: { timeout: 300000, code_path: 'claude' },
        gemini: { temperature: 0.2, max_tokens: 16384, timeout: 60000, model: 'gemini-2.5-flash', api_key: process.env.AI_STUDIO_API_KEY || '' },
        aistudio: { enabled: true, max_files: 10, max_file_size: 100 },
        cache: { enabled: true, ttl: 3600 },
        logging: { level: 'info' as const }
      };
      const aiStudioLayer = new LayerManager(defaultConfig).getAIStudioLayer();
      await aiStudioLayer.initialize();
      
      // Execute with unified timeout management for consistent behavior
      const result = await withCLITimeout(
        () => aiStudioLayer.generateImage(safePrompt, {
          style: options.style,
          quality: 'high',
          aspectRatio: '1:1'
        }),
        'generate-image',
        120000 // 2 minutes base, automatically adjusted for environment
      );
      
      if (result.success && result.outputPath) {
        if (options.output) {
          // Copy generated file to desired location
          await fs.promises.copyFile(result.outputPath, options.output);
          console.log(`✅ Image saved to: ${options.output}`);
        } else {
          console.log('✅ Image generated successfully!');
          console.log(`📁 Generated at: ${result.outputPath}`);
          console.log(`📊 Size: ${result.metadata?.dimensions?.width}x${result.metadata?.dimensions?.height || 'Unknown'}`);
          console.log(`🖼️  Format: ${result.metadata?.format || 'PNG'}`);
          console.log('\n💡 Use --output flag to save the image to a specific location.');
        }
        process.exit(0);
      } else {
        console.error('❌ Image generation failed:', result.error || 'Unknown error');
        if (result.error?.includes('content policy')) {
          console.log('\n💡 Try modifying your prompt to be more specific or descriptive.');
          console.log('   Example: "professional illustration of a happy cat in a garden"');
        }
        process.exit(1);
      }
    } catch (error) {
      logger.error('Image generation failed', error as Error);
      console.error('❌ Failed to generate image:', (error as Error).message);
      console.log('\n💡 Troubleshooting tips:');
      console.log('   1. Check your AI Studio API key: cgmb auth-status');
      console.log('   2. Try a simpler prompt');
      console.log('   3. Use --safe-mode flag (enabled by default)');
      if ((error as Error).message.includes('timed out')) {
        console.log('   4. If timeout occurred in fresh installation, this is normal for first run');
      }
      process.exit(1);
    }
  });

// Generate Audio command
program
  .command('generate-audio <text>')
  .description('Generate audio/speech from text using AI Studio')
  .option('-v, --voice <voice>', 'Voice name (Kore, Puck, etc.)', 'Kore')
  .option('-o, --output <path>', 'Output audio file path')
  .option('--script', 'Generate script first then convert to audio')
  .action(async (text, options) => {
    // Set CLI mode environment variable FIRST before any imports or logger initialization
    process.env.CGMB_CLI_MODE = 'true';
    
    try {
      // Set quiet log level for CLI commands to avoid Error: display in Bash tool  
      process.env.LOG_LEVEL = 'warn';
      
      // Load environment variables
      await loadEnvironmentSmart({ verbose: false });
      
      console.log('🎵 Generating audio with AI Studio...');
      console.log('💡 Tip: For best results, use CGMB within Claude Code:');
      console.log('   "CGMB create audio saying Welcome to our podcast"\n');

      const defaultConfig = {
        claude: { timeout: 300000, code_path: 'claude' },
        gemini: { temperature: 0.2, max_tokens: 16384, timeout: 60000, model: 'gemini-2.5-flash', api_key: process.env.AI_STUDIO_API_KEY || '' },
        aistudio: { enabled: true, max_files: 10, max_file_size: 100 },
        cache: { enabled: true, ttl: 3600 },
        logging: { level: 'info' as const }
      };
      const aiStudioLayer = new LayerManager(defaultConfig).getAIStudioLayer();
      await aiStudioLayer.initialize();
      
      // Execute with immediate response timeout mechanism
      // Execute with unified timeout management for consistent behavior
      const result = await withCLITimeout(
        () => options.script ? 
          aiStudioLayer.generateAudioWithScript(text) :
          aiStudioLayer.generateAudio(text, {
            voice: options.voice,
            format: 'wav',
            quality: 'hd'
          }),
        'generate-audio',
        90000 // 1.5 minutes base, automatically adjusted for environment
      );
      
      if (result.success && result.outputPath) {
        if (options.output) {
          // Copy generated file to desired location
          await fs.promises.copyFile(result.outputPath, options.output);
          console.log(`✅ Audio saved to: ${options.output}`);
        } else {
          console.log('✅ Audio generated successfully!');
          console.log(`📁 Generated at: ${result.outputPath}`);
          console.log(`🎤 Voice: ${options.voice}`);
          console.log(`📊 Format: ${result.metadata?.format || 'WAV'}`);
          console.log('\n💡 Use --output flag to save the audio to a specific location.');
        }
        process.exit(0);
      } else {
        console.error('❌ Audio generation failed:', result.error || 'Unknown error');
        process.exit(1);
      }
    } catch (error) {
      logger.error('Audio generation failed', error as Error);
      console.error('❌ Failed to generate audio:', (error as Error).message);
      if ((error as Error).message.includes('timed out')) {
        console.log('💡 If timeout occurred in fresh installation, this is normal for first run');
        console.log('    MCP server startup may take longer initially');
      }
      process.exit(1);
    }
  });

// Analyze command
program
  .command('analyze <files...>')
  .description('Analyze documents using optimal AI layer (auto-routes based on file type)')
  .option('-t, --type <type>', 'Analysis type (summary, extract, compare)', 'summary')
  .option('-p, --prompt <prompt>', 'Custom analysis prompt')
  .option('-l, --layer <layer>', 'Force specific layer (gemini, claude, aistudio, auto)', 'auto')
  .action(async (files, options) => {
    // Set CLI mode environment variable FIRST before any imports or logger initialization
    process.env.CGMB_CLI_MODE = 'true';
    
    try {
      // Reset logger to quiet mode for CLI commands to avoid Error: display in Bash tool
      Logger.resetForCLI();
      
      // Load environment variables
      await loadEnvironmentSmart({ verbose: false });

      // URL Detection and Intelligent Routing
      const urlFiles = files.filter((file: string) => /^https?:\/\//.test(file));
      if (urlFiles.length > 0) {
        console.log('🌐 URL(s) detected in input:');
        urlFiles.forEach((url: string) => console.log(`   ${url}`));
        console.log('');
        
        // Separate PDF URLs from regular web URLs
        const pdfUrls = urlFiles.filter((url: string) => url.toLowerCase().endsWith('.pdf'));
        const webUrls = urlFiles.filter((url: string) => !url.toLowerCase().endsWith('.pdf'));
        
        // Handle PDF URLs with AI Studio layer
        if (pdfUrls.length > 0) {
          console.log('📄 PDF URL(s) detected - routing to AI Studio for optimal PDF processing...');
          console.log('💡 Tip: For best results, use CGMB within Claude Code:');
          console.log('   "CGMB analyze https://example.com/document.pdf"\n');

          // Construct analysis prompt for PDF URLs
          let analysisPrompt: string;
          if (pdfUrls.length === 1) {
            const basePrompt = options.prompt || `Please ${options.type} this PDF document`;
            analysisPrompt = `${basePrompt}`;
          } else {
            analysisPrompt = `Analyze and ${options.type} these PDF documents`;
          }
          
          console.log(`📝 Analysis prompt: "${analysisPrompt}"`);
          console.log('');
          
          // Use LayerManager with AI Studio layer for PDF URL processing
          const layerManager = new LayerManager({
            gemini: { api_key: '', model: 'gemini-2.5-pro', timeout: 60000, max_tokens: 16384, temperature: 0.2 },
            claude: { code_path: 'claude', timeout: 300000 },
            aistudio: { enabled: true, max_files: 10, max_file_size: 100 },
            cache: { enabled: true, ttl: 3600 },
            logging: { level: 'info' as const }
          });
          
          try {
            await layerManager.initializeLayers();
            const result = await layerManager.executeWithLayer('aistudio', {
              type: 'multimodal_processing',
              files: pdfUrls.map((url: string) => ({ 
                path: url, 
                type: 'document'
              })),
              instructions: analysisPrompt,
              options: {
                analysisType: options.type || 'summary',
                depth: 'deep'
              }
            });
            
            console.log('\n📋 Result:');
            console.log('═'.repeat(50));
            console.log(result.data || 'Processing completed');
            
            if (result.metadata) {
              console.log('\n📊 Metadata:');
              console.log(`Processing time: ${result.metadata.duration || 'N/A'}ms`);
              console.log(`Layer: AI Studio (PDF URL processing via Gemini File API)`);
            }
          } catch (error) {
            logger.error('PDF URL processing failed', error as Error);
            console.log('❌ Failed to process PDF URL(s)');
            console.log('💡 Falling back to Claude Code layer...');
            
            // Fallback to Claude Code layer
            try {
              const fallbackResult = await layerManager.executeWithLayer('claude', {
                type: 'document_analysis',
                prompt: `${analysisPrompt} from ${pdfUrls.join(', ')}`,
                analysis_type: options.type || 'summary'
              });
              
              console.log('\n📋 Fallback Result (Claude Code):');
              console.log('═'.repeat(50));
              console.log(fallbackResult.data || 'Processing completed');
              
              if (fallbackResult.metadata) {
                console.log('\n📊 Metadata:');
                console.log(`Processing time: ${fallbackResult.metadata.duration || 'N/A'}ms`);
                console.log(`Layer: Claude Code (Fallback)`);
              }
            } catch (fallbackError) {
              logger.error('Fallback processing also failed', fallbackError as Error);
              console.log('❌ Both AI Studio and Claude Code processing failed');
              console.log('💡 Try downloading the PDF manually and using: cgmb analyze local-file.pdf');
              process.exit(1);
            }
          }
        }
        
        // Handle regular web URLs with Gemini CLI
        if (webUrls.length > 0) {
          console.log('🔍 Web URL(s) detected - routing to Gemini CLI for current information...');
          console.log('💡 Tip: For best results, use CGMB within Claude Code:');
          console.log('   "CGMB search for the latest AI developments"\n');

          // Construct analysis prompt for web URLs
          let analysisPrompt: string;
          if (webUrls.length === 1) {
            const basePrompt = options.prompt || `Please ${options.type} this webpage`;
            analysisPrompt = `${basePrompt} at ${webUrls[0]}`;
          } else {
            analysisPrompt = `Analyze and ${options.type} the webpages at these URLs: ${webUrls.join(', ')}`;
          }
          
          console.log(`📝 Analysis prompt: "${analysisPrompt}"`);
          console.log('');
          
          // Execute via Gemini CLI for web content
          const geminiOptions = {
            prompt: analysisPrompt,
            model: DEFAULT_ANTIGRAVITY_MODEL,
            fast: false
          };
          
          await executeGeminiCommand(geminiOptions);
        }
        
        process.exit(0);
      }

      // Enhanced File Path Resolution and Validation
      const resolvedFiles: string[] = [];
      const missingFiles: string[] = [];
      const permissionIssues: string[] = [];

      for (const file of files) {
        try {
          // Normalize and resolve path, handling both relative and absolute paths
          const normalizedPath = path.normalize(file);
          const resolvedPath = path.isAbsolute(normalizedPath) 
            ? normalizedPath 
            : path.resolve(process.cwd(), normalizedPath);
          
          // Check existence first
          if (fs.existsSync(resolvedPath)) {
            // Check if it's a file (not directory) and readable
            const stats = fs.statSync(resolvedPath);
            if (stats.isFile()) {
              // Check read permissions
              try {
                fs.accessSync(resolvedPath, fs.constants.R_OK);
                resolvedFiles.push(resolvedPath);
              } catch (permError) {
                permissionIssues.push(file);
              }
            } else {
              missingFiles.push(file + ' (is a directory, not a file)');
            }
          } else {
            missingFiles.push(file);
          }
        } catch (error) {
          // Handle any other path resolution errors
          missingFiles.push(file + ' (path resolution error)');
        }
      }

      // Handle missing files and permission issues
      if (missingFiles.length > 0 || permissionIssues.length > 0) {
        if (missingFiles.length > 0) {
          console.log('❌ File(s) not found:');
          missingFiles.forEach((file: string) => {
            const baseName = file.includes(' (') ? (file.split(' (')[0] || file) : file;
            const resolvedPath = path.resolve(process.cwd(), baseName);
            console.log(`   ${file} (resolved: ${resolvedPath})`);
          });
        }
        
        if (permissionIssues.length > 0) {
          console.log('❌ Permission denied:');
          permissionIssues.forEach((file: string) => {
            const resolvedPath = path.resolve(process.cwd(), file);
            console.log(`   ${file} (resolved: ${resolvedPath})`);
          });
        }
        
        console.log('');
        console.log('💡 Tips for file path issues:');
        console.log('   • Relative paths: ./document.pdf, ../files/doc.pdf');
        console.log('   • Absolute paths: /full/path/to/document.pdf');
        console.log('   • Check file exists and has read permissions');
        console.log('   • Ensure paths don\'t contain special characters');
        process.exit(1);
      }

      console.log('📄 Analyzing documents with AI Studio...');
      console.log('💡 Tip: For best results, use CGMB within Claude Code:');
      console.log('   "CGMB analyze the document at /path/to/report.pdf"\n');
      console.log(`📁 Files (${resolvedFiles.length}):`);
      console.log(`📂 Current directory: ${process.cwd()}`);
      resolvedFiles.forEach((file: string, index: number) => {
        const originalFile = files[resolvedFiles.indexOf(file)] || file;
        const isRelative = !path.isAbsolute(originalFile);
        if (isRelative && originalFile !== file) {
          console.log(`   ${originalFile} → ${file}`);
        } else {
          console.log(`   ${file}`);
        }
      });
      
      // Multiple PDF Detection for Special Handling
      const pdfFiles = resolvedFiles.filter((file: string) => path.extname(file).toLowerCase() === '.pdf');
      if (pdfFiles.length > 1) {
        console.log(`\n📚 Multiple PDFs detected (${pdfFiles.length}). Using Gemini File API batch processing...`);
      }

      const defaultConfig = {
        claude: { timeout: 300000, code_path: 'claude' },
        gemini: { temperature: 0.2, max_tokens: 16384, timeout: 60000, model: 'gemini-2.5-flash', api_key: process.env.AI_STUDIO_API_KEY || '' },
        aistudio: { enabled: true, max_files: 10, max_file_size: 100 },
        cache: { enabled: true, ttl: 3600 },
        logging: { level: 'info' as const }
      };
      const layerManager = new LayerManager(defaultConfig);
      
      // Validate user-specified layer option
      const validLayers = ['gemini', 'claude', 'aistudio', 'auto'];
      if (!validLayers.includes(options.layer)) {
        console.error(`❌ Invalid layer: ${options.layer}`);
        console.error(`Valid options: ${validLayers.join(', ')}`);
        process.exit(1);
      }
      
      // Auto-detect file types instead of hardcoding 'document'
      const fileReferences = resolvedFiles.map((f: string) => {
        // Use LayerManager's detectFileType method for accurate type detection
        const detectedType = layerManager.detectFileType(f);
        return { path: f, type: detectedType };
      });
      
      const analysisPrompt = options.prompt || `Please ${options.type} these documents`;
      
      // Determine user preferred layer (undefined for auto)
      const userPreferredLayer = options.layer !== 'auto' ? options.layer : undefined;
      
      // Log file analysis for user understanding
      if (fileReferences.length > 0) {
        console.log(`\n📁 File Analysis:`);
        fileReferences.forEach((ref: any) => {
          console.log(`   ${ref.path} → ${ref.type}`);
        });
        
        if (userPreferredLayer) {
          console.log(`\n🎯 Layer Override: Using ${userPreferredLayer} layer as requested`);
        } else {
          console.log(`\n🤖 Auto-routing: Optimal layer will be selected based on file types`);
        }
        console.log('');
      }
      
      // Execute with immediate response timeout mechanism
      // Execute with unified timeout management for consistent behavior
      const result = await withCLITimeout(
        () => layerManager.executeWithOptimalLayer({
          prompt: analysisPrompt,
          files: fileReferences,
          options: {
            analysisType: options.type,
            depth: 'deep',
            multiplePDFs: pdfFiles.length > 1,
            preferredLayer: userPreferredLayer
          }
        }),
        'analyze-documents',
        240000 // 4 minutes base, automatically adjusted for environment and file count
      );
      
      if (result.success) {
        console.log('\n✅ Analysis complete!');
        console.log('═'.repeat(50));
        console.log(result.data || 'Analysis completed');
        console.log('═'.repeat(50));
        
        if (result.metadata) {
          console.log('\n📊 Analysis Metadata:');
          console.log(`   Layer used: ${result.metadata.layer || 'Unknown'}`);
          console.log(`   Processing time: ${result.metadata.duration || 0}ms`);
        }
        process.exit(0);
      } else {
        console.error('❌ Analysis failed:', result.error || 'Unknown error');
        process.exit(1);
      }
    } catch (error) {
      logger.error('Document analysis failed', error as Error);
      console.error('❌ Failed to analyze documents:', (error as Error).message);
      if ((error as Error).message.includes('timed out')) {
        console.log('💡 Large files may require more time in fresh installations');
        console.log('    Consider breaking large documents into smaller parts');
      }
      process.exit(1);
    }
  });

// Multimodal command
program
  .command('multimodal <files...>')
  .description('Process multiple files with AI (images, PDFs, audio, etc.)')
  .option('-p, --prompt <prompt>', 'Processing prompt', 'Analyze and summarize these files')
  .option('-w, --workflow <type>', 'Workflow type (analysis, conversion, extraction)', 'analysis')
  .option('-o, --output <format>', 'Output format (text, json, markdown)', 'text')
  .action(async (files, options) => {
    // Set CLI mode environment variable FIRST before any imports or logger initialization
    process.env.CGMB_CLI_MODE = 'true';
    
    try {
      // Set quiet log level for CLI commands to avoid Error: display in Bash tool  
      process.env.LOG_LEVEL = 'warn';
      
      // Load environment variables
      await loadEnvironmentSmart({ verbose: false });
      
      console.log('🎯 Processing multimodal content...');
      console.log(`📁 Files: ${files.join(', ')}`);
      
      const defaultConfig = {
        claude: { timeout: 300000, code_path: 'claude' },
        gemini: { temperature: 0.2, max_tokens: 16384, timeout: 60000, model: 'gemini-2.5-flash', api_key: process.env.AI_STUDIO_API_KEY || '' },
        aistudio: { enabled: true, max_files: 10, max_file_size: 100 },
        cache: { enabled: true, ttl: 3600 },
        logging: { level: 'info' as const }
      };
      const layerManager = new LayerManager(defaultConfig);
      
      // Detect file types
      const fileRefs = files.map((file: string) => {
        const ext = path.extname(file).toLowerCase();
        let type: string = 'document';
        if (['.png', '.jpg', '.jpeg', '.gif'].includes(ext)) type = 'image';
        else if (['.pdf'].includes(ext)) type = 'pdf';
        else if (['.mp3', '.wav', '.m4a'].includes(ext)) type = 'audio';
        return { path: file, type };
      });
      
      console.log('📊 Detected file types:', fileRefs.map((f: any) => `${f.path} (${f.type})`).join(', '));
      
      // Execute with unified timeout management for consistent behavior
      const result = await withCLITimeout(
        () => layerManager.executeWithOptimalLayer({
          prompt: options.prompt,
          files: fileRefs,
          options: {
            workflow: options.workflow,
            outputFormat: options.output,
            execution_mode: 'adaptive'
          }
        }),
        'multimodal-process',
        300000 // 5 minutes base, automatically adjusted for environment and file count
      );
      
      if (result.success) {
        console.log('\n✅ Processing complete!');
        console.log('═'.repeat(50));
        
        if (options.output === 'json' && result.data) {
          console.log(JSON.stringify(result.data, null, 2));
        } else {
          console.log(result.data || 'Analysis completed');
        }
        
        console.log('═'.repeat(50));
        
        if (result.metadata) {
          console.log('\n📊 Processing Details:');
          console.log(`   Layer used: ${result.metadata.layer || 'Unknown'}`);
          console.log(`   Files processed: ${files.length}`);
          console.log(`   Processing time: ${result.metadata.duration || 0}ms`);
        }
        process.exit(0);
      } else {
        console.error('❌ Multimodal processing failed:', result.error || 'Unknown error');
        process.exit(1);
      }
    } catch (error) {
      logger.error('Multimodal processing failed', error as Error);
      console.error('❌ Failed to process files:', (error as Error).message);
      console.log('\n💡 Tips:');
      console.log('   1. Ensure all files exist and are accessible');
      console.log('   2. Check supported formats: images, PDFs, audio, text');
      console.log('   3. Verify API keys: cgmb auth-status');
      process.exit(1);
    }
  });

// Info command
program
  .command('info')
  .description('Show CGMB system information')
  .option('--env', 'Show detailed environment information')
  .action(async (options) => {
    try {
      // Load environment variables
      const envResult = await loadEnvironmentSmart({ verbose: false });
      
      console.log('🚀 CGMB System Information');
      console.log('═'.repeat(50));
      console.log(`Version: ${packageJson.version}`);
      console.log(`Node.js: ${process.version}`);
      console.log(`Platform: ${process.platform}`);
      console.log(`Architecture: ${process.arch}`);
      console.log(`Working Directory: ${process.cwd()}`);
      console.log('');

      // Environment loading status
      console.log('📋 Environment Configuration');
      console.log('═'.repeat(30));
      const envStatus = getEnvironmentStatus();
      
      if (envStatus.loaded) {
        console.log(`✅ Environment: Loaded successfully`);
        console.log(`📁 Source: ${envStatus.source}`);
      } else {
        console.log(`❌ Environment: Not loaded properly`);
      }
      
      if (envStatus.foundFiles.length > 0) {
        console.log(`📄 Found .env files:`);
        envStatus.foundFiles.forEach(file => console.log(`   • ${file}`));
      }
      
      if (envStatus.errors.length > 0) {
        console.log(`⚠️  Errors:`);
        envStatus.errors.forEach(error => console.log(`   • ${error}`));
      }
      
      console.log('');

      // Key environment variables
      console.log('🔑 Key Environment Variables');
      console.log('═'.repeat(30));
      Object.entries(envStatus.availableVars).forEach(([key, isSet]) => {
        const icon = isSet ? '✅' : '❌';
        if (key.includes('KEY') && isSet) {
          const value = process.env[key];
          const masked = value ? `${value.substring(0, 8)}...${value.slice(-4)}` : 'Not set';
          console.log(`${icon} ${key}: ${masked}`);
        } else {
          const value = process.env[key];
          console.log(`${icon} ${key}: ${value || 'Not set'}`);
        }
      });

      if (options.env) {
        console.log('');
        console.log('🔍 Detailed Environment Information');
        console.log('═'.repeat(35));
        console.log(`Environment loading result:`, JSON.stringify(envResult, null, 2));
        console.log(`Environment status:`, JSON.stringify(envStatus, null, 2));
      }
      
    } catch (error) {
      logger.error('Failed to get system information', error as Error);
      process.exit(1);
    }
  });

// Helper functions
async function checkDependency(command: string, name: string): Promise<void> {
  try {
    execSync(`which ${command}`, { stdio: 'ignore' });
    logger.info(`✓ ${name} is installed`);
  } catch (error) {
    logger.warn(`⚠ ${name} not found in PATH`);
    logger.info(`Please install ${name} and ensure it's in your PATH`);
  }
}

/**
 * Report on the search-layer CLI using the same resolver the runtime uses, so a
 * `cgmb setup` result can never disagree with what the layer will actually do.
 */
async function checkAntigravityDependency(): Promise<void> {
  const binary = await findAntigravityBinary();

  if (!binary) {
    logger.warn('⚠ Antigravity CLI (agy) not found');
    logger.info(`Install it with: ${AGY_INSTALL_HINT}`);
    return;
  }

  if (!binary.versionSupported) {
    logger.warn(`⚠ Antigravity CLI ${binary.version ?? 'unknown'} is too old (need ${MIN_AGY_VERSION}+)`);
    logger.info('Update it with: agy update');
    return;
  }

  logger.info(`✓ Antigravity CLI is installed (${binary.version ?? 'version unknown'})`);
}

async function checkCommand(command: string): Promise<boolean> {
  try {
    execSync(command, { stdio: 'ignore' });
    return true;
  } catch (error) {
    throw new Error(`Command failed: ${command}`);
  }
}

// Handle unknown options with helpful error messages
program.on('option:*', function(this: any) {
  const unknownOption = this.args[0];
  if (unknownOption === '--search' || unknownOption === '--grounding') {
    console.error(`\nError: Unknown option '${unknownOption}'`);
    console.error(`\n💡 Web search is enabled by default in Gemini CLI - no flags needed!`);
    console.error(`\nJust use: cgmb gemini -p "your question"`);
    console.error(`\nGemini will automatically use web search when beneficial.\n`);
    process.exit(1);
  }
});

// Parse command line arguments
program.parse();

// If no command provided, show help
if (!process.argv.slice(2).length) {
  program.outputHelp();
}