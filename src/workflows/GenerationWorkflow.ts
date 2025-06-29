import {
  WorkflowDefinition,
  WorkflowResult,
  ExecutionPlan,
  ResourceEstimate,
  FileReference,
  ProcessingOptions,
} from '../core/types.js';
import { WorkflowOrchestrator } from '../tools/workflowOrchestrator.js';
import { DocumentAnalysis } from '../tools/documentAnalysis.js';
import { MultimodalProcess } from '../tools/multimodalProcess.js';
import { logger } from '../utils/logger.js';
import { safeExecute } from '../utils/errorHandler.js';
import path from 'path';

/**
 * GenerationWorkflow provides specialized workflows for content generation
 * Supports document generation, report creation, summaries, and creative content generation
 */
export class GenerationWorkflow implements WorkflowDefinition {
  id: string;
  steps: any[];
  continueOnError: boolean;
  timeout: number;

  private orchestrator: WorkflowOrchestrator;
  private documentAnalysis: DocumentAnalysis;
  private multimodalProcess: MultimodalProcess;

  private readonly GENERATION_TYPES = {
    summary: {
      description: 'Generate comprehensive summaries',
      outputFormats: ['markdown', 'html', 'pdf', 'docx'],
    },
    report: {
      description: 'Generate structured reports',
      outputFormats: ['markdown', 'html', 'pdf', 'docx'],
    },
    documentation: {
      description: 'Generate technical documentation',
      outputFormats: ['markdown', 'html', 'confluence', 'docx'],
    },
    presentation: {
      description: 'Generate presentation content',
      outputFormats: ['markdown', 'pptx', 'html'],
    },
    article: {
      description: 'Generate articles and blog posts',
      outputFormats: ['markdown', 'html', 'docx'],
    },
    analysis: {
      description: 'Generate analytical content',
      outputFormats: ['markdown', 'html', 'pdf', 'docx'],
    },
    creative: {
      description: 'Generate creative content',
      outputFormats: ['markdown', 'html', 'txt'],
    },
    technical: {
      description: 'Generate technical specifications',
      outputFormats: ['markdown', 'html', 'pdf', 'docx'],
    },
  };

  constructor(id?: string) {
    this.id = id || `generation_workflow_${Date.now()}`;
    this.steps = [];
    this.continueOnError = false;
    this.timeout = 1200000; // 20 minutes

    this.orchestrator = new WorkflowOrchestrator();
    this.documentAnalysis = new DocumentAnalysis();
    this.multimodalProcess = new MultimodalProcess();
  }

  /**
   * Execute comprehensive content generation workflow
   */
  async executeContentGeneration(
    sourceFiles: FileReference[],
    generationType: keyof typeof this.GENERATION_TYPES,
    requirements: string,
    options?: ProcessingOptions & {
      outputFormat?: string;
      length?: 'short' | 'medium' | 'long';
      tone?: 'formal' | 'informal' | 'technical' | 'creative';
      audience?: string;
      includeVisuals?: boolean;
    }
  ): Promise<WorkflowResult> {
    return safeExecute(
      async () => {
        logger.info('Starting content generation workflow', {
          sourceFileCount: sourceFiles.length,
          generationType,
          workflowId: this.id,
        });

        // Validate generation requirements
        this.validateGenerationRequirements(generationType, requirements, options);

        const workflow = this.createContentGenerationWorkflow(
          sourceFiles,
          generationType,
          requirements,
          options
        );
        return await this.orchestrator.executeWorkflow(workflow);
      },
      {
        operationName: 'content-generation-workflow',
        layer: 'claude' as const,
        timeout: this.timeout,
      }
    );
  }

