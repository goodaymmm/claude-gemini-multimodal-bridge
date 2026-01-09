import {
  AnalysisType,
  FileReference,
  ProcessingOptions,
  ResourceEstimate,
  WorkflowDefinition,
  WorkflowResult,
  WorkflowStep,
} from '../core/types.js';
import { DocumentAnalysis } from '../tools/documentAnalysis.js';
import { MultimodalProcess } from '../tools/multimodalProcess.js';
import { logger } from '../utils/logger.js';
import { safeExecute } from '../utils/errorHandler.js';
import { BaseWorkflow } from './BaseWorkflow.js';
import path from 'path';

/**
 * AnalysisWorkflow provides specialized workflows for content and document analysis
 * Combines multiple tools and layers for comprehensive analytical processing
 */
export class AnalysisWorkflow extends BaseWorkflow {
  private documentAnalysis: DocumentAnalysis;
  private multimodalProcess: MultimodalProcess;

  constructor(id?: string) {
    super('analysis', 900000, id); // 15 minutes
    this.documentAnalysis = new DocumentAnalysis();
    this.multimodalProcess = new MultimodalProcess();
  }

  /**
   * Execute comprehensive content analysis workflow
   */
  async executeContentAnalysis(
    files: FileReference[],
    analysisType: AnalysisType = 'comprehensive',
    options?: ProcessingOptions
  ): Promise<WorkflowResult> {
    return safeExecute(
      async () => {
        logger.info('Starting content analysis workflow', {
          fileCount: files.length,
          analysisType,
          workflowId: this.id,
        });

        // Determine file types for optimal processing
        const fileTypes = this.categorizeFiles(files);
        
        // Create dynamic workflow based on file types
        const workflow = this.createContentAnalysisWorkflow(files, fileTypes, analysisType, options);
        
        // Execute the workflow
        return await this.orchestrator.executeWorkflow(workflow);
      },
      {
        operationName: 'content-analysis-workflow',
        layer: 'claude' as const,
        timeout: this.timeout,
      }
    );
  }

  /**
   * Execute comparative analysis workflow
   */
  async executeComparativeAnalysis(
    files: FileReference[],
    comparisonType: 'similarity' | 'differences' | 'comprehensive' = 'comprehensive',
    options?: ProcessingOptions
  ): Promise<WorkflowResult> {
    return safeExecute(
      async () => {
        if (files.length < 2) {
          throw new Error('Comparative analysis requires at least 2 files');
        }

        logger.info('Starting comparative analysis workflow', {
          fileCount: files.length,
          comparisonType,
          workflowId: this.id,
        });

        const workflow = this.createComparativeAnalysisWorkflow(files, comparisonType, options);
        return await this.orchestrator.executeWorkflow(workflow);
      },
      {
        operationName: 'comparative-analysis-workflow',
        layer: 'claude' as const,
        timeout: this.timeout,
      }
    );
  }

  /**
   * Execute thematic analysis workflow
   */
  async executeThematicAnalysis(
    files: FileReference[],
    themes: string[],
    options?: ProcessingOptions
  ): Promise<WorkflowResult> {
    return safeExecute(
      async () => {
        logger.info('Starting thematic analysis workflow', {
          fileCount: files.length,
          themeCount: themes.length,
          workflowId: this.id,
        });

        const workflow = this.createThematicAnalysisWorkflow(files, themes, options);
        return await this.orchestrator.executeWorkflow(workflow);
      },
      {
        operationName: 'thematic-analysis-workflow',
        layer: 'claude' as const,
        timeout: this.timeout,
      }
    );
  }

  /**
   * Execute sentiment analysis workflow
   */
  async executeSentimentAnalysis(
    files: FileReference[],
    granularity: 'document' | 'paragraph' | 'sentence' = 'document',
    options?: ProcessingOptions
  ): Promise<WorkflowResult> {
    return safeExecute(
      async () => {
        logger.info('Starting sentiment analysis workflow', {
          fileCount: files.length,
          granularity,
          workflowId: this.id,
        });

        const workflow = this.createSentimentAnalysisWorkflow(files, granularity, options);
        return await this.orchestrator.executeWorkflow(workflow);
      },
      {
        operationName: 'sentiment-analysis-workflow',
        layer: 'claude' as const,
        timeout: this.timeout,
      }
    );
  }

