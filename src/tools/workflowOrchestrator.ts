import {
  WorkflowDefinition,
  WorkflowStep,
  WorkflowResult,
  WorkflowExecutionPlan,
  LayerResult,
  FileReference,
  ExecutionPlan,
  ResourceEstimate,
} from '../core/types.js';
import { LayerManager } from '../core/LayerManager.js';
import { ClaudeCodeLayer } from '../layers/ClaudeCodeLayer.js';
import { GeminiCLILayer } from '../layers/GeminiCLILayer.js';
import { AIStudioLayer } from '../layers/AIStudioLayer.js';
import { logger } from '../utils/logger.js';
import { safeExecute, retry } from '../utils/errorHandler.js';
import { AuthVerifier } from '../auth/AuthVerifier.js';

/**
 * WorkflowOrchestrator manages complex multi-step workflows across all three layers
 * Provides intelligent task scheduling, dependency management, and error recovery
 */
export class WorkflowOrchestrator {
  private layerManager: LayerManager;
  private claudeLayer: ClaudeCodeLayer;
  private geminiLayer: GeminiCLILayer;
  private aiStudioLayer: AIStudioLayer;
  private authVerifier: AuthVerifier;
  
  private readonly MAX_CONCURRENT_STEPS = 5;
  private readonly MAX_WORKFLOW_DURATION = 30 * 60 * 1000; // 30 minutes
  private readonly MAX_RETRY_ATTEMPTS = 3;

  constructor() {
    this.layerManager = new LayerManager();
    this.claudeLayer = new ClaudeCodeLayer();
    this.geminiLayer = new GeminiCLILayer();
    this.aiStudioLayer = new AIStudioLayer();
    this.authVerifier = new AuthVerifier();
  }

  /**
   * Execute a complete workflow
   */
  async executeWorkflow(workflow: WorkflowDefinition): Promise<WorkflowResult> {
    return safeExecute(
      async () => {
        const startTime = Date.now();
        
        logger.info('Starting workflow execution', {
          workflowId: workflow.id || 'unnamed',
          stepCount: workflow.steps?.length || 0,
          estimatedDuration: workflow.timeout || 'not specified',
        });

        // Validate workflow definition
        this.validateWorkflow(workflow);
        
        // Create execution plan
        const executionPlan = await this.createExecutionPlan(workflow);
        
        // Initialize required layers
        await this.initializeRequiredLayers(executionPlan);
        
        // Execute workflow steps
        const stepResults = await this.executeWorkflowSteps(workflow, executionPlan);
        
        // Generate final result
        const finalResult = await this.generateFinalResult(workflow, stepResults);
        
        const totalDuration = Date.now() - startTime;
        
        return {
          success: true,
          results: stepResults,
          summary: finalResult.summary,
          metadata: {
            total_duration: totalDuration,
            steps_completed: stepResults.length,
            steps_failed: this.countFailedSteps(stepResults),
            total_cost: this.calculateTotalCost(stepResults),
            layers_used: this.extractLayersUsed(stepResults),
            execution_plan: executionPlan,
          },
        };
      },
      {
        operationName: 'execute-workflow',
        layer: 'orchestrator',
        timeout: workflow.timeout || this.MAX_WORKFLOW_DURATION,
      }
    );
  }

  /**
   * Create a custom workflow from template
   */
  async createWorkflow(
    template: 'document_processing' | 'content_analysis' | 'multimodal_pipeline' | 'research_workflow',
    files: FileReference[],
    instructions: string,
    options?: any
  ): Promise<WorkflowDefinition> {
    const workflowId = `${template}_${Date.now()}`;
    
    switch (template) {
      case 'document_processing':
        return this.createDocumentProcessingWorkflow(workflowId, files, instructions, options);
      
      case 'content_analysis':
        return this.createContentAnalysisWorkflow(workflowId, files, instructions, options);
      
      case 'multimodal_pipeline':
        return this.createMultimodalPipelineWorkflow(workflowId, files, instructions, options);
      
      case 'research_workflow':
        return this.createResearchWorkflow(workflowId, files, instructions, options);
      
      default:
        throw new Error(`Unknown workflow template: ${template}`);
    }
  }

