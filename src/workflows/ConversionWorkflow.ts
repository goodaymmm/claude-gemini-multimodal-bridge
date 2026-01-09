import {
  FileReference,
  ProcessingOptions,
  ResourceEstimate,
  WorkflowDefinition,
  WorkflowResult,
} from '../core/types.js';
import { MultimodalProcess } from '../tools/multimodalProcess.js';
import { logger } from '../utils/logger.js';
import { safeExecute } from '../utils/errorHandler.js';
import { BaseWorkflow } from './BaseWorkflow.js';
import path from 'path';

/**
 * ConversionWorkflow provides specialized workflows for file format conversion
 * Supports various conversion types including document, image, audio, and data format conversions
 */
export class ConversionWorkflow extends BaseWorkflow {
  private multimodalProcess: MultimodalProcess;

  private readonly SUPPORTED_CONVERSIONS = {
    document: {
      from: ['.pdf', '.doc', '.docx', '.txt', '.md', '.rtf', '.odt'],
      to: ['.pdf', '.docx', '.txt', '.md', '.html'],
    },
    image: {
      from: ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.tiff'],
      to: ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg'],
    },
    audio: {
      from: ['.mp3', '.wav', '.m4a', '.flac', '.aac', '.ogg'],
      to: ['.mp3', '.wav', '.m4a', '.flac'],
    },
    data: {
      from: ['.csv', '.xlsx', '.json', '.xml', '.yaml'],
      to: ['.csv', '.xlsx', '.json', '.xml', '.yaml'],
    },
    presentation: {
      from: ['.ppt', '.pptx', '.odp'],
      to: ['.pptx', '.pdf', '.html'],
    },
  };

  constructor(id?: string) {
    super('conversion', 600000, id); // 10 minutes
    this.multimodalProcess = new MultimodalProcess();
  }

  /**
   * Execute document format conversion workflow
   */
  async executeDocumentConversion(
    files: FileReference[],
    targetFormat: string,
    options?: ProcessingOptions & { 
      preserveFormatting?: boolean;
      extractImages?: boolean;
      quality?: 'low' | 'medium' | 'high';
    }
  ): Promise<WorkflowResult> {
    return safeExecute(
      async () => {
        logger.info('Starting document conversion workflow', {
          fileCount: files.length,
          targetFormat,
          workflowId: this.id,
        });

        // Validate conversion feasibility
        this.validateConversion('document', files, targetFormat);

        const workflow = this.createDocumentConversionWorkflow(files, targetFormat, options);
        return await this.orchestrator.executeWorkflow(workflow);
      },
      {
        operationName: 'document-conversion-workflow',
        layer: 'claude' as const,
        timeout: this.timeout,
      }
    );
  }

  /**
   * Execute image format conversion workflow
   */
  async executeImageConversion(
    files: FileReference[],
    targetFormat: string,
    options?: ProcessingOptions & {
      resize?: { width: number; height: number };
      quality?: number;
      compress?: boolean;
    }
  ): Promise<WorkflowResult> {
    return safeExecute(
      async () => {
        logger.info('Starting image conversion workflow', {
          fileCount: files.length,
          targetFormat,
          workflowId: this.id,
        });

        this.validateConversion('image', files, targetFormat);

        const workflow = this.createImageConversionWorkflow(files, targetFormat, options);
        return await this.orchestrator.executeWorkflow(workflow);
      },
      {
        operationName: 'image-conversion-workflow',
        layer: 'claude' as const,
        timeout: this.timeout,
      }
    );
  }

  /**
   * Execute audio format conversion workflow
   */
  async executeAudioConversion(
    files: FileReference[],
    targetFormat: string,
    options?: ProcessingOptions & {
      bitrate?: number;
      sampleRate?: number;
      channels?: number;
    }
  ): Promise<WorkflowResult> {
    return safeExecute(
      async () => {
        logger.info('Starting audio conversion workflow', {
          fileCount: files.length,
          targetFormat,
          workflowId: this.id,
        });

        this.validateConversion('audio', files, targetFormat);

        const workflow = this.createAudioConversionWorkflow(files, targetFormat, options);
        return await this.orchestrator.executeWorkflow(workflow);
      },
      {
        operationName: 'audio-conversion-workflow',
        layer: 'claude' as const,
        timeout: this.timeout,
      }
    );
  }