  /**
   * Execute summary generation workflow
   */
  async executeSummaryGeneration(
    sourceFiles: FileReference[],
    summaryType: 'executive' | 'technical' | 'academic' | 'general',
    options?: ProcessingOptions & {
      length?: number; // word count
      includeKeyPoints?: boolean;
      includeRecommendations?: boolean;
    }
  ): Promise<WorkflowResult> {
    return safeExecute(
      async () => {
        logger.info('Starting summary generation workflow', {
          sourceFileCount: sourceFiles.length,
          summaryType,
          workflowId: this.id,
        });

        const workflow = this.createSummaryGenerationWorkflow(sourceFiles, summaryType, options);
        return await this.orchestrator.executeWorkflow(workflow);
      },
      {
        operationName: 'summary-generation-workflow',
        layer: 'claude' as const,
        timeout: this.timeout,
      }
    );
  }

  /**
   * Execute report generation workflow
   */
  async executeReportGeneration(
    sourceFiles: FileReference[],
    reportType: 'analytical' | 'financial' | 'technical' | 'research',
    specifications: {
      title: string;
      sections: string[];
      requirements: string;
    },
    options?: ProcessingOptions & {
      includeCharts?: boolean;
      includeTables?: boolean;
      includeAppendices?: boolean;
    }
  ): Promise<WorkflowResult> {
    return safeExecute(
      async () => {
        logger.info('Starting report generation workflow', {
          sourceFileCount: sourceFiles.length,
          reportType,
          sectionCount: specifications.sections.length,
          workflowId: this.id,
        });

        const workflow = this.createReportGenerationWorkflow(sourceFiles, reportType, specifications, options);
        return await this.orchestrator.executeWorkflow(workflow);
      },
      {
        operationName: 'report-generation-workflow',
        layer: 'claude' as const,
        timeout: this.timeout,
      }
    );
  }

  /**
   * Execute documentation generation workflow
   */
  async executeDocumentationGeneration(
    sourceFiles: FileReference[],
    documentationType: 'api' | 'user' | 'technical' | 'installation',
    structure: {
      overview: boolean;
      gettingStarted: boolean;
      detailedGuide: boolean;
      examples: boolean;
      troubleshooting: boolean;
    },
    options?: ProcessingOptions
  ): Promise<WorkflowResult> {
    return safeExecute(
      async () => {
        logger.info('Starting documentation generation workflow', {
          sourceFileCount: sourceFiles.length,
          documentationType,
          workflowId: this.id,
        });

        const workflow = this.createDocumentationGenerationWorkflow(
          sourceFiles,
          documentationType,
          structure,
          options
        );
        return await this.orchestrator.executeWorkflow(workflow);
      },
      {
        operationName: 'documentation-generation-workflow',
        layer: 'claude' as const,
        timeout: this.timeout,
      }
    );
  }

  /**
   * Execute presentation generation workflow
   */
  async executePresentationGeneration(
    sourceFiles: FileReference[],
    presentationType: 'business' | 'academic' | 'technical' | 'sales',
    slideStructure: {
      introduction: boolean;
      mainContent: string[];
      conclusion: boolean;
      targetSlideCount: number;
    },
    options?: ProcessingOptions & {
      includeNotes?: boolean;
      visualStyle?: 'minimal' | 'corporate' | 'creative';
    }
  ): Promise<WorkflowResult> {
    return safeExecute(
      async () => {
        logger.info('Starting presentation generation workflow', {
          sourceFileCount: sourceFiles.length,
          presentationType,
          targetSlideCount: slideStructure.targetSlideCount,
          workflowId: this.id,
        });

        const workflow = this.createPresentationGenerationWorkflow(
          sourceFiles,
          presentationType,
          slideStructure,
          options
        );
        return await this.orchestrator.executeWorkflow(workflow);
      },
      {
        operationName: 'presentation-generation-workflow',
        layer: 'claude' as const,
        timeout: this.timeout,
      }
    );
  }

