import { spawn } from 'child_process';
import { ClaudeRequest, ClaudeResponse, EnhancementPlan, RequestAnalysis } from '../core/types.js';
import { logger } from '../utils/logger.js';
import { safeExecute } from '../utils/errorHandler.js';
import { RequestAnalyzer } from './RequestAnalyzer.js';
import { CapabilityDetector } from '../intelligence/CapabilityDetector.js';
import { LayerManager } from '../core/LayerManager.js';

/**
 * ClaudeProxy is the main proxy controller that intercepts claude commands
 * Provides transparent enhancement without breaking existing workflows
 */
export class ClaudeProxy {
  private requestAnalyzer: RequestAnalyzer;
  private capabilityDetector: CapabilityDetector;
  private layerManager: LayerManager;
  private readonly ORIGINAL_CLAUDE_PATHS = [
    'claude-original',
    '/usr/local/bin/claude-original',
    '/opt/homebrew/bin/claude-original',
  ];

  constructor() {
    this.requestAnalyzer = new RequestAnalyzer();
    this.capabilityDetector = new CapabilityDetector();
    this.layerManager = new LayerManager();
  }

  /**
   * Main entry point for handling Claude commands
   */
  async handleClaudeCommand(args: string[]): Promise<void> {
    const startTime = Date.now();
    
    try {
      logger.info('Processing Claude command', { 
        args: args.length > 0 ? args : ['<empty>'],
        timestamp: new Date().toISOString(),
      });

      // Create request object
      const request: ClaudeRequest = {
        args,
        originalCommand: `claude ${args.join(' ')}`,
        workingDirectory: process.cwd(),
        environment: process.env,
        timestamp: new Date(),
      };

      // Analyze the request for enhancement opportunities
      const analysis = await this.requestAnalyzer.analyze(args);
      logger.debug('Request analysis completed', {
        canEnhance: analysis.canEnhance,
        enhancementType: analysis.enhancementType,
        confidence: analysis.confidence,
      });

      // Check if we have the capabilities needed
      if (analysis.canEnhance && !analysis.fallbackToOriginal) {
        const plan = await this.requestAnalyzer.generateEnhancementPlan(analysis);
        const capabilityCheck = await this.capabilityDetector.canExecuteEnhancement(plan);
        
        if (capabilityCheck.canExecute) {
          logger.info('Executing enhanced Claude command', {
            enhancementType: plan.type,
            layers: plan.layers,
            availableLayers: capabilityCheck.availableLayers,
          });
          
          await this.executeEnhanced(request, plan, analysis);
          return;
        } else {
          logger.warn('Enhancement not possible, falling back to original Claude', {
            requiredLayers: plan.layers,
            missingLayers: capabilityCheck.missingLayers,
          });
        }
      }

      // Fallback to original Claude Code
      logger.info('Executing original Claude command');
      await this.executePassthrough(request);
      
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error('Claude command execution failed', {
        error: (error as Error).message,
        args,
        duration,
      });
      
      // Emergency fallback
      await this.emergencyFallback(args);
    }
  }

  /**
   * Execute enhanced Claude command through layer system
   */
  private async executeEnhanced(
    request: ClaudeRequest, 
    plan: EnhancementPlan, 
    analysis: RequestAnalysis
  ): Promise<void> {
    return safeExecute(
      async () => {
        const startTime = Date.now();
        
        try {
          // Initialize layer manager if needed
          await this.layerManager.initialize();
          
          // Execute through layer system based on plan
          const result = await this.layerManager.executeWorkflow({
            steps: plan.layers.map((layer, index) => ({
              id: `step-${index}`,
              layer: layer as any,
              action: this.getActionForLayer(layer, analysis),
              input: {
                request: request.originalCommand,
                args: request.args,
                enhancementType: plan.type,
              },
              timeout: plan.estimatedDuration,
            })),
            timeout: plan.estimatedDuration ? plan.estimatedDuration + 30000 : 120000,
          });
          
          const duration = Date.now() - startTime;
          
          if (result.success) {
            // Enhanced execution succeeded
            logger.info('Enhanced execution completed successfully', {
              duration,
              layersUsed: Object.keys(result.results),
              totalCost: result.metadata.total_cost,
            });
            
            // Output the enhanced result
            this.outputEnhancedResult(result, plan);
          } else {
            logger.warn('Enhanced execution failed, falling back', {
              duration,
              errors: Object.values(result.results).filter(r => !r.success).map(r => r.error),
            });
            
            // Fallback to original Claude
            await this.executePassthrough(request);
          }
          
        } catch (error) {
          logger.error('Enhanced execution error', { 
            error: (error as Error).message,
            plan,
          });
          
          // Fallback to original Claude
          await this.executePassthrough(request);
        }
      },
      {
        operationName: 'execute-enhanced',
        layer: 'claude',
        timeout: plan.estimatedDuration ? plan.estimatedDuration + 60000 : 180000,
      }
    );
  }

  /**
   * Execute direct passthrough to original Claude Code
   */
  private async executePassthrough(request: ClaudeRequest): Promise<void> {
    return safeExecute(
      async () => {
        const claudePath = await this.findOriginalClaude();
        
        if (!claudePath) {
          throw new Error('Original Claude Code not found. Please ensure Claude Code is installed.');
        }
        
        logger.debug('Executing passthrough to original Claude', { 
          claudePath,
          args: request.args,
        });
        
        // Execute original Claude with inherited stdio
        await this.spawnClaudeProcess(claudePath, request.args);
      },
      {
        operationName: 'execute-passthrough',
        layer: 'claude',
        timeout: 300000, // 5 minutes for Claude operations
      }
    );
  }

