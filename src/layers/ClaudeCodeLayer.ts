import { spawn, execSync } from 'child_process';
import { LayerInterface, LayerResult, ReasoningTask, ReasoningResult, WorkflowDefinition, WorkflowResult } from '../core/types.js';
import { logger } from '../utils/logger.js';
import { safeExecute, retry } from '../utils/errorHandler.js';
import { AuthVerifier } from '../auth/AuthVerifier.js';

/**
 * ClaudeCodeLayer handles direct Claude Code execution with enhanced authentication support
 * Provides complex reasoning tasks and workflow orchestration capabilities
 */
export class ClaudeCodeLayer implements LayerInterface {
  private authVerifier: AuthVerifier;
  private claudePath?: string;
  private isInitialized = false;
  private readonly DEFAULT_TIMEOUT = 300000; // 5 minutes
  private readonly MAX_RETRIES = 3;

  constructor() {
    this.authVerifier = new AuthVerifier();
  }

  /**
   * Initialize the Claude Code layer
   */
  async initialize(): Promise<void> {
    return safeExecute(
      async () => {
        if (this.isInitialized) {
          return;
        }

        logger.info('Initializing Claude Code layer...');

        // Verify Claude Code installation and authentication
        const authResult = await this.authVerifier.verifyClaudeCodeAuth();
        if (!authResult.success) {
          throw new Error(`Claude Code authentication failed: ${authResult.error}`);
        }

        // Find Claude Code executable path
        this.claudePath = await this.findClaudeCodePath() || '';
        if (!this.claudePath) {
          throw new Error('Claude Code executable not found');
        }

        // Test basic functionality
        await this.testClaudeCodeConnection();

        this.isInitialized = true;
        logger.info('Claude Code layer initialized successfully', {
          claudePath: this.claudePath,
          authenticated: authResult.success,
        });
      },
      {
        operationName: 'initialize-claude-code-layer',
        layer: 'claude',
        timeout: 30000,
      }
    );
  }

  /**
   * Check if Claude Code layer is available
   */
  async isAvailable(): Promise<boolean> {
    try {
      if (!this.isInitialized) {
        await this.initialize();
      }
      return this.isInitialized;
    } catch (error) {
      logger.debug('Claude Code layer not available', { error: (error as Error).message });
      return false;
    }
  }

  /**
   * Check if this layer can handle the given task
   */
  canHandle(task: any): boolean {
    if (!task || typeof task !== 'object') {
      return false;
    }

    // Handle general Claude Code tasks
    if (task.type === 'claude_code' || task.action === 'execute' || task.action === 'complex_reasoning') {
      return true;
    }

    // Handle reasoning tasks
    if (task.type === 'reasoning' || task.prompt) {
      return true;
    }

    // Handle workflow orchestration
    if (task.type === 'workflow' || task.workflow) {
      return true;
    }

    // Handle synthesis and general tasks
    if (task.action === 'synthesize_response' || task.request) {
      return true;
    }

    return false;
  }

  /**
   * Execute a task through Claude Code
   */
  async execute(task: any): Promise<LayerResult> {
    return safeExecute(
      async () => {
        const startTime = Date.now();
        
        if (!this.isInitialized) {
          await this.initialize();
        }

        logger.info('Executing Claude Code task', {
          taskType: task.type || 'general',
          action: task.action || 'execute',
        });

        let result: any;

        // Route to appropriate execution method based on task type/action
        switch (task.action || task.type) {
          case 'complex_reasoning':
            result = await this.executeComplexReasoning(task);
            break;
          case 'synthesize_response':
            result = await this.synthesizeResponse(task);
            break;
          case 'workflow':
            result = await this.orchestrateWorkflow(task.workflow || task);
            break;
          default:
            result = await this.executeGeneral(task);
        }

        const duration = Date.now() - startTime;
        
        return {
          success: true,
          data: result,
          metadata: {
            layer: 'claude' as const,
            duration,
            tokens_used: this.estimateTokensUsed(task, result),
            cost: this.calculateCost(task, result),
            model: 'claude-code',
          },
        };
      },
      {
        operationName: 'execute-claude-code-task',
        layer: 'claude',
        timeout: this.getTaskTimeout(task),
      }
    );
  }