  /**
   * Execute creative content generation workflow
   */
  async executeCreativeGeneration(
    sourceFiles: FileReference[],
    creativeType: 'story' | 'poem' | 'script' | 'marketing' | 'social',
    creativePrompt: string,
    options?: ProcessingOptions & {
      style?: string;
      mood?: string;
      targetLength?: number;
      inspiration?: string[];
    }
  ): Promise<WorkflowResult> {
    return safeExecute(
      async () => {
        logger.info('Starting creative content generation workflow', {
          sourceFileCount: sourceFiles.length,
          creativeType,
          workflowId: this.id,
        });

        const workflow = this.createCreativeGenerationWorkflow(
          sourceFiles,
          creativeType,
          creativePrompt,
          options
        );
        return await this.orchestrator.executeWorkflow(workflow);
      },
      {
        operationName: 'creative-generation-workflow',
        layer: 'claude' as const,
        timeout: this.timeout,
      }
    );
  }

  /**
   * Execute comparative analysis generation workflow
   */
  async executeComparativeAnalysisGeneration(
    sourceFiles: FileReference[],
    comparisonCriteria: string[],
    outputType: 'matrix' | 'narrative' | 'scorecard',
    options?: ProcessingOptions
  ): Promise<WorkflowResult> {
    return safeExecute(
      async () => {
        logger.info('Starting comparative analysis generation workflow', {
          sourceFileCount: sourceFiles.length,
          criteriaCount: comparisonCriteria.length,
          outputType,
          workflowId: this.id,
        });

        const workflow = this.createComparativeAnalysisGenerationWorkflow(
          sourceFiles,
          comparisonCriteria,
          outputType,
          options
        );
        return await this.orchestrator.executeWorkflow(workflow);
      },
      {
        operationName: 'comparative-analysis-generation-workflow',
        layer: 'claude' as const,
        timeout: this.timeout,
      }
    );
  }

  /**
   * Create execution plan for generation workflows
   */
  async createExecutionPlan(files: FileReference[], prompt: string, options?: ProcessingOptions): Promise<ExecutionPlan> {
    const generationComplexity = this.assessGenerationComplexity(files, prompt, options);
    const contentLength = this.estimateContentLength(prompt, options);
    
    const phases = [];
    let estimatedDuration = 0;
    let estimatedCost = 0;

    // Phase 1: Content analysis and research
    phases.push({
      name: 'research',
      steps: ['analyze_sources', 'extract_insights', 'research_context'],
      requiredLayers: ['aistudio', 'gemini'],
    });
    estimatedDuration += 180000;

    // Phase 2: Content planning and structure
    phases.push({
      name: 'planning',
      steps: ['create_outline', 'plan_structure', 'organize_content'],
      requiredLayers: ['claude'],
    });
    estimatedDuration += 120000;

    // Phase 3: Content generation
    const generationDuration = this.estimateGenerationDuration(contentLength, generationComplexity);
    phases.push({
      name: 'generation',
      steps: ['generate_content', 'enhance_with_context', 'refine_output'],
      requiredLayers: ['claude', 'gemini'],
    });
    estimatedDuration += generationDuration;
    estimatedCost += this.estimateGenerationCost(contentLength, generationComplexity);

    // Phase 4: Review and formatting
    phases.push({
      name: 'finalization',
      steps: ['review_content', 'format_output', 'quality_check'],
      requiredLayers: ['claude'],
    });
    estimatedDuration += 120000;

    return {
      steps: [],
      timeout: estimatedDuration,
    };
  }

  /**
   * Validate inputs for generation workflows
   */
  validateInputs(inputs: any): boolean {
    if (!inputs.generationType || typeof inputs.generationType !== 'string') {
      return false;
    }

    if (!(inputs.generationType in this.GENERATION_TYPES)) {
      return false;
    }

    if (!inputs.requirements || typeof inputs.requirements !== 'string') {
      return false;
    }

    if (inputs.sourceFiles && !Array.isArray(inputs.sourceFiles)) {
      return false;
    }

    return true;
  }

