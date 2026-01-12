import { execSync } from 'child_process';
import { AvailableCapabilities, EnhancementPlan } from '../core/types.js';
import { logger } from '../utils/logger.js';
import { safeExecute } from '../utils/errorHandler.js';
import { AuthVerifier } from '../auth/AuthVerifier.js';

/**
 * CapabilityDetector automatically detects available services on the system
 * Provides capability checking and validation for enhancement decisions
 */
export class CapabilityDetector {
  private authVerifier: AuthVerifier;
  private capabilitiesCache?: AvailableCapabilities;
  private readonly CACHE_TTL = 300000; // 5 minutes

  constructor() {
    this.authVerifier = new AuthVerifier();
  }

  /**
   * Detect all available capabilities on the system
   */
  async detectAvailableCapabilities(): Promise<AvailableCapabilities> {
    return safeExecute(
      async () => {
        // Check cache first
        if (this.capabilitiesCache && this.isCacheValid()) {
          logger.debug('Using cached capabilities');
          return this.capabilitiesCache;
        }

        logger.info('Detecting available capabilities...');
        const startTime = Date.now();

        const capabilities: AvailableCapabilities = {
          claudeCode: await this.detectClaudeCode(),
          geminiCLI: await this.detectGeminiCLI(),
          aiStudio: await this.detectAIStudio(),
          lastChecked: new Date(),
        };

        // Cache the results
        this.capabilitiesCache = capabilities;

        const duration = Date.now() - startTime;
        logger.info('Capability detection completed', {
          claudeCode: capabilities.claudeCode.available,
          geminiCLI: capabilities.geminiCLI.available,
          aiStudio: capabilities.aiStudio.available,
          duration,
        });

        return capabilities;
      },
      {
        operationName: 'detect-capabilities',
        layer: 'claude',
        timeout: 30000,
      }
    );
  }

  /**
   * Check if enhancement plan can be executed with available capabilities
   */
  async canExecuteEnhancement(plan: EnhancementPlan): Promise<{
    canExecute: boolean;
    availableLayers: string[];
    missingLayers: string[];
    fallbackRequired: boolean;
  }> {
    return safeExecute(
      async () => {
        const capabilities = await this.detectAvailableCapabilities();
        
        const availableLayers: string[] = [];
        const missingLayers: string[] = [];
        
        for (const layer of plan.layers) {
          const isAvailable = await this.isLayerAvailable(layer, capabilities);
          if (isAvailable) {
            availableLayers.push(layer);
          } else {
            missingLayers.push(layer);
          }
        }
        
        const canExecute = availableLayers.length > 0;
        const fallbackRequired = missingLayers.length > 0;
        
        logger.debug('Enhancement plan capability check', {
          planLayers: plan.layers,
          availableLayers,
          missingLayers,
          canExecute,
          fallbackRequired,
        });
        
        return {
          canExecute,
          availableLayers,
          missingLayers,
          fallbackRequired,
        };
      },
      {
        operationName: 'check-enhancement-capabilities',
        layer: 'claude',
        timeout: 10000,
      }
    );
  }

  /**
   * Get quick capability status for UI/logging
   */
  async getCapabilityStatus(): Promise<{
    overall: 'full' | 'partial' | 'minimal';
    services: Record<string, 'available' | 'authenticated' | 'missing'>;
    recommendations: string[];
  }> {
    const capabilities = await this.detectAvailableCapabilities();
    
    const services: Record<string, 'available' | 'authenticated' | 'missing'> = {};
    
    // Claude Code status
    if (capabilities.claudeCode.available && capabilities.claudeCode.authenticated) {
      services.claude = 'authenticated';
    } else if (capabilities.claudeCode.available) {
      services.claude = 'available';
    } else {
      services.claude = 'missing';
    }
    
    // Gemini CLI status
    if (capabilities.geminiCLI.available && capabilities.geminiCLI.authenticated) {
      services.gemini = 'authenticated';
    } else if (capabilities.geminiCLI.available) {
      services.gemini = 'available';
    } else {
      services.gemini = 'missing';
    }
    
    // AI Studio status
    if (capabilities.aiStudio.available && capabilities.aiStudio.authenticated) {
      services.aistudio = 'authenticated';
    } else if (capabilities.aiStudio.available) {
      services.aistudio = 'available';
    } else {
      services.aistudio = 'missing';
    }
    
    // Determine overall status
    const authenticatedCount = Object.values(services).filter(s => s === 'authenticated').length;
    const availableCount = Object.values(services).filter(s => s !== 'missing').length;
    
    let overall: 'full' | 'partial' | 'minimal';
    if (authenticatedCount === 3) {
      overall = 'full';
    } else if (authenticatedCount >= 1 || availableCount >= 2) {
      overall = 'partial';
    } else {
      overall = 'minimal';
    }
    
    // Generate recommendations
    const recommendations = this.generateRecommendations(services);
    
    return {
      overall,
      services,
      recommendations,
    };
  }

  /**
   * Check if a specific layer is available and ready
   */
  async isLayerAvailable(layer: string, capabilities?: AvailableCapabilities): Promise<boolean> {
    if (!capabilities) {
      capabilities = await this.detectAvailableCapabilities();
    }
    
    switch (layer) {
      case 'claude':
        return capabilities.claudeCode.available && capabilities.claudeCode.authenticated;
      case 'gemini':
        return capabilities.geminiCLI.available && capabilities.geminiCLI.authenticated;
      case 'aistudio':
        return capabilities.aiStudio.available && capabilities.aiStudio.authenticated && capabilities.aiStudio.mcpServerAvailable;
      default:
        return false;
    }
  }