  /**
   * Execute a simple pipeline workflow
   */
  async executePipeline(
    steps: Array<{
      layer: 'claude' | 'gemini' | 'aistudio';
      action: string;
      input: any;
      dependsOn?: string[];
    }>,
    options?: { 
      parallel?: boolean; 
      continueOnError?: boolean;
      timeout?: number;
    }
  ): Promise<WorkflowResult> {
    const workflow: WorkflowDefinition = {
      id: `pipeline_${Date.now()}`,
      steps: steps.map((step, index) => ({
        id: `step_${index}`,
        action: step.action,
        layer: step.layer,
        input: step.input,
        dependsOn: step.dependsOn || [],
        timeout: 120000, // 2 minutes per step
      })),
      parallel: options?.parallel || false,
      continueOnError: options?.continueOnError || false,
      timeout: options?.timeout || this.MAX_WORKFLOW_DURATION,
    };
    
    return this.executeWorkflow(workflow);
  }

  /**
   * Get workflow status and progress
   */
  async getWorkflowStatus(workflowId: string): Promise<{
    status: 'running' | 'completed' | 'failed' | 'not_found';
    progress: number;
    currentStep?: string;
    completedSteps: string[];
    failedSteps: string[];
  }> {
    // This would typically interface with a workflow state store
    // For now, return a basic implementation
    return {
      status: 'not_found',
      progress: 0,
      completedSteps: [],
      failedSteps: [],
    };
  }

  /**
   * Validate workflow definition
   */
  private validateWorkflow(workflow: WorkflowDefinition): void {
    if (!workflow.steps || workflow.steps.length === 0) {
      throw new Error('Workflow must have at least one step');
    }

    if (workflow.steps.length > 50) {
      throw new Error('Workflow cannot have more than 50 steps');
    }

    // Validate step dependencies
    const stepIds = new Set(workflow.steps.map(step => step.id));
    
    for (const step of workflow.steps) {
      if (!step.id) {
        throw new Error('Each workflow step must have an ID');
      }
      
      if (!step.action) {
        throw new Error(`Step ${step.id} must have an action`);
      }
      
      if (!step.layer) {
        throw new Error(`Step ${step.id} must specify a layer`);
      }
      
      // Check dependencies exist
      if (step.dependsOn) {
        for (const depId of step.dependsOn) {
          if (!stepIds.has(depId)) {
            throw new Error(`Step ${step.id} depends on non-existent step ${depId}`);
          }
        }
      }
    }

    // Check for circular dependencies
    this.detectCircularDependencies(workflow.steps);
  }

  /**
   * Detect circular dependencies in workflow steps
   */
  private detectCircularDependencies(steps: WorkflowStep[]): void {
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    
    const stepMap = new Map(steps.map(step => [step.id, step]));
    
    const hasCycle = (stepId: string): boolean => {
      if (recursionStack.has(stepId)) {
        return true;
      }
      
      if (visited.has(stepId)) {
        return false;
      }
      
      visited.add(stepId);
      recursionStack.add(stepId);
      
      const step = stepMap.get(stepId);
      if (step?.dependsOn) {
        for (const depId of step.dependsOn) {
          if (hasCycle(depId)) {
            return true;
          }
        }
      }
      
      recursionStack.delete(stepId);
      return false;
    };
    
    for (const step of steps) {
      if (hasCycle(step.id)) {
        throw new Error('Circular dependency detected in workflow');
      }
    }
  }

  /**
   * Create execution plan for workflow
   */
  private async createExecutionPlan(workflow: WorkflowDefinition): Promise<WorkflowExecutionPlan> {
    return retry(
      async () => {
        // Topologically sort steps based on dependencies
        const sortedSteps = this.topologicalSort(workflow.steps);
        
        // Group steps by execution phase (for parallel execution)
        const executionPhases = this.groupStepsByPhase(sortedSteps, workflow.parallel || false);
        
        // Estimate resources for each step
        const resourceEstimates = await this.estimateResources(sortedSteps);
        
        // Calculate optimal execution strategy
        const strategy = this.determineExecutionStrategy(workflow, executionPhases, resourceEstimates);
        
        return {
          phases: executionPhases,
          totalEstimatedDuration: resourceEstimates.reduce((sum, est) => sum + est.duration, 0),
          totalEstimatedCost: resourceEstimates.reduce((sum, est) => sum + est.cost, 0),
          requiredLayers: this.extractRequiredLayers(sortedSteps),
          resourceRequirements: resourceEstimates,
          executionStrategy: strategy,
        };
      },
      {
        maxAttempts: 2,
        delay: 1000,
        operationName: 'create-execution-plan',
      }
    );
  }