  /**
   * Estimate resource requirements for generation
   */
  estimateResourceRequirements(inputs: any): ResourceEstimate {
    const sourceFileCount = inputs.sourceFiles?.length || 0;
    const contentLength = this.estimateContentLength(inputs.requirements, inputs.options);
    const complexity = this.assessGenerationComplexity(inputs.sourceFiles, inputs.requirements, inputs.options);
    
    // Base requirements
    let memory = 512; // MB
    let cpu = 1.0;
    let duration = 300000; // 5 minutes
    let cost = 0.05;

    // Scale with content length and source files
    const lengthMultiplier = Math.min(contentLength / 1000, 5); // Max 5x for 5000+ words
    const sourceMultiplier = Math.min(sourceFileCount * 0.2, 2); // Max 2x

    // Adjust for complexity
    const complexityMultipliers = {
      low: { estimated_tokens: 1, complexity_score: 1, estimated_duration: 1, estimated_cost: 1 },
      medium: { estimated_tokens: 1.5, complexity_score: 1.3, estimated_duration: 2, estimated_cost: 1.5 },
      high: { estimated_tokens: 2.5, complexity_score: 2, estimated_duration: 4, estimated_cost: 2.5 },
    };

    const multiplier = complexityMultipliers[complexity];

    return {
      estimated_tokens: memory * lengthMultiplier * sourceMultiplier * multiplier.estimated_tokens,
      complexity_score: cpu * multiplier.complexity_score,
      estimated_duration: duration * lengthMultiplier * multiplier.estimated_duration,
      recommended_execution_mode: 'adaptive' as const,
      required_capabilities: ['claude', 'gemini', 'aistudio'] as const,
      estimated_cost: cost * lengthMultiplier * multiplier.estimated_cost,
    };
  }

  /**
   * Validate generation requirements
   */
  private validateGenerationRequirements(
    generationType: keyof typeof this.GENERATION_TYPES,
    requirements: string,
    options?: any
  ): void {
    if (!requirements.trim()) {
      throw new Error('Generation requirements cannot be empty');
    }

    if (requirements.length < 10) {
      throw new Error('Generation requirements must be more descriptive');
    }

    const supportedFormats = this.GENERATION_TYPES[generationType].outputFormats;
    if (options?.outputFormat && !supportedFormats.includes(options.outputFormat)) {
      throw new Error(`Unsupported output format ${options.outputFormat} for ${generationType}`);
    }
  }

  /**
   * Create content generation workflow
   */
  private createContentGenerationWorkflow(
    sourceFiles: FileReference[],
    generationType: keyof typeof this.GENERATION_TYPES,
    requirements: string,
    options?: any
  ): WorkflowDefinition {
    const steps = [];

    // Step 1: Analyze source content (if provided)
    if (sourceFiles.length > 0) {
      steps.push({
        id: 'analyze_sources',
        layer: 'aistudio' as const,
        action: 'document_analysis',
        input: {
          files: sourceFiles,
          instructions: 'Analyze source content for generation insights',
        },
        dependsOn: [],
      });
    }

    // Step 2: Research and context gathering
    if (this.needsGrounding(generationType, requirements)) {
      steps.push({
        id: 'research_context',
        layer: 'gemini' as const,
        action: 'grounded_search',
        input: {
          prompt: `Research current information relevant to: ${requirements}`,
          useSearch: true,
        },
        dependsOn: [],
      });
    }

    // Step 3: Content planning
    steps.push({
      id: 'plan_content',
      layer: 'claude' as const,
      action: 'complex_reasoning',
      input: {
        prompt: this.buildPlanningPrompt(generationType, requirements, options),
        context: this.buildContextFromSteps(steps),
        depth: 'medium',
      },
      dependsOn: steps.map(step => step.id),
    });

    // Step 4: Generate content
    steps.push({
      id: 'generate_content',
      layer: 'claude' as const,
      action: 'synthesize_response',
      input: {
        request: this.buildGenerationPrompt(generationType, requirements, options),
        inputs: {
          plan: '{{plan_content}}',
          sources: sourceFiles.length > 0 ? '{{analyze_sources}}' : undefined,
          research: this.needsGrounding(generationType, requirements) ? '{{research_context}}' : undefined,
        },
      },
      dependsOn: ['plan_content'],
    });

    // Step 5: Review and refine
    steps.push({
      id: 'review_and_refine',
      layer: 'claude' as const,
      action: 'complex_reasoning',
      input: {
        prompt: 'Review the generated content for quality, accuracy, and adherence to requirements',
        context: '{{generate_content}}',
        depth: 'medium',
      },
      dependsOn: ['generate_content'],
    });

    return {
      id: `content_generation_${generationType}_${Date.now()}`,
      steps,
      continueOnError: false,
      timeout: this.timeout,
    };
  }

