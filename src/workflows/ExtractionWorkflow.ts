import {
  ExecutionPlan,
  FileReference,
  ProcessingOptions,
  ResourceEstimate,
  WorkflowDefinition,
  WorkflowResult,
} from '../core/types.js';
import { WorkflowOrchestrator } from '../tools/workflowOrchestrator.js';
import { DocumentAnalysis } from '../tools/documentAnalysis.js';
import { MultimodalProcess } from '../tools/multimodalProcess.js';
import { logger } from '../utils/logger.js';
import { safeExecute } from '../utils/errorHandler.js';
import path from 'path';

/**
 * ExtractionWorkflow provides specialized workflows for data extraction from various file types
 * Supports text, metadata, structured data, and multimodal content extraction
 */
export class ExtractionWorkflow implements WorkflowDefinition {
  id: string;
  steps: any[];
  continueOnError: boolean;
  timeout: number;

  private orchestrator: WorkflowOrchestrator;
  private documentAnalysis: DocumentAnalysis;
  private multimodalProcess: MultimodalProcess;

  private readonly EXTRACTION_TYPES = {
    text: {
      description: 'Extract all textual content',
      supportedFormats: ['.pdf', '.doc', '.docx', '.txt', '.md', '.rtf', '.html'],
    },
    metadata: {
      description: 'Extract file metadata and properties',
      supportedFormats: ['.pdf', '.doc', '.docx', '.jpg', '.png', '.mp3', '.mp4'],
    },
    structure: {
      description: 'Extract document structure and hierarchy',
      supportedFormats: ['.pdf', '.doc', '.docx', '.html', '.xml'],
    },
    data: {
      description: 'Extract structured data like tables and lists',
      supportedFormats: ['.pdf', '.doc', '.docx', '.xlsx', '.csv', '.html'],
    },
    images: {
      description: 'Extract embedded images',
      supportedFormats: ['.pdf', '.doc', '.docx', '.html'],
    },
    entities: {
      description: 'Extract named entities and key information',
      supportedFormats: ['.pdf', '.doc', '.docx', '.txt', '.md'],
    },
    audio: {
      description: 'Extract audio content and transcriptions',
      supportedFormats: ['.mp3', '.wav', '.m4a', '.mp4', '.mov'],
    },
    forms: {
      description: 'Extract form fields and data',
      supportedFormats: ['.pdf', '.jpg', '.png'],
    },
  };

  constructor(id?: string) {
    this.id = id || `extraction_workflow_${Date.now()}`;
    this.steps = [];
    
    this.continueOnError = false;
    this.timeout = 900000; // 15 minutes

    this.orchestrator = new WorkflowOrchestrator();
    this.documentAnalysis = new DocumentAnalysis();
    this.multimodalProcess = new MultimodalProcess();
  }

  /**
   * Execute comprehensive data extraction workflow
   */
  async executeComprehensiveExtraction(
    files: FileReference[],
    extractionTypes: (keyof typeof this.EXTRACTION_TYPES)[],
    options?: ProcessingOptions & {
      outputFormat?: 'json' | 'xml' | 'csv' | 'markdown';
      includeConfidence?: boolean;
      structuredOutput?: boolean;
    }
  ): Promise<WorkflowResult> {
    return safeExecute(
      async () => {
        logger.info('Starting comprehensive extraction workflow', {
          fileCount: files.length,
          extractionTypes,
          workflowId: this.id,
        });

        // Validate extraction feasibility
        this.validateExtraction(files, extractionTypes);

        const workflow = this.createComprehensiveExtractionWorkflow(files, extractionTypes, options);
        return await this.orchestrator.executeWorkflow(workflow);
      },
      {
        operationName: 'comprehensive-extraction-workflow',
        layer: 'claude' as const,
        timeout: this.timeout,
      }
    );
  }

  /**
   * Execute text extraction workflow
   */
  async executeTextExtraction(
    files: FileReference[],
    options?: ProcessingOptions & {
      preserveFormatting?: boolean;
      extractFootnotes?: boolean;
      includePageNumbers?: boolean;
    }
  ): Promise<WorkflowResult> {
    return safeExecute(
      async () => {
        logger.info('Starting text extraction workflow', {
          fileCount: files.length,
          workflowId: this.id,
        });

        const workflow = this.createTextExtractionWorkflow(files, options);
        return await this.orchestrator.executeWorkflow(workflow);
      },
      {
        operationName: 'text-extraction-workflow',
        layer: 'claude' as const,
        timeout: this.timeout,
      }
    );
  }