  /**
   * Topologically sort workflow steps
   */
  private topologicalSort(steps: WorkflowStep[]): WorkflowStep[] {
    const result: WorkflowStep[] = [];
    const visited = new Set<string>();
    const tempVisited = new Set<string>();
    const stepMap = new Map(steps.map(step => [step.id, step]));
    
    const visit = (stepId: string): void => {
      if (tempVisited.has(stepId)) {
        throw new Error('Circular dependency detected');
      }
      
      if (visited.has(stepId)) {
        return;
      }
      
      tempVisited.add(stepId);
      
      const step = stepMap.get(stepId);
      if (step?.dependsOn) {
        for (const depId of step.dependsOn) {
          visit(depId);
        }
      }
      
      tempVisited.delete(stepId);
      visited.add(stepId);
      
      if (step) {
        result.push(step);
      }
    };
    
    for (const step of steps) {
      if (!visited.has(step.id)) {
        visit(step.id);
      }
    }
    
    return result;
  }

  /**
   * Group steps by execution phase for parallel processing
   */
  private groupStepsByPhase(steps: WorkflowStep[], allowParallel: boolean): WorkflowStep[][] {
    if (!allowParallel) {
      return steps.map(step => [step]);
    }
    
    const phases: WorkflowStep[][] = [];
    const processedSteps = new Set<string>();
    
    while (processedSteps.size < steps.length) {
      const currentPhase: WorkflowStep[] = [];
      
      for (const step of steps) {
        if (processedSteps.has(step.id)) {
          continue;
        }
        
        // Check if all dependencies are satisfied
        const canExecute = !step.dependsOn || 
          step.dependsOn.every(depId => processedSteps.has(depId));
        
        if (canExecute && currentPhase.length < this.MAX_CONCURRENT_STEPS) {
          currentPhase.push(step);
          processedSteps.add(step.id);
        }
      }
      
      if (currentPhase.length === 0) {
        throw new Error('Unable to resolve workflow dependencies');
      }
      
      phases.push(currentPhase);
    }
    
    return phases;
  }

  /**
   * Estimate resources for workflow steps
   */
  private async estimateResources(steps: WorkflowStep[]): Promise<ResourceEstimate[]> {
    const estimates: ResourceEstimate[] = [];
    
    for (const step of steps) {
      let duration = 30000; // Default 30 seconds
      let cost = 0;
      let memory = 256; // MB
      let cpu = 0.5; // CPU units
      
      // Estimate based on layer and action
      switch (step.layer) {
        case 'claude':
          duration = 60000; // 1 minute
          cost = 0.01;
          memory = 512;
          cpu = 1.0;
          break;
        case 'gemini':
          duration = 30000; // 30 seconds
          cost = 0;
          memory = 256;
          cpu = 0.5;
          break;
        case 'aistudio':
          duration = 120000; // 2 minutes
          cost = 0.005;
          memory = 1024;
          cpu = 0.8;
          break;
      }
      
      // Adjust based on action complexity
      if (step.action.includes('complex') || step.action.includes('analysis')) {
        duration *= 2;
        cost *= 1.5;
        memory *= 1.5;
      }
      
      estimates.push({
        stepId: step.id,
        duration,
        cost,
        memory,
        cpu,
        bandwidth: 10, // MB
      });
    }
    
    return estimates;
  }

  /**
   * Determine execution strategy
   */
  private determineExecutionStrategy(
    workflow: WorkflowDefinition,
    phases: WorkflowStep[][],
    estimates: ResourceEstimate[]
  ): 'sequential' | 'parallel' | 'hybrid' {
    const totalSteps = workflow.steps?.length || 0;
    const totalDuration = estimates.reduce((sum, est) => sum + est.duration, 0);
    const maxPhaseSize = Math.max(...phases.map(phase => phase.length));
    
    if (totalSteps <= 3 || totalDuration < 60000) {
      return 'sequential';
    }
    
    if (maxPhaseSize > 1 && workflow.parallel) {
      return 'parallel';
    }
    
    return 'hybrid';
  }