  /**
   * Create summary generation workflow
   */
  private createSummaryGenerationWorkflow(
    sourceFiles: FileReference[],
    summaryType: string,
    options?: any
  ): WorkflowDefinition {
    return {
      id: `summary_generation_${Date.now()}`,
      steps: [
        {
          id: 'analyze_content_for_summary',
          layer: 'aistudio' as const,
          action: 'document_analysis',
          input: {
            files: sourceFiles,
            instructions: `Analyze content for ${summaryType} summary generation`,
          },
          dependsOn: [],
        },
        {
          id: 'generate_summary',
          layer: 'claude' as const,
          action: 'synthesize_response',
          input: {
            request: this.buildSummaryPrompt(summaryType, options),
            inputs: { sourceContent: '{{analyze_content_for_summary}}' },
          },
          dependsOn: ['analyze_content_for_summary'],
        },
        {
          id: 'refine_summary',
          layer: 'claude' as const,
          action: 'complex_reasoning',
          input: {
            prompt: 'Refine summary for clarity, conciseness, and completeness',
            context: '{{generate_summary}}',
            depth: 'medium',
          },
          dependsOn: ['generate_summary'],
        },
      ],
      continueOnError: false,
      timeout: this.timeout,
    };
  }

  /**
   * Create report generation workflow
   */
  private createReportGenerationWorkflow(
    sourceFiles: FileReference[],
    reportType: string,
    specifications: any,
    options?: any
  ): WorkflowDefinition {
    return {
      id: `report_generation_${Date.now()}`,
      steps: [
        {
          id: 'analyze_data_for_report',
          layer: 'aistudio' as const,
          action: 'document_analysis',
          input: {
            files: sourceFiles,
            instructions: `Analyze data for ${reportType} report generation`,
          },
          dependsOn: [],
        },
        {
          id: 'create_report_structure',
          layer: 'claude' as const,
          action: 'complex_reasoning',
          input: {
            prompt: `Create detailed structure for ${reportType} report with sections: ${specifications.sections.join(', ')}`,
            context: '{{analyze_data_for_report}}',
            depth: 'deep',
          },
          dependsOn: ['analyze_data_for_report'],
        },
        {
          id: 'generate_report_content',
          layer: 'claude' as const,
          action: 'synthesize_response',
          input: {
            request: `Generate comprehensive ${reportType} report: ${specifications.requirements}`,
            inputs: {
              data: '{{analyze_data_for_report}}',
              structure: '{{create_report_structure}}',
            },
          },
          dependsOn: ['create_report_structure'],
        },
        {
          id: 'format_report',
          layer: 'claude' as const,
          action: 'synthesize_response',
          input: {
            request: 'Format report with proper headings, sections, and professional presentation',
            inputs: { reportContent: '{{generate_report_content}}' },
          },
          dependsOn: ['generate_report_content'],
        },
      ],
      continueOnError: false,
      timeout: this.timeout,
    };
  }