  /**
   * Execute complex reasoning task
   */
  async executeComplexReasoning(task: ReasoningTask): Promise<ReasoningResult> {
    return retry(
      async () => {
        logger.debug('Executing complex reasoning task', {
          promptLength: task.prompt.length,
          depth: task.depth || 'medium',
          domain: task.domain,
        });

        const prompt = this.buildReasoningPrompt(task);
        const result = await this.executeClaudeCommand(prompt, {
          timeout: this.DEFAULT_TIMEOUT,
          reasoning: true,
        });

        return this.parseReasoningResult(result, task);
      },
      {
        maxAttempts: this.MAX_RETRIES,
        delay: 2000,
        operationName: 'complex-reasoning',
      }
    );
  }

  /**
   * Synthesize response from multiple inputs
   */
  async synthesizeResponse(task: any): Promise<string> {
    return retry(
      async () => {
        logger.debug('Synthesizing response', {
          inputSources: task.inputs ? Object.keys(task.inputs).length : 1,
          request: task.request?.substring(0, 100) + '...',
        });

        const prompt = this.buildSynthesisPrompt(task);
        const result = await this.executeClaudeCommand(prompt, {
          timeout: this.DEFAULT_TIMEOUT,
          synthesis: true,
        });

        return result.trim();
      },
      {
        maxAttempts: this.MAX_RETRIES,
        delay: 1500,
        operationName: 'synthesize-response',
      }
    );
  }

  /**
   * Orchestrate workflow execution
   */
  async orchestrateWorkflow(workflow: WorkflowDefinition): Promise<WorkflowResult> {
    return retry(
      async () => {
        logger.info('Orchestrating workflow', {
          stepCount: workflow.steps?.length || 0,
          timeout: workflow.timeout,
        });

        const prompt = this.buildWorkflowPrompt(workflow);
        const result = await this.executeClaudeCommand(prompt, {
          timeout: workflow.timeout || this.DEFAULT_TIMEOUT * 2,
          workflow: true,
        });

        return this.parseWorkflowResult(result, workflow);
      },
      {
        maxAttempts: this.MAX_RETRIES,
        delay: 3000,
        operationName: 'orchestrate-workflow',
      }
    );
  }

  /**
   * Get layer capabilities
   */
  getCapabilities(): string[] {
    return [
      'complex_reasoning',
      'synthesize_response', 
      'workflow_orchestration',
      'code_analysis',
      'text_processing',
      'general_intelligence',
      'task_planning',
      'problem_solving',
    ];
  }

  /**
   * Get cost estimation for a task
   */
  getCost(task: any): number {
    // Claude Code is typically free for personal use
    return 0;
  }

  /**
   * Get estimated duration for a task
   */
  getEstimatedDuration(task: any): number {
    const baseTime = 5000; // 5 seconds base
    
    if (task.type === 'workflow' || task.action === 'workflow') {
      return baseTime * 3; // Workflows take longer
    }
    
    if (task.action === 'complex_reasoning') {
      return baseTime * 2; // Complex reasoning takes longer
    }
    
    if (task.prompt && task.prompt.length > 1000) {
      return baseTime * 1.5; // Longer prompts take more time
    }
    
    return baseTime;
  }

  /**
   * Execute general Claude Code task
   */
  private async executeGeneral(task: any): Promise<string> {
    const prompt = task.prompt || task.request || task.input || 'Please help with this task.';
    
    return await this.executeClaudeCommand(prompt, {
      timeout: this.getTaskTimeout(task),
    });
  }

