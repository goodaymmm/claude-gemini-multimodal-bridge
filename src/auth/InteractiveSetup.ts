import { SetupResult, AuthResult } from '../core/types.js';
import { logger } from '../utils/logger.js';
import { safeExecute } from '../utils/errorHandler.js';
import { OAuthManager } from './OAuthManager.js';
import { AuthVerifier } from './AuthVerifier.js';
import { AuthStateManager } from './AuthStateManager.js';

/**
 * InteractiveSetup provides user-guided authentication setup wizard
 * Handles step-by-step guidance for each service with clear instructions
 */
export class InteractiveSetup {
  private oauthManager: OAuthManager;
  private authVerifier: AuthVerifier;
  private authStateManager: AuthStateManager;

  constructor() {
    this.oauthManager = new OAuthManager();
    this.authVerifier = new AuthVerifier();
    this.authStateManager = new AuthStateManager();
  }

  /**
   * Run complete authentication setup wizard
   */
  async runAuthSetupWizard(): Promise<SetupResult> {
    return safeExecute(
      async () => {
        logger.info('Starting CGMB Authentication Setup Wizard...');
        
        console.log('\n🚀 Welcome to CGMB Authentication Setup\n');
        console.log('This wizard will help you set up authentication for all required services.\n');
        
        const servicesConfigured: string[] = [];
        const errors: string[] = [];
        
        // Step 1: Gemini CLI Authentication
        try {
          console.log('═══════════════════════════════════════');
          console.log('STEP 1: Gemini CLI Authentication');
          console.log('═══════════════════════════════════════\n');
          
          const geminiResult = await this.setupGeminiAuth();
          if (geminiResult.success) {
            servicesConfigured.push('gemini');
            console.log('✅ Gemini authentication configured successfully!\n');
          } else {
            errors.push(`Gemini: ${geminiResult.error}`);
            console.log(`❌ Gemini authentication failed: ${geminiResult.error}\n`);
          }
        } catch (error) {
          const errorMsg = `Gemini setup failed: ${(error as Error).message}`;
          errors.push(errorMsg);
          console.log(`❌ ${errorMsg}\n`);
        }

        // Step 2: Google AI Studio API Key
        try {
          console.log('═══════════════════════════════════════');
          console.log('STEP 2: Google AI Studio API Key');
          console.log('═══════════════════════════════════════\n');
          
          const aiStudioResult = await this.setupAIStudioAuth();
          if (aiStudioResult.success) {
            servicesConfigured.push('aistudio');
            console.log('✅ AI Studio authentication configured successfully!\n');
          } else {
            errors.push(`AI Studio: ${aiStudioResult.error}`);
            console.log(`❌ AI Studio authentication failed: ${aiStudioResult.error}\n`);
          }
        } catch (error) {
          const errorMsg = `AI Studio setup failed: ${(error as Error).message}`;
          errors.push(errorMsg);
          console.log(`❌ ${errorMsg}\n`);
        }

        // Step 3: Claude Code
        try {
          console.log('═══════════════════════════════════════');
          console.log('STEP 3: Claude Code CLI');
          console.log('═══════════════════════════════════════\n');
          
          const claudeResult = await this.setupClaudeCodeAuth();
          if (claudeResult.success) {
            servicesConfigured.push('claude');
            console.log('✅ Claude Code authentication configured successfully!\n');
          } else {
            errors.push(`Claude Code: ${claudeResult.error}`);
            console.log(`❌ Claude Code authentication failed: ${claudeResult.error}\n`);
          }
        } catch (error) {
          const errorMsg = `Claude Code setup failed: ${(error as Error).message}`;
          errors.push(errorMsg);
          console.log(`❌ ${errorMsg}\n`);
        }

        // Step 4: Verification
        console.log('═══════════════════════════════════════');
        console.log('STEP 4: Final Verification');
        console.log('═══════════════════════════════════════\n');
        
        const verificationResult = await this.verifyAllSetup();
        
        // Generate next steps
        const nextSteps: string[] = [];
        if (errors.length > 0) {
          nextSteps.push('Review and fix authentication issues listed above');
          nextSteps.push('Run "cgmb auth-status --verbose" to check current status');
          nextSteps.push('Use "cgmb setup-guide" for detailed setup instructions');
        } else {
          nextSteps.push('All services configured! You can now use CGMB features');
          nextSteps.push('Try "cgmb verify" to confirm everything is working');
          nextSteps.push('Run "claude --help" to see enhanced capabilities');
        }

        const success = errors.length === 0;
        
        console.log('\n═══════════════════════════════════════');
        console.log('SETUP COMPLETE');
        console.log('═══════════════════════════════════════');
        console.log(`✅ Services configured: ${servicesConfigured.length}`);
        console.log(`❌ Errors encountered: ${errors.length}`);
        console.log(`📊 Overall status: ${success ? 'SUCCESS' : 'PARTIAL'}\n`);
        
        if (nextSteps.length > 0) {
          console.log('📋 Next Steps:');
          nextSteps.forEach((step, index) => {
            console.log(`   ${index + 1}. ${step}`);
          });
          console.log('');
        }
        
        logger.info('Authentication setup wizard completed', {
          success,
          servicesConfigured: servicesConfigured.length,
          errors: errors.length,
        });

        return {
          success,
          servicesConfigured,
          errors,
          nextSteps,
        };
      },
      {
        operationName: 'run-auth-setup-wizard',
        layer: 'claude',
        timeout: 300000, // 5 minutes for interactive setup
      }
    );
  }