  /**
   * Create documentation generation workflow
   */
  private createDocumentationGenerationWorkflow(
    sourceFiles: FileReference[],
    documentationType: string,
    structure: any,
    options?: any
  ): WorkflowDefinition {
    return {
      id: `documentation_generation_${Date.now()}`,
      steps: [
        {
          id: 'analyze_technical_content',
          layer: 'aistudio' as const,
          action: 'document_analysis',
          input: {
            files: sourceFiles,
            instructions: `Analyze technical content for ${documentationType} documentation`,
          },
          dependsOn: [],
        },
        {
          id: 'create_documentation_outline',
          layer: 'claude' as const,
          action: 'complex_reasoning',
          input: {
            prompt: `Create comprehensive outline for ${documentationType} documentation`,
            context: '{{analyze_technical_content}}',
            depth: 'deep',
          },
          dependsOn: ['analyze_technical_content'],
        },
        {
          id: 'generate_documentation_sections',
          layer: 'claude' as const,
          action: 'synthesize_response',
          input: {
            request: 'Generate detailed documentation sections with examples and best practices',
            inputs: {
              content: '{{analyze_technical_content}}',
              outline: '{{create_documentation_outline}}',
            },
          },
          dependsOn: ['create_documentation_outline'],
        },
        {
          id: 'format_documentation',
          layer: 'claude' as const,
          action: 'synthesize_response',
          input: {
            request: 'Format documentation with proper markdown, code blocks, and navigation',
            inputs: { documentation: '{{generate_documentation_sections}}' },
          },
          dependsOn: ['generate_documentation_sections'],
        },
      ],
      continueOnError: false,
      timeout: this.timeout,
    };
  }

  /**
   * Create presentation generation workflow
   */
  private createPresentationGenerationWorkflow(
    sourceFiles: FileReference[],
    presentationType: string,
    slideStructure: any,
    options?: any
  ): WorkflowDefinition {
    return {
      id: `presentation_generation_${Date.now()}`,
      steps: [
        {
          id: 'analyze_presentation_content',
          layer: 'aistudio' as const,
          action: 'document_analysis',
          input: {
            files: sourceFiles,
            instructions: `Analyze content for ${presentationType} presentation`,
          },
          dependsOn: [],
        },
        {
          id: 'create_slide_outline',
          layer: 'claude' as const,
          action: 'complex_reasoning',
          input: {
            prompt: `Create detailed slide outline for ${slideStructure.targetSlideCount} slides`,
            context: '{{analyze_presentation_content}}',
            depth: 'medium',
          },
          dependsOn: ['analyze_presentation_content'],
        },
        {
          id: 'generate_slide_content',
          layer: 'claude' as const,
          action: 'synthesize_response',
          input: {
            request: 'Generate engaging slide content with bullet points and speaker notes',
            inputs: {
              content: '{{analyze_presentation_content}}',
              outline: '{{create_slide_outline}}',
            },
          },
          dependsOn: ['create_slide_outline'],
        },
      ],
      continueOnError: false,
      timeout: this.timeout,
    };
  }

  /**
   * Create creative generation workflow
   */
  private createCreativeGenerationWorkflow(
    sourceFiles: FileReference[],
    creativeType: string,
    creativePrompt: string,
    options?: any
  ): WorkflowDefinition {
    return {
      id: `creative_generation_${Date.now()}`,
      steps: [
        {
          id: 'gather_creative_inspiration',
          layer: 'aistudio' as const,
          action: 'document_analysis',
          input: {
            files: sourceFiles,
            instructions: 'Gather creative inspiration and thematic elements',
          },
          dependsOn: [],
        },
        {
          id: 'develop_creative_concept',
          layer: 'claude' as const,
          action: 'complex_reasoning',
          input: {
            prompt: `Develop creative concept for ${creativeType}: ${creativePrompt}`,
            context: '{{gather_creative_inspiration}}',
            depth: 'deep',
          },
          dependsOn: ['gather_creative_inspiration'],
        },
        {
          id: 'generate_creative_content',
          layer: 'claude' as const,
          action: 'synthesize_response',
          input: {
            request: 'Generate engaging creative content with vivid imagery and compelling narrative',
            inputs: {
              inspiration: '{{gather_creative_inspiration}}',
              concept: '{{develop_creative_concept}}',
            },
          },
          dependsOn: ['develop_creative_concept'],
        },
      ],
      continueOnError: false,
      timeout: this.timeout,
    };
  }