  /**
   * Extract required layers from steps
   */
  private extractRequiredLayers(steps: WorkflowStep[]): string[] {
    const layers = new Set<string>();
    steps.forEach(step => layers.add(step.layer));
    return Array.from(layers);
  }

  /**
   * Initialize required layers
   */
  private async initializeRequiredLayers(plan: WorkflowExecutionPlan): Promise<void> {
    const initPromises: Promise<void>[] = [];
    
    for (const layer of plan.requiredLayers) {
      switch (layer) {
        case 'claude':
          initPromises.push(this.claudeLayer.initialize());
          break;
        case 'gemini':
          initPromises.push(this.geminiLayer.initialize());
          break;
        case 'aistudio':
          initPromises.push(this.aiStudioLayer.initialize());
          break;
      }
    }
    
    await Promise.all(initPromises);
    logger.debug('Initialized layers for workflow', { layers: plan.requiredLayers });
  }

  /**
   * Execute workflow steps according to plan
   */
  private async executeWorkflowSteps(
    workflow: WorkflowDefinition,
    plan: WorkflowExecutionPlan
  ): Promise<Record<string, LayerResult>> {
    const results: Record<string, LayerResult> = {};
    const context: Record<string, any> = {};
    
    for (const phase of plan.phases) {
      logger.info(`Executing workflow phase with ${phase.length} step(s)`);
      
      // Execute steps in current phase
      const phasePromises = phase.map(step => 
        this.executeWorkflowStep(step, context, results)
      );
      
      const phaseResults = await Promise.allSettled(phasePromises);
      
      // Process phase results
      for (let i = 0; i < phase.length; i++) {
        const step = phase[i];
        const result = phaseResults[i];
        
        if (result.status === 'fulfilled') {
          results[step.id] = result.value;
          context[step.id] = result.value.data;
          
          logger.debug('Step completed successfully', {
            stepId: step.id,
            duration: result.value.metadata?.duration,
          });
        } else {
          const error = result.reason;
          
          logger.error('Step failed', {
            stepId: step.id,
            error: error.message,
          });
          
          results[step.id] = {
            success: false,
            error: error.message,
            data: null,
            metadata: {
              layer: step.layer,
              duration: 0,
              failed: true,
            },
          };
          
          // Check if workflow should continue on error
          if (!workflow.continueOnError) {
            throw new Error(`Workflow failed at step ${step.id}: ${error.message}`);
          }
        }
      }
    }
    
    return results;
  }

  /**
   * Execute a single workflow step
   */
  private async executeWorkflowStep(
    step: WorkflowStep,
    context: Record<string, any>,
    previousResults: Record<string, LayerResult>
  ): Promise<LayerResult> {
    return retry(
      async () => {
        logger.debug('Executing workflow step', {
          stepId: step.id,
          layer: step.layer,
          action: step.action,
        });
        
        // Prepare step input with context
        const stepInput = this.prepareStepInput(step, context, previousResults);
        
        // Execute step based on layer
        let result: LayerResult;
        
        switch (step.layer) {
          case 'claude':
            result = await this.claudeLayer.execute({
              action: step.action,
              ...stepInput,
            });
            break;
            
          case 'gemini':
            result = await this.geminiLayer.execute({
              action: step.action,
              ...stepInput,
            });
            break;
            
          case 'aistudio':
            result = await this.aiStudioLayer.execute({
              action: step.action,
              ...stepInput,
            });
            break;
            
          default:
            throw new Error(`Unknown layer: ${step.layer}`);
        }
        
        return result;
      },
      {
        maxAttempts: this.MAX_RETRY_ATTEMPTS,
        delay: 2000,
        operationName: `execute-step-${step.id}`,
      }
    );
  }

  /**
   * Prepare input for workflow step
   */
  private prepareStepInput(
    step: WorkflowStep,
    context: Record<string, any>,
    previousResults: Record<string, LayerResult>
  ): any {
    let input = { ...step.input };
    
    // Replace placeholders with context values
    if (typeof input === 'object' && input !== null) {
      input = this.replaceContextPlaceholders(input, context);
    }
    
    // Add dependency results if specified
    if (step.dependsOn && step.dependsOn.length > 0) {
      const dependencyResults = step.dependsOn.map(depId => ({
        stepId: depId,
        result: previousResults[depId]?.data,
      }));
      
      input.dependencies = dependencyResults;
    }
    
    return input;
  }