  /**
   * Execute structured data extraction workflow
   */
  async executeStructuredDataExtraction(
    files: FileReference[],
    dataTypes: ('tables' | 'lists' | 'forms' | 'charts' | 'key-value-pairs')[],
    options?: ProcessingOptions & {
      outputFormat?: 'json' | 'csv' | 'xml';
      includeHeaders?: boolean;
      normalizeData?: boolean;
    }
  ): Promise<WorkflowResult> {
    return safeExecute(
      async () => {
        logger.info('Starting structured data extraction workflow', {
          fileCount: files.length,
          dataTypes,
          workflowId: this.id,
        });

        const workflow = this.createStructuredDataExtractionWorkflow(files, dataTypes, options);
        return await this.orchestrator.executeWorkflow(workflow);
      },
      {
        operationName: 'structured-data-extraction-workflow',
        layer: 'claude' as const,
        timeout: this.timeout,
      }
    );
  }

  /**
   * Execute entity extraction workflow
   */
  async executeEntityExtraction(
    files: FileReference[],
    entityTypes: ('persons' | 'organizations' | 'locations' | 'dates' | 'numbers' | 'emails' | 'urls' | 'custom')[],
    options?: ProcessingOptions & {
      customEntities?: string[];
      includeContext?: boolean;
      confidence?: number;
    }
  ): Promise<WorkflowResult> {
    return safeExecute(
      async () => {
        logger.info('Starting entity extraction workflow', {
          fileCount: files.length,
          entityTypes,
          workflowId: this.id,
        });

        const workflow = this.createEntityExtractionWorkflow(files, entityTypes, options);
        return await this.orchestrator.executeWorkflow(workflow);
      },
      {
        operationName: 'entity-extraction-workflow',
        layer: 'claude' as const,
        timeout: this.timeout,
      }
    );
  }

  /**
   * Execute multimodal content extraction workflow
   */
  async executeMultimodalExtraction(
    files: FileReference[],
    contentTypes: ('text' | 'images' | 'audio' | 'video' | 'metadata')[],
    options?: ProcessingOptions & {
      transcribeAudio?: boolean;
      extractFrames?: boolean;
      analyzeImages?: boolean;
    }
  ): Promise<WorkflowResult> {
    return safeExecute(
      async () => {
        logger.info('Starting multimodal extraction workflow', {
          fileCount: files.length,
          contentTypes,
          workflowId: this.id,
        });

        const workflow = this.createMultimodalExtractionWorkflow(files, contentTypes, options);
        return await this.orchestrator.executeWorkflow(workflow);
      },
      {
        operationName: 'multimodal-extraction-workflow',
        layer: 'claude' as const,
        timeout: this.timeout,
      }
    );
  }

  /**
   * Execute form data extraction workflow
   */
  async executeFormDataExtraction(
    files: FileReference[],
    formFields?: string[],
    options?: ProcessingOptions & {
      detectFields?: boolean;
      validateData?: boolean;
      outputFormat?: 'json' | 'csv';
    }
  ): Promise<WorkflowResult> {
    return safeExecute(
      async () => {
        logger.info('Starting form data extraction workflow', {
          fileCount: files.length,
          hasFormFields: !!formFields,
          workflowId: this.id,
        });

        const workflow = this.createFormDataExtractionWorkflow(files, formFields, options);
        return await this.orchestrator.executeWorkflow(workflow);
      },
      {
        operationName: 'form-data-extraction-workflow',
        layer: 'claude' as const,
        timeout: this.timeout,
      }
    );
  }

  /**
   * Execute metadata extraction workflow
   */
  async executeMetadataExtraction(
    files: FileReference[],
    metadataTypes: ('technical' | 'descriptive' | 'administrative' | 'structural')[],
    options?: ProcessingOptions & {
      includeEXIF?: boolean;
      analyzeContent?: boolean;
    }
  ): Promise<WorkflowResult> {
    return safeExecute(
      async () => {
        logger.info('Starting metadata extraction workflow', {
          fileCount: files.length,
          metadataTypes,
          workflowId: this.id,
        });

        const workflow = this.createMetadataExtractionWorkflow(files, metadataTypes, options);
        return await this.orchestrator.executeWorkflow(workflow);
      },
      {
        operationName: 'metadata-extraction-workflow',
        layer: 'claude' as const,
        timeout: this.timeout,
      }
    );
  }