  /**
   * Execute data format conversion workflow
   */
  async executeDataConversion(
    files: FileReference[],
    targetFormat: string,
    options?: ProcessingOptions & {
      preserveStructure?: boolean;
      includeMetadata?: boolean;
      encoding?: string;
    }
  ): Promise<WorkflowResult> {
    return safeExecute(
      async () => {
        logger.info('Starting data conversion workflow', {
          fileCount: files.length,
          targetFormat,
          workflowId: this.id,
        });

        this.validateConversion('data', files, targetFormat);

        const workflow = this.createDataConversionWorkflow(files, targetFormat, options);
        return await this.orchestrator.executeWorkflow(workflow);
      },
      {
        operationName: 'data-conversion-workflow',
        layer: 'claude' as const,
        timeout: this.timeout,
      }
    );
  }

  /**
   * Execute batch conversion workflow
   */
  async executeBatchConversion(
    conversions: Array<{
      files: FileReference[];
      targetFormat: string;
      options?: ProcessingOptions;
    }>
  ): Promise<WorkflowResult> {
    return safeExecute(
      async () => {
        logger.info('Starting batch conversion workflow', {
          conversionCount: conversions.length,
          workflowId: this.id,
        });

        const workflow = this.createBatchConversionWorkflow(conversions);
        return await this.orchestrator.executeWorkflow(workflow);
      },
      {
        operationName: 'batch-conversion-workflow',
        layer: 'claude' as const,
        timeout: this.timeout * conversions.length,
      }
    );
  }

  /**
   * Execute content extraction and conversion workflow
   */
  async executeContentExtractionConversion(
    files: FileReference[],
    extractionType: 'text' | 'images' | 'data' | 'all',
    targetFormat: string,
    options?: ProcessingOptions
  ): Promise<WorkflowResult> {
    return safeExecute(
      async () => {
        logger.info('Starting content extraction conversion workflow', {
          fileCount: files.length,
          extractionType,
          targetFormat,
          workflowId: this.id,
        });

        const workflow = this.createContentExtractionConversionWorkflow(
          files,
          extractionType,
          targetFormat,
          options
        );
        return await this.orchestrator.executeWorkflow(workflow);
      },
      {
        operationName: 'content-extraction-conversion-workflow',
        layer: 'claude' as const,
        timeout: this.timeout,
      }
    );
  }