  /**
   * Replace context placeholders in input
   */
  private replaceContextPlaceholders(obj: any, context: Record<string, any>): any {
    if (typeof obj === 'string') {
      // Replace {{stepId}} placeholders
      return obj.replace(/\{\{(\w+)\}\}/g, (match, stepId) => {
        return context[stepId] || match;
      });
    }
    
    if (Array.isArray(obj)) {
      return obj.map(item => this.replaceContextPlaceholders(item, context));
    }
    
    if (typeof obj === 'object' && obj !== null) {
      const result: any = {};
      for (const [key, value] of Object.entries(obj)) {
        result[key] = this.replaceContextPlaceholders(value, context);
      }
      return result;
    }
    
    return obj;
  }

  /**
   * Generate final workflow result
   */
  private async generateFinalResult(
    workflow: WorkflowDefinition,
    stepResults: Record<string, LayerResult>
  ): Promise<{ summary: string }> {
    try {
      const summaryPrompt = `Generate a summary of the workflow execution results. Workflow had ${Object.keys(stepResults).length} steps.`;
      
      const summaryResult = await this.claudeLayer.synthesizeResponse({
        request: summaryPrompt,
        inputs: {
          workflowId: workflow.id,
          stepResults: Object.entries(stepResults).map(([stepId, result]) => ({
            stepId,
            success: result.success,
            data: result.data,
          })),
        },
      });
      
      return {
        summary: summaryResult,
      };
    } catch (error) {
      logger.warn('Failed to generate workflow summary', { error: (error as Error).message });
      return {
        summary: `Workflow ${workflow.id} completed with ${Object.keys(stepResults).length} steps.`,
      };
    }
  }

  /**
   * Count failed steps
   */
  private countFailedSteps(stepResults: Record<string, LayerResult>): number {
    return Object.values(stepResults).filter(result => !result.success).length;
  }

  /**
   * Calculate total cost
   */
  private calculateTotalCost(stepResults: Record<string, LayerResult>): number {
    return Object.values(stepResults).reduce((total, result) => {
      return total + (result.metadata?.cost || 0);
    }, 0);
  }

  /**
   * Extract layers used
   */
  private extractLayersUsed(stepResults: Record<string, LayerResult>): string[] {
    const layers = new Set<string>();
    Object.values(stepResults).forEach(result => {
      if (result.metadata?.layer) {
        layers.add(result.metadata.layer);
      }
    });
    return Array.from(layers);
  }

  /**
   * Create document processing workflow
   */
  private createDocumentProcessingWorkflow(
    id: string,
    files: FileReference[],
    instructions: string,
    options?: any
  ): WorkflowDefinition {
    return {
      id,
      steps: [
        {
          id: 'extract_content',
          layer: 'aistudio',
          action: 'document_analysis',
          input: { files, instructions: 'Extract all content and structure from documents' },
          dependsOn: [],
        },
        {
          id: 'analyze_content',
          layer: 'claude',
          action: 'complex_reasoning',
          input: { 
            prompt: `${instructions}. Use the extracted content: {{extract_content}}`,
            depth: options?.depth || 'medium',
          },
          dependsOn: ['extract_content'],
        },
        {
          id: 'generate_insights',
          layer: 'claude',
          action: 'synthesize_response',
          input: {
            request: 'Generate insights and conclusions from the analysis',
            inputs: { analysis: '{{analyze_content}}' },
          },
          dependsOn: ['analyze_content'],
        },
      ],
      parallel: false,
      continueOnError: false,
      timeout: 600000, // 10 minutes
    };
  }