  /**
   * Create execution plan for extraction workflows
   */
  async createExecutionPlan(files: FileReference[], prompt: string, options?: ProcessingOptions): Promise<ExecutionPlan> {
    const extractionComplexity = this.assessExtractionComplexity(files, options);
    const fileTypes = this.categorizeFileTypes(files);
    
    const phases = [];
    let estimatedDuration = 0;
    let estimatedCost = 0;

    // Phase 1: File analysis and preparation
    phases.push({
      name: 'analysis',
      steps: ['analyze_files', 'determine_extraction_strategy', 'prepare_processing'],
      requiredLayers: ['aistudio'],
    });
    estimatedDuration += 60000;

    // Phase 2: Content extraction
    const extractionDuration = this.estimateExtractionDuration(files, extractionComplexity);
    phases.push({
      name: 'extraction',
      steps: ['extract_content', 'process_multimodal', 'structure_data'],
      requiredLayers: ['aistudio', 'claude'],
    });
    estimatedDuration += extractionDuration;
    estimatedCost += this.estimateExtractionCost(files, extractionComplexity);

    // Phase 3: Post-processing and organization
    phases.push({
      name: 'postprocessing',
      steps: ['organize_results', 'validate_extraction', 'generate_output'],
      requiredLayers: ['claude'],
    });
    estimatedDuration += 120000;

    return {
      steps: [],
      timeout: estimatedDuration,
    };
  }