  /**
   * Create comparative analysis generation workflow
   */
  private createComparativeAnalysisGenerationWorkflow(
    sourceFiles: FileReference[],
    comparisonCriteria: string[],
    outputType: string,
    options?: any
  ): WorkflowDefinition {
    return {
      id: `comparative_analysis_generation_${Date.now()}`,
      steps: [
        {
          id: 'analyze_comparison_sources',
          layer: 'aistudio' as const,
          action: 'document_analysis',
          input: {
            files: sourceFiles,
            instructions: `Analyze sources for comparative analysis using criteria: ${comparisonCriteria.join(', ')}`,
          },
          dependsOn: [],
        },
        {
          id: 'perform_comparative_analysis',
          layer: 'claude' as const,
          action: 'complex_reasoning',
          input: {
            prompt: `Perform detailed comparative analysis using specified criteria`,
            context: '{{analyze_comparison_sources}}',
            depth: 'deep',
          },
          dependsOn: ['analyze_comparison_sources'],
        },
        {
          id: 'generate_comparison_output',
          layer: 'claude' as const,
          action: 'synthesize_response',
          input: {
            request: `Generate ${outputType} format comparison with insights and recommendations`,
            inputs: { analysis: '{{perform_comparative_analysis}}' },
          },
          dependsOn: ['perform_comparative_analysis'],
        },
      ],
      continueOnError: false,
      timeout: this.timeout,
    };
  }

  /**
   * Build planning prompt for content generation
   */
  private buildPlanningPrompt(generationType: string, requirements: string, options?: any): string {
    let prompt = `Create a detailed plan for generating ${generationType} content. Requirements: ${requirements}`;
    
    if (options?.length) {
      prompt += ` Target length: ${options.length}`;
    }
    
    if (options?.tone) {
      prompt += ` Tone: ${options.tone}`;
    }
    
    if (options?.audience) {
      prompt += ` Target audience: ${options.audience}`;
    }
    
    prompt += ' Provide structure, key points, and approach.';
    
    return prompt;
  }

  /**
   * Build generation prompt
   */
  private buildGenerationPrompt(generationType: string, requirements: string, options?: any): string {
    let prompt = `Generate high-quality ${generationType} content based on the plan and requirements: ${requirements}`;
    
    if (options?.outputFormat) {
      prompt += ` Format output as ${options.outputFormat}`;
    }
    
    if (options?.includeVisuals) {
      prompt += ' Include suggestions for visual elements';
    }
    
    return prompt;
  }

  /**
   * Build summary prompt
   */
  private buildSummaryPrompt(summaryType: string, options?: any): string {
    let prompt = `Generate a ${summaryType} summary of the source content`;
    
    if (options?.length) {
      prompt += ` in approximately ${options.length} words`;
    }
    
    if (options?.includeKeyPoints) {
      prompt += ' with key points highlighted';
    }
    
    if (options?.includeRecommendations) {
      prompt += ' including recommendations';
    }
    
    return prompt;
  }

  /**
   * Build context from workflow steps
   */
  private buildContextFromSteps(steps: any[]): string {
    const contextParts = [];
    
    if (steps.some(step => step.id === 'analyze_sources')) {
      contextParts.push('Source analysis: {{analyze_sources}}');
    }
    
    if (steps.some(step => step.id === 'research_context')) {
      contextParts.push('Research context: {{research_context}}');
    }
    
    return contextParts.join(', ');
  }

