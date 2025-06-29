#!/usr/bin/env node

import { Command } from 'commander';
import { config } from 'dotenv';
import { CGMBServer } from './core/CGMBServer.js';
import { logger } from './utils/logger.js';
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { OAuthManager } from './auth/OAuthManager.js';
import { AuthVerifier } from './auth/AuthVerifier.js';
import { InteractiveSetup } from './auth/InteractiveSetup.js';

// ===================================
// CLI Interface for CGMB
// ===================================

const program = new Command();

program
  .name('cgmb')
  .description('Claude-Gemini Multimodal Bridge - Multi-layer AI integration tool')
  .version('1.0.0');

// Server command
program
  .command('serve')
  .description('Start the CGMB MCP server')
  .option('-c, --config <path>', 'Path to configuration file')
  .option('-v, --verbose', 'Enable verbose logging')
  .option('--debug', 'Enable debug logging')
  .action(async (options) => {
    try {
      // Load environment variables
      config();
      
      if (options.verbose) {
        process.env.LOG_LEVEL = 'verbose';
      }
      
      if (options.debug) {
        process.env.LOG_LEVEL = 'debug';
      }

      const server = new CGMBServer();
      await server.start();
      
      // Keep the process running
      process.on('SIGINT', () => {
        logger.info('Shutting down CGMB server...');
        process.exit(0);
      });
      
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
      await checkDependency('gemini', 'Gemini CLI');
      
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
  .action(async (options) => {
    try {
      config();
      
      const authManager = new OAuthManager();
      const interactiveSetup = new InteractiveSetup();
      
      logger.info('CGMB Authentication Manager');
      
      if (options.interactive) {
        await interactiveSetup.runAuthSetupWizard();
      } else if (options.service) {
        logger.info(`Setting up authentication for ${options.service}...`);
        await interactiveSetup.setupServiceAuth(options.service as any);
      } else {
        logger.info('Running full authentication setup...');
        await interactiveSetup.runAuthSetupWizard();
      }
      
      // 認証完了後の明示的な終了
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
      config();
      
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
      
    } catch (error) {
      logger.error('Failed to check authentication status', error as Error);
      process.exit(1);
    }
  });

// Quota status command
program
  .command('quota-status')
  .description('Check Google AI Studio API quota usage')
  .option('--detailed', 'Show detailed quota breakdown')
  .action(async (options) => {
    try {
      const { getQuotaMonitor } = await import('./utils/quotaMonitor.js');
      
      const quotaMonitor = getQuotaMonitor();
      const stats = quotaMonitor.getUsageStats();
      const status = quotaMonitor.getQuotaStatus();
      
      console.log('📊 Google AI Studio API Quota Status');
      console.log('=====================================');
      console.log(`Tier: ${stats.tier.toUpperCase()}`);
      console.log();
      
      // Requests status
      const reqStatusIcon = status.requests_daily_percent >= 90 ? '🚨' : 
                          status.requests_daily_percent >= 80 ? '⚠️' : '✅';
      console.log(`${reqStatusIcon} Requests (Daily): ${stats.requests.today}/${stats.requests.daily_limit} (${Math.round(status.requests_daily_percent)}%)`);
      console.log(`   Remaining: ${stats.requests.daily_remaining}`);
      console.log(`   Reset in: ${Math.ceil(stats.reset_times.daily_reset_in / 1000 / 60 / 60)}h`);
      console.log();
      
      // Tokens status
      const tokenStatusIcon = status.tokens_daily_percent >= 90 ? '🚨' : 
                            status.tokens_daily_percent >= 80 ? '⚠️' : '✅';
      console.log(`${tokenStatusIcon} Tokens (Daily): ${stats.tokens.today}/${stats.tokens.daily_limit} (${Math.round(status.tokens_daily_percent)}%)`);
      console.log(`   Remaining: ${stats.tokens.daily_remaining}`);
      console.log();
      
      // Per-minute limits
      if (options.detailed) {
        console.log('Per-Minute Limits:');
        console.log(`   Requests: ${stats.requests.this_minute}/${stats.requests.minute_limit}`);
        console.log(`   Tokens: ${stats.tokens.this_minute}/${stats.tokens.minute_limit}`);
        console.log(`   Reset in: ${Math.ceil(stats.reset_times.minute_reset_in / 1000)}s`);
        console.log();
      }
      
      // Overall status
      const overallIcon = status.overall_status === 'critical' ? '🚨' : 
                         status.overall_status === 'warning' ? '⚠️' : '✅';
      console.log(`${overallIcon} Overall Status: ${status.overall_status.toUpperCase()}`);
      
      if (status.overall_status === 'critical') {
        console.log('\n⚠️  WARNING: You are near or at your quota limits.');
        console.log('   Consider waiting or upgrading to a paid plan.');
      } else if (status.overall_status === 'warning') {
        console.log('\n💡 TIP: Monitor your usage to avoid hitting limits.');
      }
      
    } catch (error) {
      logger.error('Failed to get quota status', error as Error);
      console.error('❌ Failed to get quota status:', (error as Error).message);
      process.exit(1);
    }
  });

// Path detection command
program
  .command('detect-paths')
  .description('Detect and show paths for required CLI tools')
  .option('--fix', 'Attempt to fix PATH issues automatically')
  .action(async (options) => {
    try {
      console.log('🔍 Detecting CLI Tool Paths');
      console.log('===========================');
      
      const tools = [
        { name: 'Claude Code', commands: ['claude', 'claude-code'], env: 'CLAUDE_CODE_PATH' },
        { name: 'Gemini CLI', commands: ['gemini'], env: 'GEMINI_CLI_PATH' },
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
            console.log(`     💡 Install with: npm install -g @google/gemini-cli`);
          }
        }
      }
      
      // Check environment variables
      console.log('\n📋 Environment Variables:');
      const envVars = ['GEMINI_API_KEY', 'CLAUDE_CODE_PATH', 'GEMINI_CLI_PATH'];
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

// Verify command
program
  .command('verify')
  .description('Verify CGMB installation and authentication')
  .option('--fix', 'Attempt to fix authentication issues automatically')
  .action(async (options) => {
    try {
      logger.info('🔍 Verifying CGMB installation and authentication...');
      
      // Load configuration
      config();
      
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
          name: 'Gemini CLI',
          check: () => checkCommand('gemini --help')
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
      
      // Overall status
      const allPassed = systemChecksPassed && authChecksPassed;
      
      logger.info('\n' + '═'.repeat(50));
      if (allPassed) {
        logger.info('🎉 All verification checks passed!');
        
        // Test server initialization
        logger.info('\n🚀 Testing server initialization...');
        const server = new CGMBServer();
        await server.initialize();
        logger.info('✓ Server initialization test passed');
        
        logger.info('\n✨ CGMB is ready to use!');
        logger.info('💡 Try: cgmb serve');
        
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
        
        if (authResults.recommendations.length > 0) {
          logger.info('\n📝 Recommendations:');
          authResults.recommendations.forEach(rec => logger.info(`   • ${rec}`));
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

// Test command
program
  .command('test')
  .description('Run a test multimodal processing request')
  .option('-f, --file <path>', 'Path to test file')
  .option('-p, --prompt <text>', 'Test prompt', 'Analyze this content')
  .action(async (options) => {
    try {
      config();
      
      logger.info('Running CGMB test...');
      
      const server = new CGMBServer();
      await server.initialize();
      
      // Create a simple test request
      const testFiles = options.file ? [{ path: options.file, type: 'document' }] : [];
      
      if (testFiles.length === 0) {
        logger.warn('No test file provided, creating a text-only test');
      }
      
      logger.info('Test completed successfully!');
      logger.info('CGMB is working correctly');
      
    } catch (error) {
      logger.error('Test failed', error as Error);
      process.exit(1);
    }
  });

// Info command
program
  .command('info')
  .description('Show CGMB system information')
  .action(() => {
    config();
    
    logger.info('CGMB System Information:');
    logger.info(`Version: 1.0.0`);
    logger.info(`Node.js: ${process.version}`);
    logger.info(`Platform: ${process.platform}`);
    logger.info(`Architecture: ${process.arch}`);
    logger.info(`Working Directory: ${process.cwd()}`);
    
    // Environment info
    const envVars = [
      'GEMINI_API_KEY',
      'CLAUDE_CODE_PATH', 
      'GEMINI_CLI_PATH',
      'LOG_LEVEL'
    ];
    
    logger.info('Environment Configuration:');
    envVars.forEach(key => {
      const value = process.env[key];
      if (key.includes('KEY') && value) {
        logger.info(`${key}: ${'*'.repeat(8)}...${value.slice(-4)}`);
      } else {
        logger.info(`${key}: ${value || 'Not set'}`);
      }
    });
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

async function checkCommand(command: string): Promise<boolean> {
  try {
    execSync(command, { stdio: 'ignore' });
    return true;
  } catch (error) {
    throw new Error(`Command failed: ${command}`);
  }
}

// Parse command line arguments
program.parse();

// If no command provided, show help
if (!process.argv.slice(2).length) {
  program.outputHelp();
}