  /**
   * Validate inputs for extraction workflows
   */
  validateInputs(inputs: any): boolean {
    if (!inputs.files || !Array.isArray(inputs.files) || inputs.files.length === 0) {
      return false;
    }

    if (!inputs.extractionTypes || !Array.isArray(inputs.extractionTypes) || inputs.extractionTypes.length === 0) {
      return false;
    }

    // Validate extraction types
    for (const type of inputs.extractionTypes) {
      if (!(type in this.EXTRACTION_TYPES)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Estimate resource requirements for extraction
   */
  estimateResourceRequirements(inputs: any): ResourceEstimate {
    const fileCount = inputs.files?.length || 0;
    const totalSize = inputs.files?.reduce((sum: number, file: any) => sum + (file.size || 0), 0) || 0;
    const extractionTypeCount = inputs.extractionTypes?.length || 1;
    const complexity = this.assessExtractionComplexity(inputs.files, inputs.options);
    
    // Base requirements
    const memory = 1024; // MB
    const cpu = 1.2;
    const duration = 180000; // 3 minutes
    const cost = 0.03;

    // Scale with file count, size, and extraction types
    const sizeMultiplier = Math.min(totalSize / (50 * 1024 * 1024), 8); // Max 8x for 400MB+
    const countMultiplier = Math.min(fileCount * 0.3, 3); // Max 3x
    const typeMultiplier = Math.min(extractionTypeCount * 0.5, 2); // Max 2x

    // Adjust for complexity
    const complexityMultipliers = {
      low: { estimated_tokens: 1, complexity_score: 1, estimated_duration: 1, estimated_cost: 1 },
      medium: { estimated_tokens: 1.5, complexity_score: 1.3, estimated_duration: 1.8, estimated_cost: 1.4 },
      high: { estimated_tokens: 2.5, complexity_score: 2, estimated_duration: 3, estimated_cost: 2.2 },
    };

    const multiplier = complexityMultipliers[complexity];

    return {
      estimated_tokens: memory * Math.max(sizeMultiplier, countMultiplier) * typeMultiplier * multiplier.estimated_tokens,
      complexity_score: cpu * multiplier.complexity_score,
      estimated_duration: duration * Math.max(sizeMultiplier, countMultiplier) * typeMultiplier * multiplier.estimated_duration,
      recommended_execution_mode: 'adaptive' as const,
      required_capabilities: ['claude', 'gemini', 'aistudio'] as const,
      estimated_cost: cost * typeMultiplier * multiplier.estimated_cost,
    };
  }

  /**
   * Validate extraction feasibility
   */
  private validateExtraction(files: FileReference[], extractionTypes: (keyof typeof this.EXTRACTION_TYPES)[]): void {
    for (const file of files) {
      const ext = path.extname(file.path).toLowerCase();
      
      for (const type of extractionTypes) {
        const supportedFormats = this.EXTRACTION_TYPES[type].supportedFormats;
        if (!supportedFormats.includes(ext)) {
          logger.warn(`Extraction type ${type} may not be supported for file: ${file.path}`);
        }
      }
    }
  }

  /**
   * Create comprehensive extraction workflow
   */
  private createComprehensiveExtractionWorkflow(
    files: FileReference[],
    extractionTypes: (keyof typeof this.EXTRACTION_TYPES)[],
    options?: any
  ): WorkflowDefinition {
    const steps = [];

    // Step 1: File analysis
    steps.push({
      id: 'analyze_files',
      layer: 'aistudio' as const,
      action: 'document_analysis',
      input: {
        files,
        instructions: 'Analyze files to determine optimal extraction strategies',
      },
      dependsOn: [],
    });

    // Step 2: Multi-type extraction
    extractionTypes.forEach((type, index) => {
      steps.push({
        id: `extract_${type}`,
        layer: 'aistudio' as const,
        action: this.getExtractionAction(type),
        input: {
          files,
          instructions: `Extract ${type} content: ${this.EXTRACTION_TYPES[type].description}`,
          extractionType: type,
          options: options || {},
        },
        dependsOn: ['analyze_files'],
      });
    });

    // Step 3: Combine and organize results
    steps.push({
      id: 'organize_extractions',
      layer: 'claude' as const,
      action: 'synthesize_response',
      input: {
        request: 'Organize and structure all extraction results into comprehensive output',
        inputs: Object.fromEntries(
          extractionTypes.map(type => [type, `{{extract_${type}}}`])
        ),
      },
      dependsOn: extractionTypes.map(type => `extract_${type}`),
    });

    return {
      id: `comprehensive_extraction_${Date.now()}`,
      steps,
      continueOnError: true,
      timeout: this.timeout,
    };
  }

  /**
   * Create text extraction workflow
   */
  private createTextExtractionWorkflow(files: FileReference[], options?: any): WorkflowDefinition {
    return {
      id: `text_extraction_${Date.now()}`,
      steps: [
        {
          id: 'extract_text_content',
          layer: 'aistudio' as const,
          action: 'document_analysis',
          input: {
            files,
            instructions: 'Extract all textual content with formatting preservation',
            options: {
              preserveFormatting: options?.preserveFormatting ?? true,
              extractFootnotes: options?.extractFootnotes ?? true,
              includePageNumbers: options?.includePageNumbers ?? false,
            },
          },
          dependsOn: [],
        },
        {
          id: 'clean_and_structure_text',
          layer: 'claude' as const,
          action: 'synthesize_response',
          input: {
            request: 'Clean and structure the extracted text for optimal readability',
            inputs: { rawText: '{{extract_text_content}}' },
          },
          dependsOn: ['extract_text_content'],
        },
      ],
      continueOnError: false,
      timeout: this.timeout,
    };
  }

  /**
   * Create structured data extraction workflow
   */
  private createStructuredDataExtractionWorkflow(
    files: FileReference[],
    dataTypes: string[],
    options?: any
  ): WorkflowDefinition {
    return {
      id: `structured_data_extraction_${Date.now()}`,
      steps: [
        {
          id: 'identify_structured_content',
          layer: 'aistudio' as const,
          action: 'document_analysis',
          input: {
            files,
            instructions: `Identify and extract structured content: ${dataTypes.join(', ')}`,
            options: {
              extractTables: dataTypes.includes('tables'),
              extractLists: dataTypes.includes('lists'),
              extractForms: dataTypes.includes('forms'),
              extractCharts: dataTypes.includes('charts'),
            },
          },
          dependsOn: [],
        },
        {
          id: 'structure_extracted_data',
          layer: 'claude' as const,
          action: 'complex_reasoning',
          input: {
            prompt: 'Structure the extracted data into normalized, usable format',
            context: '{{identify_structured_content}}',
            depth: 'medium',
          },
          dependsOn: ['identify_structured_content'],
        },
        {
          id: 'format_output',
          layer: 'claude' as const,
          action: 'synthesize_response',
          input: {
            request: `Format structured data as ${options?.outputFormat || 'json'}`,
            inputs: { structuredData: '{{structure_extracted_data}}' },
          },
          dependsOn: ['structure_extracted_data'],
        },
      ],
      continueOnError: false,
      timeout: this.timeout,
    };
  }

  /**
   * Create entity extraction workflow
   */
  private createEntityExtractionWorkflow(
    files: FileReference[],
    entityTypes: string[],
    options?: any
  ): WorkflowDefinition {
    return {
      id: `entity_extraction_${Date.now()}`,
      steps: [
        {
          id: 'extract_text_for_entities',
          layer: 'aistudio' as const,
          action: 'document_analysis',
          input: {
            files,
            instructions: 'Extract text content for entity recognition',
          },
          dependsOn: [],
        },
        {
          id: 'identify_entities',
          layer: 'claude' as const,
          action: 'complex_reasoning',
          input: {
            prompt: `Identify and extract entities of types: ${entityTypes.join(', ')}${options?.customEntities ? '. Custom entities: ' + options.customEntities.join(', ') : ''}`,
            context: '{{extract_text_for_entities}}',
            depth: 'medium',
          },
          dependsOn: ['extract_text_for_entities'],
        },
        {
          id: 'organize_entities',
          layer: 'claude' as const,
          action: 'synthesize_response',
          input: {
            request: 'Organize entities with context and confidence scores',
            inputs: {
              entities: '{{identify_entities}}',
              includeContext: options?.includeContext ?? true,
            },
          },
          dependsOn: ['identify_entities'],
        },
      ],
      continueOnError: false,
      timeout: this.timeout,
    };
  }

  /**
   * Create multimodal extraction workflow
   */
  private createMultimodalExtractionWorkflow(
    files: FileReference[],
    contentTypes: string[],
    options?: any
  ): WorkflowDefinition {
    return {
      id: `multimodal_extraction_${Date.now()}`,
      steps: [
        {
          id: 'process_multimodal_content',
          layer: 'aistudio' as const,
          action: 'multimodal_processing',
          input: {
            files,
            instructions: `Extract multimodal content: ${contentTypes.join(', ')}`,
            options: {
              transcribeAudio: options?.transcribeAudio ?? true,
              extractFrames: options?.extractFrames ?? false,
              analyzeImages: options?.analyzeImages ?? true,
            },
          },
          dependsOn: [],
        },
        {
          id: 'organize_multimodal_results',
          layer: 'claude' as const,
          action: 'synthesize_response',
          input: {
            request: 'Organize multimodal extraction results by content type',
            inputs: { multimodalContent: '{{process_multimodal_content}}' },
          },
          dependsOn: ['process_multimodal_content'],
        },
      ],
      continueOnError: false,
      timeout: this.timeout,
    };
  }

  /**
   * Create form data extraction workflow
   */
  private createFormDataExtractionWorkflow(
    files: FileReference[],
    formFields?: string[],
    options?: any
  ): WorkflowDefinition {
    return {
      id: `form_data_extraction_${Date.now()}`,
      steps: [
        {
          id: 'identify_form_structure',
          layer: 'aistudio' as const,
          action: 'document_analysis',
          input: {
            files,
            instructions: `Identify form structure and fields${formFields ? '. Target fields: ' + formFields.join(', ') : ''}`,
            options: {
              detectFields: options?.detectFields ?? true,
            },
          },
          dependsOn: [],
        },
        {
          id: 'extract_form_data',
          layer: 'claude' as const,
          action: 'complex_reasoning',
          input: {
            prompt: 'Extract form data and values with field mapping',
            context: '{{identify_form_structure}}',
            depth: 'medium',
          },
          dependsOn: ['identify_form_structure'],
        },
        {
          id: 'validate_and_format',
          layer: 'claude' as const,
          action: 'synthesize_response',
          input: {
            request: 'Validate and format form data for output',
            inputs: {
              formData: '{{extract_form_data}}',
              validateData: options?.validateData ?? true,
              outputFormat: options?.outputFormat ?? 'json',
            },
          },
          dependsOn: ['extract_form_data'],
        },
      ],
      continueOnError: false,
      timeout: this.timeout,
    };
  }

  /**
   * Create metadata extraction workflow
   */
  private createMetadataExtractionWorkflow(
    files: FileReference[],
    metadataTypes: string[],
    options?: any
  ): WorkflowDefinition {
    return {
      id: `metadata_extraction_${Date.now()}`,
      steps: [
        {
          id: 'extract_file_metadata',
          layer: 'aistudio' as const,
          action: 'document_analysis',
          input: {
            files,
            instructions: `Extract metadata types: ${metadataTypes.join(', ')}`,
            options: {
              includeEXIF: options?.includeEXIF ?? true,
              analyzeContent: options?.analyzeContent ?? true,
            },
          },
          dependsOn: [],
        },
        {
          id: 'organize_metadata',
          layer: 'claude' as const,
          action: 'synthesize_response',
          input: {
            request: 'Organize metadata into structured categories',
            inputs: { metadata: '{{extract_file_metadata}}' },
          },
          dependsOn: ['extract_file_metadata'],
        },
      ],
      continueOnError: false,
      timeout: this.timeout,
    };
  }

  /**
   * Get appropriate extraction action for type
   */
  private getExtractionAction(extractionType: keyof typeof this.EXTRACTION_TYPES): string {
    const actionMap = {
      text: 'document_analysis',
      metadata: 'document_analysis',
      structure: 'document_analysis',
      data: 'document_analysis',
      images: 'multimodal_processing',
      entities: 'document_analysis',
      audio: 'transcribe_audio',
      forms: 'document_analysis',
    };

    return actionMap[extractionType] || 'document_analysis';
  }

  /**
   * Categorize files by type
   */
  private categorizeFileTypes(files: FileReference[]): {
    documents: FileReference[];
    images: FileReference[];
    audio: FileReference[];
    multimodal: FileReference[];
  } {
    const categories = {
      documents: [] as FileReference[],
      images: [] as FileReference[],
      audio: [] as FileReference[],
      multimodal: [] as FileReference[],
    };

    for (const file of files) {
      const ext = path.extname(file.path).toLowerCase();
      
      if (['.pdf', '.doc', '.docx', '.txt', '.md'].includes(ext)) {
        categories.documents.push(file);
      } else if (['.jpg', '.png', '.gif', '.bmp'].includes(ext)) {
        categories.images.push(file);
        categories.multimodal.push(file);
      } else if (['.mp3', '.wav', '.m4a'].includes(ext)) {
        categories.audio.push(file);
        categories.multimodal.push(file);
      }
    }

    return categories;
  }

  /**
   * Assess extraction complexity
   */
  private assessExtractionComplexity(files: FileReference[], options?: any): 'low' | 'medium' | 'high' {
    let complexityScore = 0;

    // File count factor
    if (files.length > 15) {complexityScore += 3;}
    else if (files.length > 8) {complexityScore += 2;}
    else if (files.length > 3) {complexityScore += 1;}

    // File size factor
    const totalSize = files.reduce((sum, file) => sum + (file.size || 0), 0);
    if (totalSize > 200 * 1024 * 1024) {complexityScore += 3;} // > 200MB
    else if (totalSize > 50 * 1024 * 1024) {complexityScore += 2;} // > 50MB
    else if (totalSize > 10 * 1024 * 1024) {complexityScore += 1;} // > 10MB

    // Extraction type complexity
    const complexExtractionTypes = ['entities', 'forms', 'data', 'audio'];
    if (options?.extractionTypes?.some((type: string) => complexExtractionTypes.includes(type))) {
      complexityScore += 2;
    }

    // Options complexity
    if (options?.structuredOutput) {complexityScore += 1;}
    if (options?.includeConfidence) {complexityScore += 1;}
    if (options?.validateData) {complexityScore += 1;}

    if (complexityScore >= 6) {return 'high';}
    if (complexityScore >= 3) {return 'medium';}
    return 'low';
  }

  /**
   * Estimate extraction duration
   */
  private estimateExtractionDuration(files: FileReference[], complexity: string): number {
    const baseTime = 120000; // 2 minutes
    const fileMultiplier = Math.min(files.length * 0.4, 8); // Max 8x
    
    const complexityMultipliers = {
      low: 1,
      medium: 1.8,
      high: 3,
    };

    return baseTime * fileMultiplier * complexityMultipliers[complexity as keyof typeof complexityMultipliers];
  }

  /**
   * Estimate extraction cost
   */
  private estimateExtractionCost(files: FileReference[], complexity: string): number {
    const baseCost = 0.01; // $0.01 per file
    const fileCount = files.length;
    
    const complexityMultipliers = {
      low: 1,
      medium: 1.6,
      high: 2.8,
    };

    return baseCost * fileCount * complexityMultipliers[complexity as keyof typeof complexityMultipliers];
  }

  /**
   * Get supported extraction types
   */
  getSupportedExtractionTypes(): typeof this.EXTRACTION_TYPES {
    return this.EXTRACTION_TYPES;
  }

  /**
   * Get available extraction types
   */
  getAvailableExtractionTypes(): string[] {
    return Object.keys(this.EXTRACTION_TYPES);
  }

  /**
   * Get workflow capabilities
   */
  getCapabilities(): string[] {
    return [
      'comprehensive_extraction',
      'text_extraction',
      'structured_data_extraction',
      'entity_extraction',
      'multimodal_extraction',
      'form_data_extraction',
      'metadata_extraction',
    ];
  }
}