  /**
   * Setup Gemini CLI authentication
   */
  private async setupGeminiAuth(): Promise<AuthResult> {
    console.log('Setting up Gemini CLI authentication...\n');
    
    // Check current status first
    const currentStatus = await this.authVerifier.verifyGeminiAuth();
    if (currentStatus.success) {
      console.log('ℹ️  Gemini is already authenticated!');
      return currentStatus;
    }

    console.log('Gemini authentication methods:');
    console.log('1. OAuth (RECOMMENDED) - Free, secure, no API key needed');
    console.log('2. API Key (Alternative) - Requires Google AI Studio API key\n');
    
    // For now, we'll guide through both methods
    // In a real interactive setup, we'd prompt for user choice
    
    // Try OAuth method first (recommended)
    console.log('🔄 Trying OAuth authentication (recommended)...');
    try {
      const authSuccess = await this.oauthManager.promptGeminiLogin();
      if (authSuccess) {
        const result = await this.authVerifier.verifyGeminiAuth();
        return result;
      }
    } catch (error) {
      console.log(`⚠️  OAuth authentication not available: ${(error as Error).message}`);
      console.log('\n📋 To set up OAuth authentication:');
      console.log('   1. Install Gemini CLI: npm install -g @google/gemini-cli');
      console.log('   2. Run: gemini auth');
      console.log('   3. Follow browser authentication flow');
      console.log('   4. Grant permissions when prompted\n');
    }

    // Check if API key is available as fallback
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    
    if (apiKey) {
      console.log('🔄 Trying API key authentication (fallback)...');
      console.log('   Validating API key...');
      
      if (this.oauthManager.validateApiKey(apiKey)) {
        console.log('✅ API key format is valid');
        
        // Re-verify with API key
        const result = await this.authVerifier.verifyGeminiAuth();
        if (result.success) {
          return result;
        }
      } else {
        console.log('❌ API key format is invalid');
        console.log('   Please check your API key from https://aistudio.google.com/');
      }
    } else {
      console.log('\n📋 Alternative: API key authentication');
      console.log('   1. Visit: https://aistudio.google.com/');
      console.log('   2. Click "Get API Key"');
      console.log('   3. Create new API key');
      console.log('   4. Set environment variable: GEMINI_API_KEY=your_key_here');
      console.log('   5. Restart your terminal/application\n');
    }

    return {
      success: false,
      status: {
        isAuthenticated: false,
        method: 'oauth',
        userInfo: undefined,
      },
      error: 'Authentication setup incomplete',
      requiresAction: true,
      actionInstructions: 'Complete either API key or OAuth setup as described above',
    };
  }