  /**
   * Execute trend analysis workflow
   */
  async executeTrendAnalysis(
    files: FileReference[],
    timeframe?: { start: Date; end: Date },
    options?: ProcessingOptions
  ): Promise<WorkflowResult> {
    return safeExecute(
      async () => {
        logger.info('Starting trend analysis workflow', {
          fileCount: files.length,
          hasTimeframe: !!timeframe,
          workflowId: this.id,
        });

        const workflow = this.createTrendAnalysisWorkflow(files, timeframe, options);
        return await this.orchestrator.executeWorkflow(workflow);
      },
      {
        operationName: 'trend-analysis-workflow',
        layer: 'claude' as const,
        timeout: this.timeout,
      }
    );
  }

  /**
   * Execute statistical analysis workflow
   */
  async executeStatisticalAnalysis(
    files: FileReference[],
    analysisTypes: ('descriptive' | 'correlation' | 'regression' | 'clustering')[],
    options?: ProcessingOptions
  ): Promise<WorkflowResult> {
    return safeExecute(
      async () => {
        logger.info('Starting statistical analysis workflow', {
          fileCount: files.length,
          analysisTypes,
          workflowId: this.id,
        });

        const workflow = this.createStatisticalAnalysisWorkflow(files, analysisTypes, options);
        return await this.orchestrator.executeWorkflow(workflow);
      },
      {
        operationName: 'statistical-analysis-workflow',
        layer: 'claude' as const,
        timeout: this.timeout * 1.5, // Statistical analysis may take longer
      }
    );
  }

  /**
   * Validate inputs for analysis workflows
   */
  validateInputs(inputs: any): boolean {
    if (!inputs.files || !Array.isArray(inputs.files) || inputs.files.length === 0) {
      return false;
    }

    // Check file accessibility and types
    for (const file of inputs.files) {
      if (!file.path || typeof file.path !== 'string') {
        return false;
      }
    }

    return true;
  }

  /**
   * Estimate resource requirements
   */
  estimateResourceRequirements(inputs: any): ResourceEstimate {
    const fileCount = inputs.files?.length || 0;
    const complexity = this.assessComplexity(inputs.files, inputs.prompt, inputs.options);
    
    const baseMemory = 512; // MB
    const baseCPU = 1.0;
    const baseDuration = 300000; // 5 minutes
    const baseCost = 0.05;

    // Scale based on file count
    const memoryMultiplier = Math.min(fileCount * 0.5, 4); // Max 4x
    const durationMultiplier = Math.min(fileCount * 0.3, 3); // Max 3x

    // Adjust based on complexity
    const complexityMultipliers = {
      low: { estimated_tokens: 1, complexity_score: 1, estimated_duration: 1, estimated_cost: 1 },
      medium: { estimated_tokens: 1.5, complexity_score: 1.2, estimated_duration: 1.5, estimated_cost: 1.3 },
      high: { estimated_tokens: 2, complexity_score: 1.5, estimated_duration: 2, estimated_cost: 1.6 },
    };

    const multiplier = complexityMultipliers[complexity];

    return {
      estimated_duration: baseDuration * durationMultiplier * multiplier.estimated_duration,
      estimated_cost: baseCost * multiplier.estimated_cost,
      estimated_tokens: baseMemory * memoryMultiplier * multiplier.estimated_tokens,
      complexity_score: Math.min(baseCPU * multiplier.complexity_score / 10, 10),
      recommended_execution_mode: 'adaptive' as const,
      required_capabilities: ['claude', 'gemini', 'aistudio'] as const,
    };
  }