  /**
   * Emergency fallback when everything else fails
   */
  private async emergencyFallback(args: string[]): Promise<void> {
    logger.warn('Executing emergency fallback');
    
    try {
      // Try to find and execute original Claude
      const claudePath = await this.findOriginalClaude();
      if (claudePath) {
        await this.spawnClaudeProcess(claudePath, args);
        return;
      }
    } catch (error) {
      logger.error('Emergency fallback failed', { error: (error as Error).message });
    }
    
    // Last resort: display helpful message
    console.error('CGMB Error: Unable to execute Claude command');
    console.error('Please ensure Claude Code is properly installed:');
    console.error('  npm install -g @anthropic-ai/claude-code');
    console.error('');
    console.error('For CGMB support: cgmb verify');
    process.exit(1);
  }

  /**
   * Find original Claude Code executable
   */
  private async findOriginalClaude(): Promise<string | null> {
    // Try each potential path for original Claude
    for (const path of this.ORIGINAL_CLAUDE_PATHS) {
      try {
        // Test if the path exists and is executable
        const { spawn: testSpawn } = await import('child_process');
        const child = testSpawn(path, ['--version'], { stdio: 'ignore' });
        
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            child.kill();
            reject(new Error('Timeout'));
          }, 5000);
          
          child.on('close', (code) => {
            clearTimeout(timeout);
            if (code === 0) {
              resolve();
            } else {
              reject(new Error(`Exit code: ${code}`));
            }
          });
          
          child.on('error', reject);
        });
        
        logger.debug('Found original Claude at', { path });
        return path;
        
      } catch {
        // Try next path
        continue;
      }
    }
    
    // Try system PATH
    try {
      const { execSync } = await import('child_process');
      const output = execSync('which claude 2>/dev/null || where claude 2>nul', { 
        encoding: 'utf8',
        stdio: 'pipe'
      });
      
      const paths = output.trim().split('\n').filter(p => p && !p.includes('cgmb'));
      if (paths.length > 0) {
        logger.debug('Found Claude in PATH', { path: paths[0] });
        return paths[0];
      }
    } catch {
      // System PATH lookup failed
    }
    
    logger.error('Original Claude Code not found');
    return null;
  }

  /**
   * Spawn Claude process with proper stdio handling
   */
  private async spawnClaudeProcess(claudePath: string, args: string[]): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const child = spawn(claudePath, args, {
        stdio: 'inherit', // Inherit parent's stdio
        cwd: process.cwd(),
        env: process.env,
      });
      
      child.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Claude process exited with code ${code}`));
        }
      });
      
      child.on('error', (error) => {
        reject(new Error(`Failed to start Claude process: ${error.message}`));
      });
      
      // Handle process termination signals
      process.on('SIGINT', () => {
        child.kill('SIGINT');
      });
      
      process.on('SIGTERM', () => {
        child.kill('SIGTERM');
      });
    });
  }

  /**
   * Get appropriate action for a layer based on analysis
   */
  private getActionForLayer(layer: string, analysis: RequestAnalysis): string {
    switch (layer) {
      case 'claude':
        if (analysis.enhancementType === 'reasoning') {
          return 'complex_reasoning';
        } else {
          return 'synthesize_response';
        }
      case 'gemini':
        if (analysis.enhancementType === 'grounding') {
          return 'grounded_search';
        } else {
          return 'contextual_analysis';
        }
      case 'aistudio':
        if (analysis.enhancementType === 'multimodal') {
          return 'multimodal_processing';
        } else {
          return 'document_analysis';
        }
      default:
        return 'execute';
    }
  }

  /**
   * Output enhanced result to user
   */
  private outputEnhancedResult(result: any, plan: EnhancementPlan): void {
    // Find the primary result (usually from the last successful layer)
    const layerResults = Object.values(result.results) as any[];
    const primaryResult = layerResults.find(r => r.success && r.data);
    
    if (primaryResult?.data) {
      if (typeof primaryResult.data === 'string') {
        console.log(primaryResult.data);
      } else if (primaryResult.data.content) {
        console.log(primaryResult.data.content);
      } else {
        console.log(JSON.stringify(primaryResult.data, null, 2));
      }
    } else {
      // Fallback: show summary
      console.log('Enhanced analysis completed successfully.');
      if (result.summary) {
        console.log(result.summary);
      }
    }
    
    // Optionally show enhancement info in debug mode
    if (process.env.CGMB_DEBUG) {
      console.error(`\n[CGMB Enhanced via ${plan.type}]`);
    }
  }

  /**
   * Quick capability check for startup validation
   */
  async validateStartup(): Promise<boolean> {
    try {
      const hasMinimal = await this.capabilityDetector.hasMinimalCapabilities();
      if (!hasMinimal) {
        logger.warn('Minimal capabilities not available');
        return false;
      }
      
      logger.info('CGMB proxy startup validation passed');
      return true;
    } catch (error) {
      logger.error('Startup validation failed', { error: (error as Error).message });
      return false;
    }
  }

  /**
   * Get proxy status for debugging
   */
  async getProxyStatus(): Promise<{
    status: 'ready' | 'degraded' | 'offline';
    capabilities: Awaited<ReturnType<typeof this.capabilityDetector.getCapabilityStatus>>;
    originalClaudeAvailable: boolean;
  }> {
    const capabilities = await this.capabilityDetector.getCapabilityStatus();
    const originalClaudeAvailable = (await this.findOriginalClaude()) !== null;
    
    let status: 'ready' | 'degraded' | 'offline';
    if (capabilities.overall === 'full' && originalClaudeAvailable) {
      status = 'ready';
    } else if (capabilities.overall === 'minimal' || originalClaudeAvailable) {
      status = 'degraded';
    } else {
      status = 'offline';
    }
    
    return {
      status,
      capabilities,
      originalClaudeAvailable,
    };
  }
}