import { ClaudeCodeLayer } from '../layers/ClaudeCodeLayer.js';
import { GeminiCLILayer } from '../layers/GeminiCLILayer.js';
import { AIStudioLayer } from '../layers/AIStudioLayer.js';
import { logger } from '../utils/logger.js';
import { ErrorHandler, safeExecute } from '../utils/errorHandler.js';
import {
  Config,
  ExecutionPlan,
  WorkflowResult,
  WorkflowStep,
  LayerResult,
  ProcessingOptions,
  FileReference,
  WorkflowType,
  WorkloadAnalysis,
  CGMBError,
  LayerType,
} from './types.js';

// ===================================
// Layer Manager - Orchestrates all three layers
// ===================================

export interface ExecutionOptions {
  executionMode: 'sequential' | 'parallel' | 'adaptive';
  timeout?: number;
  maxRetries?: number;
}

export class LayerManager {
  private claudeLayer: ClaudeCodeLayer;
  private geminiLayer: GeminiCLILayer;
  private aiStudioLayer: AIStudioLayer;
  private config: Config;

  constructor(config: Config) {
    this.config = config;
    this.claudeLayer = new ClaudeCodeLayer();
    this.geminiLayer = new GeminiCLILayer();
    this.aiStudioLayer = new AIStudioLayer();
  }

  /**
   * Initialize all layers
   */
  public async initializeLayers(): Promise<void> {
    logger.info('Initializing all layers...');

    const initializationPromises = [
      safeExecute(
        () => this.claudeLayer.initialize(),
        { operationName: 'claude-layer-init', layer: 'claude' }
      ),
      safeExecute(
        () => this.geminiLayer.initialize(),
        { operationName: 'gemini-layer-init', layer: 'gemini' }
      ),
      safeExecute(
        () => this.aiStudioLayer.initialize(),
        { operationName: 'aistudio-layer-init', layer: 'aistudio' }
      ),
    ];

    const results = await Promise.allSettled(initializationPromises);
    
    // Log initialization results
    results.forEach((result, index) => {
      const layerNames = ['Claude Code', 'Gemini CLI', 'AI Studio'];
      if (result.status === 'fulfilled') {
        logger.info(`${layerNames[index]} layer initialized successfully`);
      } else {
        logger.error(`${layerNames[index]} layer initialization failed`, result.reason);
      }
    });

    // Check if we have at least one working layer
    const successfulLayers = results.filter(r => r.status === 'fulfilled').length;
    if (successfulLayers === 0) {
      throw new CGMBError(
        'All layers failed to initialize',
        'INITIALIZATION_FAILED'
      );
    }

    logger.info(`Layer initialization completed: ${successfulLayers}/3 layers available`);
  }

  /**
   * Process multimodal content using the optimal workflow
   */
  public async processMultimodal(
    prompt: string,
    files: FileReference[],
    workflow: WorkflowType,
    options?: ProcessingOptions
  ): Promise<WorkflowResult> {
    logger.info('Starting multimodal processing', {
      workflow,
      fileCount: files.length,
      options,
    });

    // Create execution plan based on workflow type
    const executionPlan = await this.createWorkflowPlan(workflow, {
      prompt,
      files,
      options: options || {},
    });

    // Execute the workflow
    return this.executeWorkflow(executionPlan, { prompt, files }, {
      executionMode: options?.execution_mode || 'adaptive',
      timeout: options?.timeout || 300000,
    });
  }