  /**
   * Categorize files by type for optimal processing
   */
  private categorizeFiles(files: FileReference[]): {
    documents: FileReference[];
    images: FileReference[];
    audio: FileReference[];
    video: FileReference[];
    multimodal: FileReference[];
    structured: FileReference[];
  } {
    const categories = {
      documents: [] as FileReference[],
      images: [] as FileReference[],
      audio: [] as FileReference[],
      video: [] as FileReference[],
      multimodal: [] as FileReference[],
      structured: [] as FileReference[],
    };

    const documentExts = ['.pdf', '.doc', '.docx', '.txt', '.md', '.rtf'];
    const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp'];
    const audioExts = ['.mp3', '.wav', '.m4a', '.flac'];
    const videoExts = ['.mp4', '.mov', '.avi', '.webm'];
    const structuredExts = ['.csv', '.xlsx', '.json', '.xml'];

    for (const file of files) {
      const ext = path.extname(file.path).toLowerCase();
      
      if (documentExts.includes(ext)) {
        categories.documents.push(file);
      } else if (imageExts.includes(ext)) {
        categories.images.push(file);
        categories.multimodal.push(file);
      } else if (audioExts.includes(ext)) {
        categories.audio.push(file);
        categories.multimodal.push(file);
      } else if (videoExts.includes(ext)) {
        categories.video.push(file);
        categories.multimodal.push(file);
      } else if (structuredExts.includes(ext)) {
        categories.structured.push(file);
      }
    }

    return categories;
  }

  /**
   * Assess complexity of analysis task
   */
  private assessComplexity(
    files: FileReference[],
    prompt?: string,
    options?: ProcessingOptions
  ): 'low' | 'medium' | 'high' {
    let complexityScore = 0;

    // File count factor
    if (files.length > 10) {complexityScore += 2;}
    else if (files.length > 5) {complexityScore += 1;}

    // File size factor
    const totalSize = files.reduce((sum, file) => sum + (file.size || 0), 0);
    if (totalSize > 100 * 1024 * 1024) {complexityScore += 2;} // > 100MB
    else if (totalSize > 10 * 1024 * 1024) {complexityScore += 1;} // > 10MB

    // File type diversity
    const fileTypes = this.categorizeFiles(files);
    const typeCount = Object.values(fileTypes).filter(arr => arr.length > 0).length;
    if (typeCount > 3) {complexityScore += 2;}
    else if (typeCount > 1) {complexityScore += 1;}

    // Options complexity
    if (options?.depth === 'deep') {complexityScore += 2;}
    if (options?.extractMetadata) {complexityScore += 1;}
    if (options?.structured) {complexityScore += 1;}

    // Prompt complexity
    if (prompt && prompt.length > 1000) {complexityScore += 1;}
    if (prompt && /\b(compare|analyze|correlate|synthesize)\b/i.test(prompt)) {complexityScore += 1;}

    if (complexityScore >= 6) {return 'high';}
    if (complexityScore >= 3) {return 'medium';}
    return 'low';
  }

  /**
   * Create content analysis workflow
   */
  private createContentAnalysisWorkflow(
    files: FileReference[],
    fileTypes: any,
    analysisType: AnalysisType,
    options?: ProcessingOptions
  ): WorkflowDefinition {
    const steps: WorkflowStep[] = [];

    // Step 1: Content extraction
    if (fileTypes.multimodal.length > 0) {
      steps.push({
        id: 'extract_multimodal_content',
        layer: 'aistudio' as const,
        action: 'multimodal_processing',
        input: {
          files: fileTypes.multimodal,
          instructions: 'Extract all content from multimodal files including text, metadata, and descriptions',
        },
        dependsOn: [],
      });
    }

    if (fileTypes.documents.length > 0) {
      steps.push({
        id: 'extract_document_content',
        layer: 'aistudio' as const,
        action: 'document_analysis',
        input: {
          files: fileTypes.documents,
          instructions: 'Extract text content, structure, and metadata from documents',
        },
        dependsOn: [],
      });
    }

    // Step 2: Initial analysis
    steps.push({
      id: 'initial_content_analysis',
      layer: 'claude' as const,
      action: 'complex_reasoning',
      input: {
        prompt: `Perform ${analysisType} analysis of the extracted content. Identify themes, patterns, and key insights.`,
        context: 'Multimodal: {{extract_multimodal_content}}, Documents: {{extract_document_content}}',
        depth: options?.depth || 'medium',
      },
      dependsOn: ['extract_multimodal_content', 'extract_document_content'].filter(dep => 
        steps.some(step => step.id === dep)
      ),
    });

    // Step 3: Enhanced analysis with grounding (if needed)
    if (this.needsGrounding(analysisType, options)) {
      steps.push({
        id: 'grounded_analysis',
        layer: 'gemini' as const,
        action: 'grounded_search',
        input: {
          prompt: 'Enhance the analysis with current contextual information: {{initial_content_analysis}}',
          useSearch: true,
        },
        dependsOn: ['initial_content_analysis'],
      });
    }

    // Step 4: Final synthesis
    steps.push({
      id: 'synthesize_analysis',
      layer: 'claude' as const,
      action: 'synthesize_response',
      input: {
        request: 'Create comprehensive analysis report with insights and conclusions',
        inputs: {
          initialAnalysis: '{{initial_content_analysis}}',
          groundedEnhancement: '{{grounded_analysis}}',
        },
      },
      dependsOn: ['initial_content_analysis', ...(this.needsGrounding(analysisType, options) ? ['grounded_analysis'] : [])],
    });

    return {
      id: `content_analysis_${Date.now()}`,
      steps,
      continueOnError: false,
      timeout: this.timeout,
    };
  }