  /**
   * Create content analysis workflow
   */
  private createContentAnalysisWorkflow(
    id: string,
    files: FileReference[],
    instructions: string,
    options?: any
  ): WorkflowDefinition {
    return {
      id,
      steps: [
        {
          id: 'process_multimodal',
          layer: 'aistudio',
          action: 'multimodal_processing',
          input: { files, instructions: 'Process and analyze all content types' },
          dependsOn: [],
        },
        {
          id: 'contextual_grounding',
          layer: 'gemini',
          action: 'grounded_search',
          input: { 
            prompt: `${instructions}. Context: {{process_multimodal}}`,
            useSearch: true,
          },
          dependsOn: ['process_multimodal'],
        },
        {
          id: 'comprehensive_analysis',
          layer: 'claude',
          action: 'complex_reasoning',
          input: {
            prompt: `Perform comprehensive analysis: ${instructions}`,
            context: 'Multimodal: {{process_multimodal}}, Grounded: {{contextual_grounding}}',
            depth: 'deep',
          },
          dependsOn: ['process_multimodal', 'contextual_grounding'],
        },
      ],
      parallel: true,
      continueOnError: false,
      timeout: 900000, // 15 minutes
    };
  }

  /**
   * Create multimodal pipeline workflow
   */
  private createMultimodalPipelineWorkflow(
    id: string,
    files: FileReference[],
    instructions: string,
    options?: any
  ): WorkflowDefinition {
    return {
      id,
      steps: [
        {
          id: 'extract_multimodal',
          layer: 'aistudio',
          action: 'multimodal_processing',
          input: { files, instructions: 'Extract and process all multimodal content' },
          dependsOn: [],
        },
        {
          id: 'enhance_with_search',
          layer: 'gemini',
          action: 'grounded_search',
          input: {
            prompt: `Enhance understanding with current information: {{extract_multimodal}}`,
            useSearch: true,
          },
          dependsOn: ['extract_multimodal'],
        },
        {
          id: 'synthesize_final',
          layer: 'claude',
          action: 'synthesize_response',
          input: {
            request: instructions,
            inputs: {
              multimodal: '{{extract_multimodal}}',
              grounded: '{{enhance_with_search}}',
            },
          },
          dependsOn: ['extract_multimodal', 'enhance_with_search'],
        },
      ],
      parallel: false,
      continueOnError: true,
      timeout: 1200000, // 20 minutes
    };
  }

  /**
   * Create research workflow
   */
  private createResearchWorkflow(
    id: string,
    files: FileReference[],
    instructions: string,
    options?: any
  ): WorkflowDefinition {
    return {
      id,
      steps: [
        {
          id: 'initial_research',
          layer: 'gemini',
          action: 'grounded_search',
          input: {
            prompt: `Research background information: ${instructions}`,
            useSearch: true,
          },
          dependsOn: [],
        },
        {
          id: 'analyze_documents',
          layer: 'aistudio',
          action: 'document_analysis',
          input: { files, instructions: 'Analyze documents in context of research' },
          dependsOn: [],
        },
        {
          id: 'cross_reference',
          layer: 'claude',
          action: 'complex_reasoning',
          input: {
            prompt: `Cross-reference research with document analysis: ${instructions}`,
            context: 'Research: {{initial_research}}, Documents: {{analyze_documents}}',
            depth: 'deep',
          },
          dependsOn: ['initial_research', 'analyze_documents'],
        },
        {
          id: 'final_synthesis',
          layer: 'claude',
          action: 'synthesize_response',
          input: {
            request: 'Create comprehensive research synthesis',
            inputs: {
              research: '{{initial_research}}',
              documents: '{{analyze_documents}}',
              analysis: '{{cross_reference}}',
            },
          },
          dependsOn: ['cross_reference'],
        },
      ],
      parallel: true,
      continueOnError: false,
      timeout: 1800000, // 30 minutes
    };
  }

  /**
   * Get workflow templates
   */
  getAvailableTemplates(): string[] {
    return [
      'document_processing',
      'content_analysis',
      'multimodal_pipeline',
      'research_workflow',
    ];
  }

  /**
   * Get orchestrator limits
   */
  getOrchestratorLimits(): {
    maxConcurrentSteps: number;
    maxWorkflowDuration: number;
    maxRetryAttempts: number;
  } {
    return {
      maxConcurrentSteps: this.MAX_CONCURRENT_STEPS,
      maxWorkflowDuration: this.MAX_WORKFLOW_DURATION,
      maxRetryAttempts: this.MAX_RETRY_ATTEMPTS,
    };
  }
}