  /**
   * Analyze documents using multi-layer approach
   */
  public async analyzeDocuments(
    documents: string[],
    analysisType: string,
    outputRequirements?: string,
    options?: ProcessingOptions
  ): Promise<WorkflowResult> {
    logger.info('Starting document analysis', {
      analysisType,
      documentCount: documents.length,
      outputRequirements,
    });

    const executionPlan: ExecutionPlan = {
      steps: [
        {
          id: 'preprocess',
          layer: 'claude',
          action: 'analyze_requirements',
          input: {
            documents,
            analysisType,
            outputRequirements,
          },
        },
        {
          id: 'document_processing',
          layer: 'aistudio',
          action: 'process_documents',
          input: {
            documents,
            analysisType,
          },
          dependsOn: ['preprocess'],
        },
        {
          id: 'synthesis',
          layer: 'claude',
          action: 'synthesize_analysis',
          input: {
            analysisResults: '@document_processing.output',
            requirements: outputRequirements,
          },
          dependsOn: ['document_processing'],
        },
      ],
      fallbackStrategies: {
        aistudio_unavailable: {
          replace: 'document_processing',
          with: {
            id: 'fallback_processing',
            layer: 'gemini',
            action: 'analyze_documents',
            input: {
              documents,
              analysisType,
            },
          },
        },
      },
    };

    return this.executeWorkflow(executionPlan, { documents, analysisType }, {
      executionMode: options?.execution_mode || 'sequential',
      timeout: options?.timeout || 300000,
    });
  }

  /**
   * Execute a complete workflow across multiple layers
   */
  public async executeWorkflow(
    workflow: ExecutionPlan,
    inputData: any,
    options: ExecutionOptions
  ): Promise<WorkflowResult> {
    const startTime = Date.now();
    logger.info('Starting workflow execution', {
      stepsCount: workflow.steps.length,
      executionMode: options.executionMode,
    });

    try {
      let results: Record<string, LayerResult>;

      switch (options.executionMode) {
        case 'sequential':
          results = await this.executeSequential(workflow, inputData, options);
          break;
        case 'parallel':
          results = await this.executeParallel(workflow, inputData, options);
          break;
        case 'adaptive':
          results = await this.executeAdaptive(workflow, inputData, options);
          break;
        default:
          throw new CGMBError(
            `Unknown execution mode: ${options.executionMode}`,
            'INVALID_EXECUTION_MODE'
          );
      }

      const totalDuration = Date.now() - startTime;
      const successful = Object.values(results).filter(r => r.success).length;
      const failed = Object.values(results).length - successful;

      logger.info('Workflow execution completed', {
        totalDuration,
        stepsCompleted: successful,
        stepsFailed: failed,
      });

      return {
        success: failed === 0,
        results,
        summary: this.generateWorkflowSummary(results),
        metadata: {
          total_duration: totalDuration,
          steps_completed: successful,
          steps_failed: failed,
          total_cost: this.calculateTotalCost(results),
        },
      };
    } catch (error) {
      const totalDuration = Date.now() - startTime;
      logger.error('Workflow execution failed', { error, totalDuration });
      
      throw new CGMBError(
        'Workflow execution failed',
        'WORKFLOW_EXECUTION_FAILED',
        undefined,
        { originalError: error, duration: totalDuration }
      );
    }
  }

  /**
   * Execute workflow steps sequentially
   */
  private async executeSequential(
    workflow: ExecutionPlan,
    inputData: any,
    options: ExecutionOptions
  ): Promise<Record<string, LayerResult>> {
    const results: Record<string, LayerResult> = {};
    const stepOutputs: Record<string, any> = {};

    // Sort steps by dependencies
    const sortedSteps = this.topologicalSort(workflow.steps);

    for (const step of sortedSteps) {
      try {
        // Prepare step input by resolving references
        const stepInput = this.resolveStepInput(step.input, stepOutputs, inputData);
        
        // Execute step
        const result = await this.executeStep(step, stepInput, options);
        results[step.id] = result;
        
        if (result.success && result.data) {
          stepOutputs[step.id] = { output: result.data };
        }

        logger.debug(`Step ${step.id} completed`, {
          success: result.success,
          duration: result.metadata.duration,
        });
      } catch (error) {
        logger.error(`Step ${step.id} failed`, error as Error);
        
        // Try fallback strategy if available
        const fallbackResult = await this.tryFallbackStrategy(
          step,
          workflow,
          error as Error,
          options
        );
        
        if (fallbackResult) {
          results[step.id] = fallbackResult;
          if (fallbackResult.success && fallbackResult.data) {
            stepOutputs[step.id] = { output: fallbackResult.data };
          }
        } else {
          results[step.id] = {
            success: false,
            error: (error as Error).message,
            metadata: {
              layer: step.layer,
              duration: 0,
            },
          };
        }
      }
    }

    return results;
  }