  /**
   * Create comparative analysis workflow
   */
  private createComparativeAnalysisWorkflow(
    files: FileReference[],
    comparisonType: string,
    options?: ProcessingOptions
  ): WorkflowDefinition {
    return {
      id: `comparative_analysis_${Date.now()}`,
      steps: [
        {
          id: 'extract_all_content',
          layer: 'aistudio' as const,
          action: 'document_analysis',
          input: {
            files,
            instructions: 'Extract content from all files for comparative analysis',
          },
          dependsOn: [],
        },
        {
          id: 'perform_comparison',
          layer: 'claude' as const,
          action: 'complex_reasoning',
          input: {
            prompt: `Perform ${comparisonType} comparison of the extracted content. Focus on similarities, differences, and relationships.`,
            context: '{{extract_all_content}}',
            depth: 'deep',
          },
          dependsOn: ['extract_all_content'],
        },
        {
          id: 'generate_comparison_report',
          layer: 'claude' as const,
          action: 'synthesize_response',
          input: {
            request: 'Generate detailed comparison report with findings and insights',
            inputs: { comparison: '{{perform_comparison}}' },
          },
          dependsOn: ['perform_comparison'],
        },
      ],
      continueOnError: false,
      timeout: this.timeout,
    };
  }

  /**
   * Create thematic analysis workflow
   */
  private createThematicAnalysisWorkflow(
    files: FileReference[],
    themes: string[],
    options?: ProcessingOptions
  ): WorkflowDefinition {
    return {
      id: `thematic_analysis_${Date.now()}`,
      steps: [
        {
          id: 'extract_content_for_themes',
          layer: 'aistudio' as const,
          action: 'document_analysis',
          input: {
            files,
            instructions: `Extract content and identify occurrences of themes: ${themes.join(', ')}`,
          },
          dependsOn: [],
        },
        {
          id: 'analyze_theme_patterns',
          layer: 'claude' as const,
          action: 'complex_reasoning',
          input: {
            prompt: `Analyze thematic patterns for: ${themes.join(', ')}. Identify relationships, frequencies, and contextual usage.`,
            context: '{{extract_content_for_themes}}',
            depth: 'deep',
          },
          dependsOn: ['extract_content_for_themes'],
        },
        {
          id: 'synthesize_thematic_insights',
          layer: 'claude' as const,
          action: 'synthesize_response',
          input: {
            request: 'Synthesize thematic analysis with insights about theme development and relationships',
            inputs: { thematicAnalysis: '{{analyze_theme_patterns}}' },
          },
          dependsOn: ['analyze_theme_patterns'],
        },
      ],
      continueOnError: false,
      timeout: this.timeout,
    };
  }

  /**
   * Create sentiment analysis workflow
   */
  private createSentimentAnalysisWorkflow(
    files: FileReference[],
    granularity: string,
    options?: ProcessingOptions
  ): WorkflowDefinition {
    return {
      id: `sentiment_analysis_${Date.now()}`,
      steps: [
        {
          id: 'extract_text_content',
          layer: 'aistudio' as const,
          action: 'document_analysis',
          input: {
            files,
            instructions: `Extract text content segmented by ${granularity} for sentiment analysis`,
          },
          dependsOn: [],
        },
        {
          id: 'analyze_sentiment',
          layer: 'claude' as const,
          action: 'complex_reasoning',
          input: {
            prompt: `Perform detailed sentiment analysis at ${granularity} level. Identify emotions, tone, and sentiment patterns.`,
            context: '{{extract_text_content}}',
            depth: 'medium',
          },
          dependsOn: ['extract_text_content'],
        },
        {
          id: 'aggregate_sentiment_insights',
          layer: 'claude' as const,
          action: 'synthesize_response',
          input: {
            request: 'Aggregate sentiment analysis results and provide overall sentiment insights',
            inputs: { sentimentData: '{{analyze_sentiment}}' },
          },
          dependsOn: ['analyze_sentiment'],
        },
      ],
      continueOnError: false,
      timeout: this.timeout,
    };
  }