  /**
   * Setup AI Studio authentication
   */
  private async setupAIStudioAuth(): Promise<AuthResult> {
    console.log('Setting up Google AI Studio authentication...\n');
    
    // Check current status
    const currentStatus = await this.authVerifier.verifyAIStudioAuth();
    if (currentStatus.success) {
      console.log('ℹ️  AI Studio is already authenticated!');
      return currentStatus;
    }

    console.log('ℹ️  AI Studio authentication:');
    console.log('   - If Gemini OAuth is working: AI Studio will work automatically');
    console.log('   - Otherwise: Uses the same API key as Gemini CLI\n');
    
    // First check if Gemini OAuth is available (shared authentication)
    const geminiStatus = await this.authVerifier.verifyGeminiAuth();
    if (geminiStatus.success && geminiStatus.status.method === 'oauth') {
      console.log('✅ Using shared authentication from Gemini OAuth');
      return {
        success: true,
        status: {
          isAuthenticated: true,
          method: 'oauth',
          userInfo: geminiStatus.status.userInfo,
        },
        requiresAction: false,
      };
    }
    
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_STUDIO_API_KEY;
    
    if (!apiKey) {
      console.log('⚠️  No API key found - AI Studio requires API key if OAuth not available');
      console.log('\n📋 To set up AI Studio API key:');
      console.log('   1. Visit: https://aistudio.google.com/');
      console.log('   2. Sign in with Google account');
      console.log('   3. Navigate to "Get API Key" section');
      console.log('   4. Create new API key');
      console.log('   5. Copy the key and set: GEMINI_API_KEY=your_key_here');
      console.log('   6. Note: Same key works for both Gemini CLI and AI Studio\n');
      
      return {
        success: false,
        status: {
          isAuthenticated: false,
          method: 'api_key',
          userInfo: undefined,
        },
        error: 'API key not configured',
        requiresAction: true,
        actionInstructions: 'Set GEMINI_API_KEY environment variable',
      };
    }

    console.log(`✅ API key found: ${this.oauthManager.maskApiKey(apiKey)}`);
    
    if (!this.oauthManager.validateApiKey(apiKey)) {
      console.log('❌ API key format appears invalid');
      console.log('   Please verify your API key from https://aistudio.google.com/');
      
      return {
        success: false,
        status: {
          isAuthenticated: false,
          method: 'api_key',
          userInfo: undefined,
        },
        error: 'Invalid API key format',
        requiresAction: true,
        actionInstructions: 'Verify and update your GEMINI_API_KEY',
      };
    }

    // Check AI Studio MCP availability
    console.log('🔄 Checking AI Studio MCP server availability...');
    const result = await this.authVerifier.verifyAIStudioAuth();
    
    if (!result.success && result.error?.includes('MCP server')) {
      console.log('ℹ️  AI Studio MCP server not found');
      console.log('\n📋 To install AI Studio MCP server:');
      console.log('   1. Run: npm install -g aistudio-mcp-server');
      console.log('   2. Verify installation: npx aistudio-mcp-server --version\n');
    }

    return result;
  }

  /**
   * Setup Claude Code authentication
   */
  private async setupClaudeCodeAuth(): Promise<AuthResult> {
    console.log('Setting up Claude Code CLI authentication...\n');
    
    // Check current status
    const currentStatus = await this.authVerifier.verifyClaudeCodeAuth();
    if (currentStatus.success) {
      console.log('ℹ️  Claude Code is already authenticated!');
      return currentStatus;
    }

    console.log('🔄 Checking Claude Code installation...');
    
    const result = await this.authVerifier.verifyClaudeCodeAuth();
    
    if (!result.success) {
      if (result.error?.includes('not installed')) {
        console.log('❌ Claude Code not found');
        console.log('\n📋 To install Claude Code:');
        console.log('   1. Run: npm install -g @anthropic-ai/claude-code');
        console.log('   2. Verify installation: claude --version');
        console.log('   3. If authentication is required: claude auth');
        console.log('   4. Follow authentication instructions\n');
      } else if (result.error?.includes('authentication')) {
        console.log('❌ Claude Code authentication required');
        console.log('\n📋 To authenticate Claude Code:');
        console.log('   1. Run: claude auth');
        console.log('   2. Follow authentication instructions');
        console.log('   3. Complete any required setup steps\n');
      } else {
        console.log(`❌ Claude Code issue: ${result.error}`);
        console.log('\n📋 To resolve Claude Code issues:');
        console.log('   1. Ensure Claude Code is properly installed');
        console.log('   2. Check that it\'s in your PATH');
        console.log('   3. Run authentication if needed: claude auth\n');
      }
    }

    return result;
  }