  /**
   * Execute independent workflow steps in parallel
   */
  private async executeParallel(
    workflow: ExecutionPlan,
    inputData: any,
    options: ExecutionOptions
  ): Promise<Record<string, LayerResult>> {
    const results: Record<string, LayerResult> = {};
    
    // Group steps by dependency level
    const dependencyLevels = this.groupStepsByDependencies(workflow.steps);
    
    for (const level of dependencyLevels) {
      const promises = level.map(async (step) => {
        try {
          const stepInput = this.resolveStepInput(step.input, results, inputData);
          const result = await this.executeStep(step, stepInput, options);
          return { stepId: step.id, result };
        } catch (error) {
          logger.error(`Step ${step.id} failed in parallel execution`, error as Error);
          return {
            stepId: step.id,
            result: {
              success: false,
              error: (error as Error).message,
              metadata: {
                layer: step.layer,
                duration: 0,
              },
            },
          };
        }
      });

      const levelResults = await Promise.all(promises);
      levelResults.forEach(({ stepId, result }) => {
        results[stepId] = result;
      });
    }

    return results;
  }

  /**
   * Execute workflow adaptively based on workload analysis
   */
  private async executeAdaptive(
    workflow: ExecutionPlan,
    inputData: any,
    options: ExecutionOptions
  ): Promise<Record<string, LayerResult>> {
    // Analyze the workload to determine the best execution strategy
    const analysis = await this.analyzeWorkload(workflow, inputData);
    
    logger.info('Adaptive execution analysis', analysis);

    if (analysis.requiresComplexReasoning) {
      // Use Claude-heavy sequential approach
      return this.executeSequential(workflow, inputData, options);
    } else if (analysis.estimatedComplexity === 'low') {
      // Use parallel execution for simple tasks
      return this.executeParallel(workflow, inputData, options);
    } else {
      // Use hybrid approach
      return this.executeHybrid(workflow, inputData, options, analysis);
    }
  }

  /**
   * Execute a single workflow step
   */
  private async executeStep(
    step: WorkflowStep,
    input: any,
    options: ExecutionOptions
  ): Promise<LayerResult> {
    const layer = this.getLayer(step.layer);
    
    return safeExecute(
      () => layer.execute({
        action: step.action,
        input,
        step,
      }),
      {
        operationName: `step-${step.id}`,
        layer: step.layer,
        timeout: step.timeout || options.timeout || 120000,
      }
    );
  }

  /**
   * Analyze workload to determine optimal execution strategy
   */
  private async analyzeWorkload(
    workflow: ExecutionPlan,
    inputData: any
  ): Promise<WorkloadAnalysis> {
    // Simple heuristic-based analysis
    // In a more sophisticated implementation, this could use ML models
    
    const hasMultimodalFiles = inputData.files && inputData.files.length > 0;
    const hasComplexPrompt = inputData.prompt && inputData.prompt.length > 1000;
    const multipleSteps = workflow.steps.length > 3;
    
    const requiresComplexReasoning = hasComplexPrompt || multipleSteps;
    const requiresMultimodalProcessing = hasMultimodalFiles;
    const requiresGrounding = inputData.prompt?.includes('search') || 
                             inputData.prompt?.includes('latest') ||
                             inputData.prompt?.includes('current');

    let estimatedComplexity: 'low' | 'medium' | 'high' = 'low';
    
    if (multipleSteps && hasMultimodalFiles) {
      estimatedComplexity = 'high';
    } else if (hasComplexPrompt || hasMultimodalFiles || multipleSteps) {
      estimatedComplexity = 'medium';
    }

    // Determine recommended layer
    let recommendedLayer: LayerType = 'gemini';
    if (requiresComplexReasoning) {
      recommendedLayer = 'claude';
    } else if (requiresMultimodalProcessing) {
      recommendedLayer = 'aistudio';
    }

    return {
      requiresComplexReasoning,
      requiresMultimodalProcessing,
      requiresGrounding,
      estimatedComplexity,
      recommendedLayer,
      confidence: 0.7, // Simple confidence score
    };
  }