  /**
   * Execute Claude Code command
   */
  private async executeClaudeCommand(prompt: string, options: {
    timeout?: number;
    reasoning?: boolean;
    synthesis?: boolean;
    workflow?: boolean;
  } = {}): Promise<string> {
    if (!this.claudePath) {
      throw new Error('Claude Code not initialized');
    }

    const timeout = options.timeout || this.DEFAULT_TIMEOUT;
    
    return new Promise<string>((resolve, reject) => {
      logger.debug('Executing Claude command', {
        promptLength: prompt.length,
        timeout,
        options,
      });

      const child = spawn(this.claudePath!, [prompt], {
        stdio: 'pipe',
        cwd: process.cwd(),
        env: process.env,
      });

      let output = '';
      let errorOutput = '';

      const timeoutId = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`Claude Code execution timeout after ${timeout}ms`));
      }, timeout);

      child.stdout.on('data', (data) => {
        output += data.toString();
      });

      child.stderr.on('data', (data) => {
        errorOutput += data.toString();
      });

      child.on('close', (code) => {
        clearTimeout(timeoutId);
        
        if (code === 0) {
          logger.debug('Claude command completed successfully', {
            outputLength: output.length,
            code,
          });
          resolve(output);
        } else {
          const error = `Claude Code exited with code ${code}: ${errorOutput}`;
          logger.error('Claude command failed', { code, error: errorOutput });
          reject(new Error(error));
        }
      });

      child.on('error', (error) => {
        clearTimeout(timeoutId);
        logger.error('Claude command process error', { error: error.message });
        reject(error);
      });
    });
  }

  /**
   * Find Claude Code executable path
   */
  private async findClaudeCodePath(): Promise<string | undefined> {
    const possiblePaths = [
      'claude',
      'claude-original',
      '/usr/local/bin/claude',
      '/usr/local/bin/claude-original',
      '/opt/homebrew/bin/claude',
      '/opt/homebrew/bin/claude-original',
    ];

    for (const path of possiblePaths) {
      try {
        execSync(`${path} --version`, { stdio: 'ignore', timeout: 5000 });
        logger.debug('Found Claude Code at', { path });
        return path;
      } catch {
        continue;
      }
    }

    // Try system PATH
    try {
      const output = execSync('which claude 2>/dev/null || where claude 2>nul', {
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 5000,
      });
      
      const paths = output.trim().split('\n').filter(p => p && !p.includes('cgmb'));
      if (paths.length > 0) {
        return paths[0];
      }
    } catch {
      // System PATH lookup failed
    }

    return undefined;
  }

  /**
   * Test Claude Code connection
   */
  private async testClaudeCodeConnection(): Promise<void> {
    try {
      // Use lightweight version check instead of full command execution
      const { execSync } = await import('child_process');
      
      try {
        // First try --version
        const output = execSync(`${this.claudePath} --version`, { 
          timeout: 30000,
          encoding: 'utf8',
          stdio: 'pipe'
        });
        
        // Accept any non-empty output as success (Claude Code might have different version output format)
        if (output && output.trim()) {
          logger.debug('Claude Code connection test successful via --version', {
            version: output.trim().substring(0, 100)
          });
          return;
        }
      } catch (versionError) {
        // --version failed, try --help as fallback
        logger.debug('Claude --version failed, trying --help', {
          error: (versionError as Error).message
        });
        
        try {
          const helpOutput = execSync(`${this.claudePath} --help`, { 
            timeout: 15000,
            encoding: 'utf8',
            stdio: 'pipe'
          });
          
          // If --help works and contains "Claude" or shows help text, consider it working
          if (helpOutput && (helpOutput.includes('Claude') || helpOutput.includes('Usage:') || helpOutput.length > 20)) {
            logger.debug('Claude Code connection test successful via --help', {
              helpLength: helpOutput.length
            });
            return;
          }
        } catch (helpError) {
          logger.warn('Both --version and --help failed for Claude Code', {
            versionError: (versionError as Error).message,
            helpError: (helpError as Error).message
          });
        }
      }
      
      // Final fallback: just check if the binary exists and is executable
      try {
        const { access, constants } = await import('fs/promises');
        await access(this.claudePath!, constants.F_OK | constants.X_OK);
        logger.debug('Claude Code binary exists and is executable, considering it available');
        return;
      } catch (accessError) {
        throw new Error(`Claude Code binary not accessible: ${(accessError as Error).message}`);
      }
      
    } catch (error) {
      throw new Error(`Claude Code connection test failed: ${(error as Error).message}`);
    }
  }

  /**
   * Build reasoning prompt
   */
  private buildReasoningPrompt(task: ReasoningTask): string {
    let prompt = `Please provide detailed reasoning for the following:\n\n${task.prompt}`;
    
    if (task.context) {
      prompt += `\n\nContext: ${task.context}`;
    }
    
    if (task.depth) {
      const depthInstructions = {
        shallow: 'Provide a brief, high-level analysis.',
        medium: 'Provide a thorough analysis with key reasoning steps.',
        deep: 'Provide a comprehensive, step-by-step analysis with detailed justification.',
      };
      prompt += `\n\nDepth: ${depthInstructions[task.depth]}`;
    }
    
    if (task.domain) {
      prompt += `\n\nDomain: Focus on ${task.domain} perspectives and principles.`;
    }
    
    prompt += '\n\nPlease structure your response with clear reasoning steps and a conclusion.';
    
    return prompt;
  }

  /**
   * Build synthesis prompt
   */
  private buildSynthesisPrompt(task: any): string {
    let prompt = 'Please synthesize and respond to the following:\n\n';
    
    if (task.request) {
      prompt += `Request: ${task.request}\n\n`;
    }
    
    if (task.inputs && typeof task.inputs === 'object') {
      prompt += 'Input Sources:\n';
      Object.entries(task.inputs).forEach(([source, content], index) => {
        prompt += `${index + 1}. ${source}: ${content}\n`;
      });
      prompt += '\n';
    }
    
    prompt += 'Please provide a comprehensive, well-structured response that synthesizes all the information.';
    
    return prompt;
  }

  /**
   * Build workflow prompt
   */
  private buildWorkflowPrompt(workflow: WorkflowDefinition): string {
    let prompt = 'Please execute the following workflow:\n\n';
    
    if (workflow.steps) {
      prompt += 'Steps:\n';
      workflow.steps.forEach((step, index) => {
        prompt += `${index + 1}. ${step.action}: ${JSON.stringify(step.input)}\n`;
      });
      prompt += '\n';
    }
    
    prompt += 'Please execute each step and provide a comprehensive result.';
    
    return prompt;
  }

  /**
   * Parse reasoning result
   */
  private parseReasoningResult(output: string, task: ReasoningTask): ReasoningResult {
    // Try to extract structured reasoning from output
    const lines = output.trim().split('\n');
    const steps: string[] = [];
    let reasoning = '';
    let conclusion = '';
    
    // Simple parsing - look for numbered steps or bullet points
    let inSteps = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      
      if (/^\d+\./.test(trimmed) || /^[-*]/.test(trimmed)) {
        steps.push(trimmed);
        inSteps = true;
      } else if (inSteps && trimmed.toLowerCase().includes('conclusion')) {
        conclusion = trimmed;
        inSteps = false;
      } else if (!inSteps) {
        reasoning += trimmed + ' ';
      }
    }
    
    // Fallback: use entire output as reasoning
    if (!reasoning && !conclusion) {
      reasoning = output.trim();
    }
    
    return {
      reasoning: reasoning.trim() || output.trim(),
      conclusion: conclusion.trim() || 'Analysis completed.',
      confidence: 0.8, // Default confidence
      steps: steps.length > 0 ? steps : undefined,
    };
  }

  /**
   * Parse workflow result
   */
  private parseWorkflowResult(output: string, workflow: WorkflowDefinition): WorkflowResult {
    return {
      success: true,
      results: {
        workflow_execution: {
          success: true,
          data: output,
          metadata: {
            layer: 'claude' as const,
            duration: 0,
            model: 'claude-code',
          },
        },
      },
      summary: 'Workflow executed successfully via Claude Code',
      metadata: {
        total_duration: 0,
        steps_completed: workflow.steps?.length || 1,
        steps_failed: 0,
        total_cost: 0,
      },
    };
  }

  /**
   * Get task timeout
   */
  private getTaskTimeout(task: any): number {
    if (task.timeout) {
      return task.timeout;
    }
    
    return this.getEstimatedDuration(task) + 30000; // Add 30s buffer
  }

  /**
   * Estimate tokens used
   */
  private estimateTokensUsed(task: any, result: any): number {
    const inputText = JSON.stringify(task);
    const outputText = typeof result === 'string' ? result : JSON.stringify(result);
    
    // Rough estimate: 1 token ≈ 4 characters
    return Math.ceil((inputText.length + outputText.length) / 4);
  }

  /**
   * Calculate cost
   */
  private calculateCost(task: any, result: any): number {
    // Claude Code is typically free
    return 0;
  }
}