  /**
   * Create trend analysis workflow
   */
  private createTrendAnalysisWorkflow(
    files: FileReference[],
    timeframe?: { start: Date; end: Date },
    options?: ProcessingOptions
  ): WorkflowDefinition {
    return {
      id: `trend_analysis_${Date.now()}`,
      steps: [
        {
          id: 'extract_temporal_content',
          layer: 'aistudio' as const,
          action: 'document_analysis',
          input: {
            files,
            instructions: `Extract content with temporal information${timeframe ? ` between ${timeframe.start} and ${timeframe.end}` : ''}`,
          },
          dependsOn: [],
        },
        {
          id: 'identify_trends',
          layer: 'claude' as const,
          action: 'complex_reasoning',
          input: {
            prompt: 'Identify trends, patterns, and changes over time in the content',
            context: '{{extract_temporal_content}}',
            depth: 'deep',
          },
          dependsOn: ['extract_temporal_content'],
        },
        {
          id: 'contextualize_trends',
          layer: 'gemini' as const,
          action: 'grounded_search',
          input: {
            prompt: 'Provide current context for identified trends: {{identify_trends}}',
            useSearch: true,
          },
          dependsOn: ['identify_trends'],
        },
        {
          id: 'synthesize_trend_analysis',
          layer: 'claude' as const,
          action: 'synthesize_response',
          input: {
            request: 'Create comprehensive trend analysis report with predictions and insights',
            inputs: {
              trends: '{{identify_trends}}',
              context: '{{contextualize_trends}}',
            },
          },
          dependsOn: ['identify_trends', 'contextualize_trends'],
        },
      ],
      continueOnError: false,
      timeout: this.timeout,
    };
  }

  /**
   * Create statistical analysis workflow
   */
  private createStatisticalAnalysisWorkflow(
    files: FileReference[],
    analysisTypes: string[],
    options?: ProcessingOptions
  ): WorkflowDefinition {
    return {
      id: `statistical_analysis_${Date.now()}`,
      steps: [
        {
          id: 'extract_numerical_data',
          layer: 'aistudio' as const,
          action: 'document_analysis',
          input: {
            files,
            instructions: 'Extract all numerical data, tables, and quantitative information',
          },
          dependsOn: [],
        },
        {
          id: 'perform_statistical_analysis',
          layer: 'claude' as const,
          action: 'complex_reasoning',
          input: {
            prompt: `Perform ${analysisTypes.join(', ')} statistical analysis on the extracted data`,
            context: '{{extract_numerical_data}}',
            depth: 'deep',
          },
          dependsOn: ['extract_numerical_data'],
        },
        {
          id: 'interpret_results',
          layer: 'claude' as const,
          action: 'synthesize_response',
          input: {
            request: 'Interpret statistical results and provide insights with visualizable summaries',
            inputs: { statisticalAnalysis: '{{perform_statistical_analysis}}' },
          },
          dependsOn: ['perform_statistical_analysis'],
        },
      ],
      continueOnError: false,
      timeout: this.timeout * 1.5, // Statistical analysis may take longer
    };
  }

  /**
   * Check if analysis needs grounding
   */
  private needsGrounding(analysisType: AnalysisType, options?: ProcessingOptions): boolean {
    const groundingTypes: AnalysisType[] = ['comprehensive'];
    return groundingTypes.includes(analysisType) || options?.requiresGrounding === true;
  }

  /**
   * Get available analysis types
   */
  getAvailableAnalysisTypes(): AnalysisType[] {
    return ['comprehensive', 'comparative'];
  }

  /**
   * Get workflow capabilities
   */
  getCapabilities(): string[] {
    return [
      'content_analysis',
      'comparative_analysis',
      'thematic_analysis',
      'sentiment_analysis',
      'trend_analysis',
      'statistical_analysis',
    ];
  }
}