  /**
   * Execute workflow using hybrid strategy
   */
  private async executeHybrid(
    workflow: ExecutionPlan,
    inputData: any,
    options: ExecutionOptions,
    analysis: WorkloadAnalysis
  ): Promise<Record<string, LayerResult>> {
    // Group steps by recommended layer and execute accordingly
    const stepGroups = this.groupStepsByRecommendedLayer(workflow.steps, analysis);
    const results: Record<string, LayerResult> = {};

    // Execute high-priority steps first
    for (const [priority, steps] of Object.entries(stepGroups)) {
      if (steps.length === 1) {
        // Single step - execute directly
        const step = steps[0]!;
        const stepInput = this.resolveStepInput(step.input, results, inputData);
        results[step.id] = await this.executeStep(step, stepInput, options);
      } else {
        // Multiple steps - execute in parallel if possible
        const promises = steps.map(async (step) => {
          const stepInput = this.resolveStepInput(step.input, results, inputData);
          return {
            stepId: step.id,
            result: await this.executeStep(step, stepInput, options),
          };
        });

        const stepResults = await Promise.all(promises);
        stepResults.forEach(({ stepId, result }) => {
          results[stepId] = result;
        });
      }
    }

    return results;
  }

  /**
   * Try fallback strategy for a failed step
   */
  private async tryFallbackStrategy(
    failedStep: WorkflowStep,
    workflow: ExecutionPlan,
    error: Error,
    options: ExecutionOptions
  ): Promise<LayerResult | null> {
    if (!workflow.fallbackStrategies) {
      return null;
    }

    // Look for applicable fallback strategies
    const strategyKey = `${failedStep.layer}_unavailable`;
    const strategy = workflow.fallbackStrategies[strategyKey];

    if (!strategy || strategy.replace !== failedStep.id) {
      return null;
    }

    logger.info(`Attempting fallback strategy for step ${failedStep.id}`, {
      strategy: strategyKey,
      fallbackLayer: strategy.with.layer,
    });

    try {
      const fallbackInput = this.resolveStepInput(
        strategy.with.input,
        {},
        failedStep.input
      );
      
      return await this.executeStep(strategy.with, fallbackInput, options);
    } catch (fallbackError) {
      logger.error(`Fallback strategy failed for step ${failedStep.id}`, fallbackError as Error);
      return null;
    }
  }

  /**
   * Create workflow execution plan based on workflow type
   */
  private async createWorkflowPlan(
    workflowType: WorkflowType,
    context: { prompt: string; files: FileReference[]; options?: ProcessingOptions }
  ): Promise<ExecutionPlan> {
    switch (workflowType) {
      case 'analysis':
        return this.createAnalysisWorkflow(context);
      case 'conversion':
        return this.createConversionWorkflow(context);
      case 'extraction':
        return this.createExtractionWorkflow(context);
      case 'generation':
        return this.createGenerationWorkflow(context);
      default:
        throw new CGMBError(`Unknown workflow type: ${workflowType}`, 'INVALID_WORKFLOW_TYPE');
    }
  }