  /**
   * Validate inputs for conversion workflows
   */
  validateInputs(inputs: any): boolean {
    if (!inputs.files || !Array.isArray(inputs.files) || inputs.files.length === 0) {
      return false;
    }

    if (!inputs.targetFormat || typeof inputs.targetFormat !== 'string') {
      return false;
    }

    // Validate each file
    for (const file of inputs.files) {
      if (!file.path || typeof file.path !== 'string') {
        return false;
      }

      const ext = path.extname(file.path).toLowerCase();
      if (!this.isSupportedSourceFormat(ext)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Estimate resource requirements for conversion
   */
  estimateResourceRequirements(inputs: any): ResourceEstimate {
    const fileCount = inputs.files?.length || 0;
    const totalSize = inputs.files?.reduce((sum: number, file: any) => sum + (file.size || 0), 0) || 0;
    const complexity = this.assessConversionComplexity(inputs.files, inputs.options);
    
    // Base requirements
    const memory = 1024; // MB
    const cpu = 1.5;
    const duration = 120000; // 2 minutes
    const cost = 0.02;

    // Scale with file count and size
    const sizeMultiplier = Math.min(totalSize / (10 * 1024 * 1024), 10); // Max 10x for 100MB+
    const countMultiplier = Math.min(fileCount * 0.5, 5); // Max 5x

    // Adjust for complexity
    const complexityMultipliers = {
      low: { estimated_tokens: 1, complexity_score: 1, estimated_duration: 1, estimated_cost: 1 },
      medium: { estimated_tokens: 1.5, complexity_score: 1.3, estimated_duration: 1.5, estimated_cost: 1.3 },
      high: { estimated_tokens: 2.5, complexity_score: 2, estimated_duration: 2.5, estimated_cost: 2 },
    };

    const multiplier = complexityMultipliers[complexity];

    return {
      estimated_tokens: memory * Math.max(sizeMultiplier, countMultiplier) * multiplier.estimated_tokens,
      complexity_score: cpu * multiplier.complexity_score,
      estimated_duration: duration * Math.max(sizeMultiplier, countMultiplier) * multiplier.estimated_duration,
      recommended_execution_mode: 'adaptive' as const,
      required_capabilities: ['claude', 'gemini', 'aistudio'] as const,
      estimated_cost: cost * multiplier.estimated_cost,
    };
  }

  /**
   * Validate conversion feasibility for any supported type
   * @param conversionType - Type of conversion (document, image, audio, data)
   * @param files - Files to validate
   * @param targetFormat - Target format to convert to
   */
  private validateConversion(
    conversionType: 'document' | 'image' | 'audio' | 'data',
    files: FileReference[],
    targetFormat: string
  ): void {
    const supported = this.SUPPORTED_CONVERSIONS[conversionType];

    let normalizedTarget = targetFormat;
    if (!normalizedTarget.startsWith('.')) {
      normalizedTarget = '.' + normalizedTarget;
    }

    if (!supported.to.includes(normalizedTarget as any)) {
      throw new Error(`Unsupported target format for ${conversionType}: ${targetFormat}`);
    }

    for (const file of files) {
      const ext = path.extname(file.path).toLowerCase();
      if (!supported.from.includes(ext as any)) {
        throw new Error(`Unsupported source format for ${conversionType}: ${file.path}`);
      }
    }
  }

  /**
   * Create document conversion workflow
   */
  private createDocumentConversionWorkflow(
    files: FileReference[],
    targetFormat: string,
    options?: any
  ): WorkflowDefinition {
    return {
      id: `document_conversion_${Date.now()}`,
      steps: [
        {
          id: 'prepare_documents',
          layer: 'aistudio' as const,
          action: 'document_analysis',
          input: {
            files,
            instructions: 'Analyze document structure and content for conversion',
          },
          dependsOn: [],
        },
        {
          id: 'convert_documents',
          layer: 'aistudio' as const,
          action: 'convert_file',
          input: {
            files,
            outputFormat: targetFormat,
            options: {
              preserveFormatting: options?.preserveFormatting ?? true,
              extractImages: options?.extractImages ?? false,
              quality: options?.quality ?? 'high',
            },
          },
          dependsOn: ['prepare_documents'],
        },
        {
          id: 'verify_conversion',
          layer: 'claude' as const,
          action: 'synthesize_response',
          input: {
            request: 'Verify conversion quality and generate conversion report',
            inputs: {
              originalAnalysis: '{{prepare_documents}}',
              conversionResult: '{{convert_documents}}',
            },
          },
          dependsOn: ['convert_documents'],
        },
      ],
      continueOnError: false,
      timeout: this.timeout,
    };
  }

  /**
   * Create image conversion workflow
   */
  private createImageConversionWorkflow(
    files: FileReference[],
    targetFormat: string,
    options?: any
  ): WorkflowDefinition {
    return {
      id: `image_conversion_${Date.now()}`,
      steps: [
        {
          id: 'analyze_images',
          layer: 'aistudio' as const,
          action: 'analyze_image',
          input: {
            files,
            instructions: 'Analyze image properties for optimal conversion',
          },
          dependsOn: [],
        },
        {
          id: 'convert_images',
          layer: 'aistudio' as const,
          action: 'convert_file',
          input: {
            files,
            outputFormat: targetFormat,
            options: {
              resize: options?.resize,
              quality: options?.quality ?? 90,
              compress: options?.compress ?? false,
            },
          },
          dependsOn: ['analyze_images'],
        },
        {
          id: 'verify_image_quality',
          layer: 'claude' as const,
          action: 'synthesize_response',
          input: {
            request: 'Assess image conversion quality and provide optimization recommendations',
            inputs: {
              originalAnalysis: '{{analyze_images}}',
              conversionResult: '{{convert_images}}',
            },
          },
          dependsOn: ['convert_images'],
        },
      ],
      continueOnError: true,
      timeout: this.timeout,
    };
  }

  /**
   * Create audio conversion workflow
   */
  private createAudioConversionWorkflow(
    files: FileReference[],
    targetFormat: string,
    options?: any
  ): WorkflowDefinition {
    return {
      id: `audio_conversion_${Date.now()}`,
      steps: [
        {
          id: 'analyze_audio',
          layer: 'aistudio' as const,
          action: 'transcribe_audio',
          input: {
            files,
            instructions: 'Analyze audio properties and quality',
          },
          dependsOn: [],
        },
        {
          id: 'convert_audio',
          layer: 'aistudio' as const,
          action: 'convert_file',
          input: {
            files,
            outputFormat: targetFormat,
            options: {
              bitrate: options?.bitrate,
              sampleRate: options?.sampleRate,
              channels: options?.channels,
            },
          },
          dependsOn: ['analyze_audio'],
        },
        {
          id: 'verify_audio_quality',
          layer: 'claude' as const,
          action: 'synthesize_response',
          input: {
            request: 'Verify audio conversion quality and generate quality report',
            inputs: {
              originalAnalysis: '{{analyze_audio}}',
              conversionResult: '{{convert_audio}}',
            },
          },
          dependsOn: ['convert_audio'],
        },
      ],
      continueOnError: true,
      timeout: this.timeout,
    };
  }

  /**
   * Create data conversion workflow
   */
  private createDataConversionWorkflow(
    files: FileReference[],
    targetFormat: string,
    options?: any
  ): WorkflowDefinition {
    return {
      id: `data_conversion_${Date.now()}`,
      steps: [
        {
          id: 'analyze_data_structure',
          layer: 'aistudio' as const,
          action: 'document_analysis',
          input: {
            files,
            instructions: 'Analyze data structure and schema for conversion',
          },
          dependsOn: [],
        },
        {
          id: 'convert_data_format',
          layer: 'aistudio' as const,
          action: 'convert_file',
          input: {
            files,
            outputFormat: targetFormat,
            options: {
              preserveStructure: options?.preserveStructure ?? true,
              includeMetadata: options?.includeMetadata ?? true,
              encoding: options?.encoding ?? 'utf-8',
            },
          },
          dependsOn: ['analyze_data_structure'],
        },
        {
          id: 'validate_data_integrity',
          layer: 'claude' as const,
          action: 'complex_reasoning',
          input: {
            prompt: 'Validate data integrity and structure preservation after conversion',
            context: 'Original: {{analyze_data_structure}}, Converted: {{convert_data_format}}',
            depth: 'medium',
          },
          dependsOn: ['convert_data_format'],
        },
      ],
      continueOnError: false,
      timeout: this.timeout,
    };
  }

  /**
   * Create batch conversion workflow
   */
  private createBatchConversionWorkflow(
    conversions: Array<{
      files: FileReference[];
      targetFormat: string;
      options?: ProcessingOptions;
    }>
  ): WorkflowDefinition {
    const steps = [];

    // Create conversion steps for each batch
    conversions.forEach((conversion, index) => {
      steps.push({
        id: `batch_conversion_${index}`,
        layer: 'aistudio' as const,
        action: 'convert_file',
        input: {
          files: conversion.files,
          outputFormat: conversion.targetFormat,
          options: conversion.options || {},
        },
        dependsOn: [],
      });
    });

    // Add summary step
    steps.push({
      id: 'summarize_batch_conversion',
      layer: 'claude' as const,
      action: 'synthesize_response',
      input: {
        request: 'Summarize batch conversion results and provide quality assessment',
        inputs: Object.fromEntries(
          conversions.map((_, index) => [`conversion_${index}`, `{{batch_conversion_${index}}}`])
        ),
      },
      dependsOn: conversions.map((_, index) => `batch_conversion_${index}`),
    });

    return {
      id: `batch_conversion_${Date.now()}`,
      steps,
      continueOnError: true,
      timeout: this.timeout * conversions.length,
    };
  }

  /**
   * Create content extraction conversion workflow
   */
  private createContentExtractionConversionWorkflow(
    files: FileReference[],
    extractionType: string,
    targetFormat: string,
    options?: ProcessingOptions
  ): WorkflowDefinition {
    return {
      id: `content_extraction_conversion_${Date.now()}`,
      steps: [
        {
          id: 'extract_content',
          layer: 'aistudio' as const,
          action: 'multimodal_processing',
          input: {
            files,
            instructions: `Extract ${extractionType} content from files`,
            options: { extractionType },
          },
          dependsOn: [],
        },
        {
          id: 'convert_extracted_content',
          layer: 'aistudio' as const,
          action: 'convert_file',
          input: {
            content: '{{extract_content}}',
            outputFormat: targetFormat,
            options: options || {},
          },
          dependsOn: ['extract_content'],
        },
        {
          id: 'organize_converted_content',
          layer: 'claude' as const,
          action: 'synthesize_response',
          input: {
            request: 'Organize and structure the converted content with metadata',
            inputs: {
              extractedContent: '{{extract_content}}',
              convertedContent: '{{convert_extracted_content}}',
            },
          },
          dependsOn: ['convert_extracted_content'],
        },
      ],
      continueOnError: false,
      timeout: this.timeout,
    };
  }

  /**
   * Assess conversion complexity
   */
  private assessConversionComplexity(files: FileReference[], options?: any): 'low' | 'medium' | 'high' {
    let complexityScore = 0;

    // File count factor
    if (files.length > 20) {complexityScore += 3;}
    else if (files.length > 10) {complexityScore += 2;}
    else if (files.length > 5) {complexityScore += 1;}

    // File size factor
    const totalSize = files.reduce((sum, file) => sum + (file.size || 0), 0);
    if (totalSize > 500 * 1024 * 1024) {complexityScore += 3;} // > 500MB
    else if (totalSize > 100 * 1024 * 1024) {complexityScore += 2;} // > 100MB
    else if (totalSize > 10 * 1024 * 1024) {complexityScore += 1;} // > 10MB

    // Options complexity
    if (options?.quality === 'high') {complexityScore += 1;}
    if (options?.preserveFormatting) {complexityScore += 1;}
    if (options?.extractImages) {complexityScore += 1;}
    if (options?.resize) {complexityScore += 1;}

    if (complexityScore >= 6) {return 'high';}
    if (complexityScore >= 3) {return 'medium';}
    return 'low';
  }

  /**
   * Estimate conversion duration
   */
  private estimateConversionDuration(files: FileReference[], complexity: string): number {
    const baseTime = 30000; // 30 seconds
    const fileMultiplier = Math.min(files.length * 0.5, 10); // Max 10x
    
    const complexityMultipliers = {
      low: 1,
      medium: 2,
      high: 4,
    };

    return baseTime * fileMultiplier * complexityMultipliers[complexity as keyof typeof complexityMultipliers];
  }

  /**
   * Estimate conversion cost
   */
  private estimateConversionCost(files: FileReference[], complexity: string): number {
    const baseCost = 0.005; // $0.005 per file
    const fileCount = files.length;
    
    const complexityMultipliers = {
      low: 1,
      medium: 1.5,
      high: 2.5,
    };

    return baseCost * fileCount * complexityMultipliers[complexity as keyof typeof complexityMultipliers];
  }

  /**
   * Check if source format is supported
   */
  private isSupportedSourceFormat(extension: string): boolean {
    return Object.values(this.SUPPORTED_CONVERSIONS)
      .some(conv => conv.from.includes(extension));
  }

  /**
   * Get supported conversions
   */
  getSupportedConversions(): typeof this.SUPPORTED_CONVERSIONS {
    return this.SUPPORTED_CONVERSIONS;
  }

  /**
   * Get available conversion types
   */
  getAvailableConversionTypes(): string[] {
    return Object.keys(this.SUPPORTED_CONVERSIONS);
  }

  /**
   * Get workflow capabilities
   */
  getCapabilities(): string[] {
    return [
      'document_conversion',
      'image_conversion',
      'audio_conversion',
      'data_conversion',
      'batch_conversion',
      'content_extraction_conversion',
    ];
  }
}