  /**
   * Detect Claude Code capability
   */
  private async detectClaudeCode(): Promise<AvailableCapabilities['claudeCode']> {
    try {
      // Check if Claude Code is installed
      const claudePath = await this.findExecutablePath('claude');
      if (!claudePath) {
        return {
          available: false,
          authenticated: false,
        };
      }

      // Get version
      let version: string | undefined;
      try {
        const output = execSync('claude --version', { 
          encoding: 'utf8', 
          timeout: 5000,
          stdio: 'pipe'
        });
        version = output.trim();
      } catch {
        // Version command might not be available
      }

      // Check authentication status
      const authResult = await this.authVerifier.verifyClaudeCodeAuth();
      
      return {
        available: true,
        version,
        authenticated: authResult.success,
        path: claudePath,
      };
      
    } catch (error) {
      logger.debug('Claude Code detection failed', { error: (error as Error).message });
      return {
        available: false,
        authenticated: false,
      };
    }
  }

  /**
   * Detect Gemini CLI capability
   */
  private async detectGeminiCLI(): Promise<AvailableCapabilities['geminiCLI']> {
    try {
      // Check if Gemini CLI is installed
      const geminiPath = await this.findExecutablePath('gemini');
      if (!geminiPath) {
        return {
          available: false,
          authenticated: false,
        };
      }

      // Get version
      let version: string | undefined;
      try {
        const output = execSync('gemini --version', { 
          encoding: 'utf8', 
          timeout: 5000,
          stdio: 'pipe'
        });
        version = output.trim();
      } catch {
        // Version command might not be available
      }

      // Check authentication status
      const authResult = await this.authVerifier.verifyGeminiAuth();
      
      return {
        available: true,
        version,
        authenticated: authResult.success,
        path: geminiPath,
      };
      
    } catch (error) {
      logger.debug('Gemini CLI detection failed', { error: (error as Error).message });
      return {
        available: false,
        authenticated: false,
      };
    }
  }

  /**
   * Detect AI Studio capability
   */
  private async detectAIStudio(): Promise<AvailableCapabilities['aiStudio']> {
    try {
      // Check authentication status
      const authResult = await this.authVerifier.verifyAIStudioAuth();
      
      // MCP server check removed - using built-in MCP server
      return {
        available: authResult.success,
        authenticated: authResult.success,
        mcpServerAvailable: true, // Built-in MCP server always available
      };
      
    } catch (error) {
      logger.debug('AI Studio detection failed', { error: (error as Error).message });
      return {
        available: false,
        authenticated: false,
        mcpServerAvailable: true,
      };
    }
  }

  /**
   * Find executable path for a command
   */
  private async findExecutablePath(command: string): Promise<string | undefined> {
    try {
      const output = execSync(`which ${command}`, { 
        encoding: 'utf8',
        timeout: 5000,
        stdio: 'pipe'
      });
      return output.trim();
    } catch {
      try {
        // Try alternative method for Windows
        const output = execSync(`where ${command}`, { 
          encoding: 'utf8',
          timeout: 5000,
          stdio: 'pipe'
        });
        return output.split('\n')[0]?.trim();
      } catch {
        return undefined;
      }
    }
  }

  /**
   * Generate recommendations based on service status
   */
  private generateRecommendations(services: Record<string, string>): string[] {
    const recommendations: string[] = [];
    
    if (services.claude === 'missing') {
      recommendations.push('Install Claude Code: npm install -g @anthropic-ai/claude-code');
    } else if (services.claude === 'available') {
      recommendations.push('Authenticate Claude Code: claude auth');
    }
    
    if (services.gemini === 'missing') {
      recommendations.push('Install Gemini CLI: npm install -g @google/gemini-cli');
    } else if (services.gemini === 'available') {
      recommendations.push('Authenticate Gemini: gemini auth or set GEMINI_API_KEY');
    }
    
    if (services.aistudio === 'available') {
      recommendations.push('Set GEMINI_API_KEY for AI Studio access');
    }
    
    if (recommendations.length === 0) {
      recommendations.push('All services ready! CGMB is fully functional.');
    }
    
    return recommendations;
  }

  /**
   * Check if capabilities cache is still valid
   */
  private isCacheValid(): boolean {
    if (!this.capabilitiesCache) {
      return false;
    }
    
    const age = Date.now() - this.capabilitiesCache.lastChecked.getTime();
    return age < this.CACHE_TTL;
  }

  /**
   * Clear capabilities cache
   */
  clearCache(): void {
    this.capabilitiesCache = undefined as any;
    logger.debug('Capabilities cache cleared');
  }

  /**
   * Get minimal capability check (fast)
   */
  async hasMinimalCapabilities(): Promise<boolean> {
    try {
      const capabilities = await this.detectAvailableCapabilities();
      return capabilities.claudeCode.available; // At minimum, need Claude Code
    } catch {
      return false;
    }
  }

  /**
   * Get enhanced capability check (includes auth verification)
   */
  async hasEnhancedCapabilities(): Promise<boolean> {
    try {
      const capabilities = await this.detectAvailableCapabilities();
      return (
        capabilities.claudeCode.authenticated &&
        (capabilities.geminiCLI.authenticated || capabilities.aiStudio.authenticated)
      );
    } catch {
      return false;
    }
  }

  /**
   * Get detailed capability report for debugging
   */
  async getDetailedCapabilityReport(): Promise<{
    capabilities: AvailableCapabilities;
    status: Awaited<ReturnType<CapabilityDetector['getCapabilityStatus']>>;
    timestamp: Date;
  }> {
    const capabilities = await this.detectAvailableCapabilities();
    const status = await this.getCapabilityStatus();
    
    return {
      capabilities,
      status,
      timestamp: new Date(),
    };
  }
}