  /**
   * Create analysis workflow plan
   */
  private createAnalysisWorkflow(context: {
    prompt: string;
    files: FileReference[];
    options?: ProcessingOptions;
  }): ExecutionPlan {
    return {
      steps: [
        {
          id: 'preprocess',
          layer: 'claude',
          action: 'analyze_requirements',
          input: {
            prompt: context.prompt,
            files: context.files,
            analysisType: 'multimodal_analysis',
          },
        },
        {
          id: 'multimodal_analysis',
          layer: 'aistudio',
          action: 'process_multimodal',
          input: {
            files: context.files,
            instructions: context.prompt,
            options: context.options,
          },
          dependsOn: ['preprocess'],
        },
        {
          id: 'synthesis',
          layer: 'claude',
          action: 'synthesize_results',
          input: {
            analysis_results: '@multimodal_analysis.output',
            original_prompt: context.prompt,
          },
          dependsOn: ['multimodal_analysis'],
        },
      ],
      fallbackStrategies: {
        aistudio_unavailable: {
          replace: 'multimodal_analysis',
          with: {
            id: 'fallback_analysis',
            layer: 'gemini',
            action: 'analyze_with_grounding',
            input: {
              prompt: context.prompt,
              files: context.files,
            },
          },
        },
      },
    };
  }

  /**
   * Create conversion workflow plan
   */
  private createConversionWorkflow(context: {
    prompt: string;
    files: FileReference[];
    options?: ProcessingOptions;
  }): ExecutionPlan {
    return {
      steps: [
        {
          id: 'format_analysis',
          layer: 'claude',
          action: 'analyze_conversion_requirements',
          input: {
            files: context.files,
            targetFormat: context.prompt,
          },
        },
        {
          id: 'file_conversion',
          layer: 'aistudio',
          action: 'convert_files',
          input: {
            files: context.files,
            conversion_instructions: context.prompt,
            options: context.options,
          },
          dependsOn: ['format_analysis'],
        },
        {
          id: 'quality_check',
          layer: 'gemini',
          action: 'validate_conversion',
          input: {
            original_files: context.files,
            converted_results: '@file_conversion.output',
          },
          dependsOn: ['file_conversion'],
        },
      ],
    };
  }

  /**
   * Create extraction workflow plan
   */
  private createExtractionWorkflow(context: {
    prompt: string;
    files: FileReference[];
    options?: ProcessingOptions;
  }): ExecutionPlan {
    return {
      steps: [
        {
          id: 'extraction_planning',
          layer: 'claude',
          action: 'plan_extraction',
          input: {
            files: context.files,
            extraction_requirements: context.prompt,
          },
        },
        {
          id: 'data_extraction',
          layer: 'aistudio',
          action: 'extract_data',
          input: {
            files: context.files,
            extraction_plan: '@extraction_planning.output',
            options: context.options,
          },
          dependsOn: ['extraction_planning'],
        },
        {
          id: 'structure_data',
          layer: 'claude',
          action: 'structure_extracted_data',
          input: {
            raw_data: '@data_extraction.output',
            requirements: context.prompt,
          },
          dependsOn: ['data_extraction'],
        },
      ],
    };
  }

  /**
   * Create generation workflow plan
   */
  private createGenerationWorkflow(context: {
    prompt: string;
    files: FileReference[];
    options?: ProcessingOptions;
  }): ExecutionPlan {
    return {
      steps: [
        {
          id: 'content_analysis',
          layer: 'aistudio',
          action: 'analyze_source_content',
          input: {
            files: context.files,
            generation_goals: context.prompt,
          },
        },
        {
          id: 'generation_strategy',
          layer: 'claude',
          action: 'develop_generation_strategy',
          input: {
            content_analysis: '@content_analysis.output',
            requirements: context.prompt,
          },
          dependsOn: ['content_analysis'],
        },
        {
          id: 'content_generation',
          layer: 'gemini',
          action: 'generate_content',
          input: {
            strategy: '@generation_strategy.output',
            source_files: context.files,
            prompt: context.prompt,
          },
          dependsOn: ['generation_strategy'],
        },
      ],
    };
  }

  /**
   * Utility methods
   */
  private getLayer(layerType: LayerType) {
    switch (layerType) {
      case 'claude':
        return this.claudeLayer;
      case 'gemini':
        return this.geminiLayer;
      case 'aistudio':
        return this.aiStudioLayer;
      default:
        throw new CGMBError(`Unknown layer type: ${layerType}`, 'INVALID_LAYER_TYPE');
    }
  }

