import {
  ResourceEstimate,
  WorkflowDefinition,
  WorkflowStep,
} from '../core/types.js';
import { WorkflowOrchestrator } from '../tools/workflowOrchestrator.js';
import { safeExecute } from '../utils/errorHandler.js';
import { logger } from '../utils/logger.js';
import {
  COMPLEXITY_MULTIPLIERS,
  type ComplexityLevel,
  COST_FACTORS,
  DURATION_FACTORS,
  scoreToComplexity,
} from '../utils/workflowUtils.js';

/**
 * Abstract base class for all workflow implementations
 * Provides common functionality for workflow definition, execution, and resource estimation
 */
export abstract class BaseWorkflow implements WorkflowDefinition {
  id: string;
  steps: WorkflowStep[];
  continueOnError: boolean;
  timeout: number;

  protected orchestrator: WorkflowOrchestrator;

  /**
   * Create a new workflow instance
   * @param type - Workflow type identifier (e.g., 'generation', 'analysis')
   * @param timeout - Timeout in milliseconds
   * @param id - Optional custom workflow ID
   */
  constructor(type: string, timeout: number, id?: string) {
    this.id = id ?? `${type}_workflow_${Date.now()}`;
    this.steps = [];
    this.continueOnError = false;
    this.timeout = timeout;
    this.orchestrator = new WorkflowOrchestrator();
  }

  /**
   * Convert complexity score to complexity level
   * Standard thresholds: >=6 = high, >=3 = medium, else = low
   */
  protected assessComplexityByScore(score: number): ComplexityLevel {
    return scoreToComplexity(score);
  }

  /**
   * Execute operation with safe error handling and timeout
   * @param operation - Async operation to execute
   * @param operationName - Name for logging and error context
   * @param timeoutMultiplier - Multiplier for base timeout (default: 1)
   */
  protected async executeWithWrapper<T>(
    operation: () => Promise<T>,
    operationName: string,
    timeoutMultiplier: number = 1
  ): Promise<T> {
    return safeExecute(operation, {
      operationName,
      layer: 'claude' as const,
      timeout: this.timeout * timeoutMultiplier,
    });
  }

  /**
   * Log workflow start with standard format
   */
  protected logWorkflowStart(workflowType: string, metadata: Record<string, unknown>): void {
    logger.info(`Starting ${workflowType} workflow`, {
      workflowId: this.id,
      ...metadata,
    });
  }

  /**
   * Calculate resource estimate with complexity multipliers
   * @param baseValues - Base resource values
   * @param inputMultiplier - Multiplier based on input size/count
   * @param complexity - Complexity level
   */
  protected calculateResourceEstimate(
    baseValues: {
      memory: number;
      cpu: number;
      duration: number;
      cost: number;
    },
    inputMultiplier: number,
    complexity: ComplexityLevel
  ): ResourceEstimate {
    const multiplier = COMPLEXITY_MULTIPLIERS[complexity];

    return {
      estimated_tokens: baseValues.memory * inputMultiplier * multiplier.tokens,
      complexity_score: baseValues.cpu * multiplier.score,
      estimated_duration: baseValues.duration * inputMultiplier * multiplier.duration,
      recommended_execution_mode: 'adaptive' as const,
      required_capabilities: ['claude', 'gemini', 'aistudio'] as const,
      estimated_cost: baseValues.cost * inputMultiplier * multiplier.cost,
    };
  }

  /**
   * Estimate duration based on base time, multiplier, and complexity
   */
  protected estimateDuration(
    baseTime: number,
    multiplier: number,
    complexity: ComplexityLevel
  ): number {
    return baseTime * multiplier * DURATION_FACTORS[complexity];
  }

  /**
   * Estimate cost based on base cost, multiplier, and complexity
   */
  protected estimateCost(
    baseCost: number,
    multiplier: number,
    complexity: ComplexityLevel
  ): number {
    return baseCost * multiplier * COST_FACTORS[complexity];
  }
}