  /**
   * Check if generation needs grounding/research
   */
  private needsGrounding(generationType: string, requirements: string): boolean {
    const groundingTypes = ['report', 'analysis', 'technical'];
    const groundingKeywords = ['current', 'latest', 'recent', 'trends', 'market', 'industry'];
    
    return groundingTypes.includes(generationType) || 
           groundingKeywords.some(keyword => requirements.toLowerCase().includes(keyword));
  }

  /**
   * Assess generation complexity
   */
  private assessGenerationComplexity(
    sourceFiles: FileReference[],
    requirements: string,
    options?: any
  ): 'low' | 'medium' | 'high' {
    let complexityScore = 0;

    // Source file factor
    if (sourceFiles && sourceFiles.length > 10) complexityScore += 3;
    else if (sourceFiles && sourceFiles.length > 5) complexityScore += 2;
    else if (sourceFiles && sourceFiles.length > 0) complexityScore += 1;

    // Requirements complexity
    if (requirements.length > 1000) complexityScore += 2;
    else if (requirements.length > 500) complexityScore += 1;

    // Content length
    const estimatedLength = this.estimateContentLength(requirements, options);
    if (estimatedLength > 5000) complexityScore += 3;
    else if (estimatedLength > 2000) complexityScore += 2;
    else if (estimatedLength > 1000) complexityScore += 1;

    // Options complexity
    if (options?.includeVisuals) complexityScore += 1;
    if (options?.tone === 'technical') complexityScore += 1;
    if (options?.includeRecommendations) complexityScore += 1;

    if (complexityScore >= 6) return 'high';
    if (complexityScore >= 3) return 'medium';
    return 'low';
  }

  /**
   * Estimate content length
   */
  private estimateContentLength(requirements: string, options?: any): number {
    // Base estimation
    let estimatedLength = 1000; // Default 1000 words

    if (options?.length === 'short') estimatedLength = 500;
    else if (options?.length === 'medium') estimatedLength = 1500;
    else if (options?.length === 'long') estimatedLength = 3000;
    else if (typeof options?.length === 'number') estimatedLength = options.length;

    // Adjust based on requirements complexity
    if (requirements.length > 500) {
      estimatedLength *= 1.5;
    }

    return Math.floor(estimatedLength);
  }

  /**
   * Estimate generation duration
   */
  private estimateGenerationDuration(contentLength: number, complexity: string): number {
    const baseTime = 300000; // 5 minutes
    const lengthMultiplier = Math.min(contentLength / 1000, 10); // Max 10x
    
    const complexityMultipliers = {
      low: 1,
      medium: 1.8,
      high: 3,
    };

    return baseTime * lengthMultiplier * complexityMultipliers[complexity as keyof typeof complexityMultipliers];
  }

  /**
   * Estimate generation cost
   */
  private estimateGenerationCost(contentLength: number, complexity: string): number {
    const baseCost = 0.02; // $0.02 per 1000 words
    const lengthMultiplier = contentLength / 1000;
    
    const complexityMultipliers = {
      low: 1,
      medium: 1.5,
      high: 2.5,
    };

    return baseCost * lengthMultiplier * complexityMultipliers[complexity as keyof typeof complexityMultipliers];
  }

  /**
   * Get supported generation types
   */
  getSupportedGenerationTypes(): typeof this.GENERATION_TYPES {
    return this.GENERATION_TYPES;
  }

  /**
   * Get available generation types
   */
  getAvailableGenerationTypes(): string[] {
    return Object.keys(this.GENERATION_TYPES);
  }

  /**
   * Get workflow capabilities
   */
  getCapabilities(): string[] {
    return [
      'content_generation',
      'summary_generation',
      'report_generation',
      'documentation_generation',
      'presentation_generation',
      'creative_generation',
      'comparative_analysis_generation',
    ];
  }
}