  /**
   * Verify all setup
   */
  private async verifyAllSetup(): Promise<boolean> {
    console.log('🔄 Verifying all authentication setups...\n');
    
    const verificationResult = await this.authVerifier.verifyAllAuthentications();
    
    console.log('📊 Verification Results:');
    Object.entries(verificationResult.services).forEach(([service, result]) => {
      const icon = result.success ? '✅' : '❌';
      const status = result.success ? 'Authenticated' : 'Not Authenticated';
      console.log(`   ${icon} ${service}: ${status}`);
      
      if (!result.success && result.actionInstructions) {
        console.log(`      → ${result.actionInstructions}`);
      }
    });
    
    console.log(`\n📈 Overall: ${verificationResult.overall ? 'SUCCESS' : 'NEEDS ATTENTION'}`);
    
    if (verificationResult.recommendations.length > 0) {
      console.log('\n💡 Recommendations:');
      verificationResult.recommendations.forEach(rec => {
        console.log(`   • ${rec}`);
      });
    }
    
    return verificationResult.overall;
  }

  /**
   * Setup specific service authentication
   */
  async setupServiceAuth(service: 'gemini' | 'aistudio' | 'claude'): Promise<AuthResult> {
    switch (service) {
      case 'gemini':
        return this.setupGeminiAuth();
      case 'aistudio':
        return this.setupAIStudioAuth();
      case 'claude':
        return this.setupClaudeCodeAuth();
      default:
        throw new Error(`Unknown service: ${service}`);
    }
  }

  /**
   * Quick setup check - returns services that need setup
   */
  async getServicesNeedingSetup(): Promise<string[]> {
    const result = await this.authVerifier.verifyAllAuthentications();
    
    return Object.entries(result.services)
      .filter(([_, serviceResult]) => !serviceResult.success)
      .map(([service, _]) => service);
  }

  /**
   * Display setup guide without interactive prompts
   */
  displaySetupGuide(): void {
    console.log(`
🚀 CGMB Authentication Setup Guide

This guide will help you set up authentication for all services.
💡 TIP: OAuth authentication is recommended (no API keys needed!)

STEP 1: Gemini Authentication
==============================
🥇 RECOMMENDED: OAuth (Free & Secure)
1. Install: npm install -g @google/gemini-cli
2. Run: gemini auth
3. Follow browser authentication flow
4. Grant permissions when prompted

🔄 ALTERNATIVE: API Key (If OAuth not available)
1. Visit: https://aistudio.google.com/
2. Click "Get API Key"
3. Create new API key
4. Set environment: GEMINI_API_KEY=your_key_here

STEP 2: Claude Code CLI
========================
🆓 FREE TIER: Uses built-in Claude Code authentication
- No additional setup needed if using free tier

💰 PAID TIER: Optional API key for rate limit bypass
1. Install: npm install -g @anthropic-ai/claude-code
2. Set CLAUDE_API_KEY=your_key_here (optional)

STEP 3: Google AI Studio
=========================
ℹ️  Auto-configured if Gemini OAuth is working
- Uses shared authentication from Gemini OAuth
- Falls back to same API key as Gemini if needed

STEP 4: Verify Setup
=====================
Run: cgmb auth-status --verbose

🚀 Quick Start: cgmb auth --interactive
📊 Check Usage: cgmb quota-status
🔍 Find Tools: cgmb detect-paths
    `);
  }
}