  private topologicalSort(steps: WorkflowStep[]): WorkflowStep[] {
    const sorted: WorkflowStep[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();

    const visit = (step: WorkflowStep) => {
      if (visiting.has(step.id)) {
        throw new CGMBError(`Circular dependency detected at step: ${step.id}`, 'CIRCULAR_DEPENDENCY');
      }
      
      if (visited.has(step.id)) {
        return;
      }

      visiting.add(step.id);

      // Visit dependencies first
      const dependencies = step.dependsOn || [];
      for (const depId of dependencies) {
        const depStep = steps.find(s => s.id === depId);
        if (depStep) {
          visit(depStep);
        }
      }

      visiting.delete(step.id);
      visited.add(step.id);
      sorted.push(step);
    };

    for (const step of steps) {
      visit(step);
    }

    return sorted;
  }

  private groupStepsByDependencies(steps: WorkflowStep[]): WorkflowStep[][] {
    const levels: WorkflowStep[][] = [];
    const processed = new Set<string>();

    while (processed.size < steps.length) {
      const currentLevel = steps.filter(step => {
        if (processed.has(step.id)) return false;
        const dependencies = step.dependsOn || [];
        return dependencies.every(dep => processed.has(dep));
      });

      if (currentLevel.length === 0) {
        throw new CGMBError('Unable to resolve step dependencies', 'DEPENDENCY_RESOLUTION_FAILED');
      }

      levels.push(currentLevel);
      currentLevel.forEach(step => processed.add(step.id));
    }

    return levels;
  }

  private groupStepsByRecommendedLayer(
    steps: WorkflowStep[],
    analysis: WorkloadAnalysis
  ): Record<string, WorkflowStep[]> {
    const groups: Record<string, WorkflowStep[]> = {
      high: [],
      medium: [],
      low: [],
    };

    steps.forEach(step => {
      if (step.layer === analysis.recommendedLayer) {
        groups.high!.push(step);
      } else if (step.layer === 'claude') {
        groups.medium!.push(step);
      } else {
        groups.low!.push(step);
      }
    });

    return groups;
  }

  private resolveStepInput(
    input: Record<string, any>,
    stepOutputs: Record<string, any>,
    baseInput: any
  ): any {
    const resolved: Record<string, any> = { ...baseInput };

    for (const [key, value] of Object.entries(input)) {
      if (typeof value === 'string' && value.startsWith('@')) {
        // Reference to another step's output
        const [stepId, ...pathParts] = value.slice(1).split('.');
        const stepOutput = stepOutputs[stepId!];
        
        if (stepOutput) {
          let resolvedValue = stepOutput;
          for (const part of pathParts) {
            resolvedValue = resolvedValue?.[part];
          }
          resolved[key] = resolvedValue;
        } else {
          logger.warn(`Could not resolve step reference: ${value}`);
          resolved[key] = value;
        }
      } else {
        resolved[key] = value;
      }
    }

    return resolved;
  }

  private generateWorkflowSummary(results: Record<string, LayerResult>): string {
    const total = Object.keys(results).length;
    const successful = Object.values(results).filter(r => r.success).length;
    const failed = total - successful;

    if (failed === 0) {
      return `All ${total} workflow steps completed successfully.`;
    } else if (successful === 0) {
      return `All ${total} workflow steps failed.`;
    } else {
      return `${successful}/${total} workflow steps completed successfully, ${failed} failed.`;
    }
  }

  private calculateTotalCost(results: Record<string, LayerResult>): number {
    return Object.values(results).reduce((total, result) => {
      return total + (result.metadata.cost || 0);
    }, 0);
  }

  // Public getters for layers (for testing and debugging)
  public getClaudeLayer(): ClaudeCodeLayer {
    return this.claudeLayer;
  }

  public getGeminiLayer(): GeminiCLILayer {
    return this.geminiLayer;
  }

  public getAIStudioLayer(): AIStudioLayer {
    return this.aiStudioLayer;
  }
}