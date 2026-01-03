import {
  FileReference,
  LayerResult,
  MultimodalFile,
  MultimodalProcessArgs,
  MultimodalProcessArgsSchema,
  MultimodalProcessResult,
  ProcessingOptions,
  WorkflowResult,
  WorkflowType,
} from '../core/types.js';
import { LayerManager } from '../core/LayerManager.js';
import { logger } from '../utils/logger.js';
import { retry, safeExecute } from '../utils/errorHandler.js';
import { AuthVerifier } from '../auth/AuthVerifier.js';
import path from 'path';
import fs from 'fs/promises';

/**
 * MultimodalProcess tool handles processing of multimodal content through the 3-layer pipeline
 * Supports various workflow types and provides intelligent routing to optimal processing layers
 */
export class MultimodalProcess {
  private layerManager: LayerManager;
  private authVerifier: AuthVerifier;
  private readonly MAX_FILES = 50;
  private readonly MAX_FILE_SIZE = 500 * 1024 * 1024; // 500MB total
  private readonly SUPPORTED_FORMATS = {
    images: ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg', '.tiff'],
    documents: ['.pdf', '.txt', '.md', '.doc', '.docx', '.rtf', '.odt'],
    audio: ['.mp3', '.wav', '.m4a', '.flac', '.aac', '.ogg'],
    video: ['.mp4', '.mov', '.avi', '.webm', '.mkv', '.wmv'],
    presentations: ['.ppt', '.pptx', '.odp'],
    spreadsheets: ['.xls', '.xlsx', '.ods', '.csv'],
  };

  constructor(config?: any) {
    // Create default config if not provided
    const defaultConfig = {
      gemini: { api_key: '', model: 'gemini-2.5-pro', timeout: 60000, max_tokens: 16384, temperature: 0.2 },
      claude: { code_path: 'claude', timeout: 300000 },
      aistudio: { enabled: true, max_files: 10, max_file_size: 100 },
      cache: { enabled: true, ttl: 3600 },
      logging: { level: 'info' as const },
    };
    
    this.layerManager = new LayerManager(config || defaultConfig);
    this.authVerifier = new AuthVerifier();
  }

  /**
   * Main multimodal processing method
   */
  async processMultimodal(args: MultimodalProcessArgs): Promise<MultimodalProcessResult> {
    return safeExecute(
      async () => {
        const startTime = Date.now();
        
        logger.info('Starting multimodal processing', {
          fileCount: args.files.length,
          workflow: args.workflow,
          promptLength: args.prompt.length,
        });

        // Validate inputs
        const validatedArgs = this.validateArgs(args);
        
        // Prepare files for processing
        const processedFiles = await this.prepareFiles(validatedArgs.files);
        
        // Verify authentication for required services
        await this.verifyRequiredAuthentications(validatedArgs);
        
        // Execute processing workflow
        const result = await this.executeWorkflow(validatedArgs, processedFiles);
        
        const totalDuration = Date.now() - startTime;
        
        return {
          success: true,
          content: result.summary || 'Processing completed',
          files_processed: processedFiles.map(f => f.path),
          processing_time: totalDuration,
          workflow_used: validatedArgs.workflow,
          layers_involved: this.extractLayersFromWorkflowResult(result),
          metadata: {
            total_duration: totalDuration,
            tokens_used: this.extractTotalTokens(result),
            cost: result.metadata?.total_cost,
          },
        };
      },
      {
        operationName: 'multimodal-process',
        layer: 'claude', // Use valid LayerType
        timeout: 600000, // 10 minutes
      }
    );
  }

  /**
   * Process single file with specific instructions
   */
  async processSingleFile(
    filePath: string,
    instructions: string,
    options?: ProcessingOptions
  ): Promise<MultimodalProcessResult> {
    const file = await this.createFileReference(filePath);
    
    return this.processMultimodal({
      prompt: instructions,
      files: [file],
      workflow: this.detectWorkflowType([file], instructions),
      options: options || {},
    });
  }

  /**
   * Process multiple files with batch processing optimization
   */
  async processBatch(
    filePaths: string[],
    instructions: string,
    options?: ProcessingOptions
  ): Promise<MultimodalProcessResult> {
    const files = await Promise.all(
      filePaths.map(path => this.createFileReference(path))
    );
    
    return this.processMultimodal({
      prompt: instructions,
      files,
      workflow: 'generation',
      options: {
        ...options,
        batchMode: true,
        parallelProcessing: options?.parallelProcessing ?? true,
      },
    });
  }

  /**
   * Analyze content without specific instructions
   */
  async analyzeContent(filePaths: string[]): Promise<MultimodalProcessResult> {
    const files = await Promise.all(
      filePaths.map(path => this.createFileReference(path))
    );
    
    const instructions = this.generateAnalysisInstructions(files);
    
    return this.processMultimodal({
      prompt: instructions,
      files,
      workflow: 'analysis',
      options: {
        detailed: true,
        extractMetadata: true,
      },
    });
  }

  /**
   * Convert files between formats
   */
  async convertFiles(
    filePaths: string[],
    targetFormat: string,
    options?: ProcessingOptions
  ): Promise<MultimodalProcessResult> {
    const files = await Promise.all(
      filePaths.map(path => this.createFileReference(path))
    );
    
    const instructions = `Convert the provided files to ${targetFormat} format. Maintain quality and preserve important content structure.`;
    
    return this.processMultimodal({
      prompt: instructions,
      files,
      workflow: 'conversion',
      options: {
        ...options,
        outputFormat: targetFormat,
        quality_level: 'quality',
      },
    });
  }

  /**
   * Extract specific information from files
   */
  async extractInformation(
    filePaths: string[],
    extractionType: 'text' | 'metadata' | 'data' | 'structure',
    options?: ProcessingOptions
  ): Promise<MultimodalProcessResult> {
    const files = await Promise.all(
      filePaths.map(path => this.createFileReference(path))
    );
    
    const instructions = this.generateExtractionInstructions(extractionType);
    
    return this.processMultimodal({
      prompt: instructions,
      files,
      workflow: 'extraction',
      options: {
        ...options,
        extractionType,
        structured: true,
      },
    });
  }

  /**
   * Validate processing arguments
   */
  private validateArgs(args: MultimodalProcessArgs): MultimodalProcessArgs {
    const validationResult = MultimodalProcessArgsSchema.safeParse(args);
    
    if (!validationResult.success) {
      throw new Error(`Invalid arguments: ${validationResult.error.message}`);
    }

    // Allow text-only workflows for certain workflow types (addresses Error2.md validation issue)
    if (args.files.length === 0) {
      const textOnlyWorkflows = ['generation', 'analysis'];
      const isTextOnlyAllowed = textOnlyWorkflows.includes(args.workflow);
      
      if (!isTextOnlyAllowed) {
        throw new Error('At least one file must be provided for this workflow type');
      }
      
      // For text-only workflows, ensure the prompt is sufficient
      if (!args.prompt || args.prompt.trim().length < 10) {
        throw new Error('For text-only workflows, a detailed prompt (minimum 10 characters) is required');
      }
      
      logger.debug('Text-only workflow validated', {
        workflow: args.workflow,
        promptLength: args.prompt.length,
        filesProvided: args.files.length
      });
    }

    if (args.files.length > this.MAX_FILES) {
      throw new Error(`Too many files. Maximum ${this.MAX_FILES} files allowed`);
    }

    if (!args.prompt?.trim()) {
      throw new Error('Prompt is required for processing');
    }

    return validationResult.data;
  }

  /**
   * Prepare files for processing
   */
  private async prepareFiles(files: FileReference[]): Promise<MultimodalFile[]> {
    return retry(
      async () => {
        const processedFiles: MultimodalFile[] = [];
        let totalSize = 0;

        for (const file of files) {
          // Verify file exists and is accessible
          await this.verifyFileAccess(file.path);
          
          // Get file info
          const stats = await fs.stat(file.path);
          const size = stats.size;
          
          totalSize += size;
          if (totalSize > this.MAX_FILE_SIZE) {
            throw new Error(`Total file size exceeds ${this.MAX_FILE_SIZE / 1024 / 1024}MB limit`);
          }

          // Determine file type
          const fileType = this.determineFileType(file.path);
          
          // Create processed file reference
          const processedFile: MultimodalFile = {
            path: file.path,
            size,
            type: fileType,
            encoding: file.encoding || 'utf-8',
            name: path.basename(file.path),
            metadata: {
              mimeType: this.getMimeType(file.path),
            },
          };

          processedFiles.push(processedFile);
          
          logger.debug('File prepared for processing', {
            name: processedFile.name,
            path: processedFile.path,
            size: processedFile.size,
            type: processedFile.type,
          });
        }

        return processedFiles;
      },
      {
        maxAttempts: 2,
        delay: 1000,
        operationName: 'prepare-files',
      }
    );
  }

  /**
   * Verify file access
   */
  private async verifyFileAccess(filePath: string): Promise<void> {
    try {
      await fs.access(filePath, fs.constants.R_OK);
    } catch (error) {
      throw new Error(`File not accessible: ${filePath}`);
    }
  }

  /**
   * Determine optimal file type for processing
   */
  private determineFileType(filePath: string): 'image' | 'audio' | 'pdf' | 'document' | 'text' | 'video' {
    const ext = path.extname(filePath).toLowerCase();
    
    if (this.SUPPORTED_FORMATS.images.includes(ext)) {return 'image';}
    if (ext === '.pdf') {return 'pdf';}
    if (this.SUPPORTED_FORMATS.documents.includes(ext)) {return 'document';}
    if (this.SUPPORTED_FORMATS.audio.includes(ext)) {return 'audio';}
    if (this.SUPPORTED_FORMATS.video.includes(ext)) {return 'video';}
    
    return 'text'; // Default to text for unknown files
  }

  /**
   * Get MIME type for file
   */
  private getMimeType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    
    const mimeTypes: Record<string, string> = {
      '.pdf': 'application/pdf',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.mp4': 'video/mp4',
      '.txt': 'text/plain',
      '.md': 'text/markdown',
      '.doc': 'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    };
    
    return mimeTypes[ext] || 'application/octet-stream';
  }

  /**
   * Verify required authentications based on workflow
   */
  private async verifyRequiredAuthentications(args: MultimodalProcessArgs): Promise<void> {
    const requiredServices = this.determineRequiredServices(args);
    
    for (const service of requiredServices) {
      let authResult;
      
      switch (service) {
        case 'gemini':
          authResult = await this.authVerifier.verifyGeminiAuth();
          break;
        case 'aistudio':
          authResult = await this.authVerifier.verifyAIStudioAuth();
          break;
        case 'claude':
          authResult = await this.authVerifier.verifyClaudeCodeAuth();
          break;
        default:
          continue;
      }
      
      if (!authResult.success) {
        throw new Error(`${service} authentication required: ${authResult.error}`);
      }
    }
  }

  /**
   * Determine required services based on workflow type and files
   */
  private determineRequiredServices(args: MultimodalProcessArgs): string[] {
    const services = new Set<string>();
    
    // Always need Claude for reasoning and synthesis
    services.add('claude');
    
    // Determine if we need specialized services
    const hasMultimodalFiles = args.files.some(f => 
      this.determineFileType(f.path) !== 'document' && this.determineFileType(f.path) !== 'text'
    );
    
    if (hasMultimodalFiles || args.workflow === 'analysis') {
      services.add('aistudio');
    }
    
    // Check if grounding/search is needed
    const needsGrounding = this.needsGrounding(args.prompt);
    if (needsGrounding || args.workflow === 'analysis') {
      services.add('gemini');
    }
    
    return Array.from(services);
  }

  /**
   * Check if instructions suggest need for grounding
   */
  private needsGrounding(instructions: string): boolean {
    const groundingKeywords = [
      'latest', 'recent', 'current', 'up-to-date', 'real-time',
      'search', 'find information', 'lookup', 'research',
      'today', 'yesterday', 'this week', 'this month', 'this year'
    ];
    
    const lowerInstructions = instructions.toLowerCase();
    return groundingKeywords.some(keyword => lowerInstructions.includes(keyword));
  }

  /**
   * Execute the processing workflow
   */
  private async executeWorkflow(
    args: MultimodalProcessArgs,
    files: MultimodalFile[]
  ): Promise<WorkflowResult> {
    return retry(
      async () => {
        const workflowTask = {
          type: 'multimodal',
          action: 'multimodal_processing',
          workflowType: args.workflow,
          files,
          instructions: args.prompt,
          options: args.options || {},
        };

        logger.info('Executing multimodal workflow', {
          workflowType: args.workflow,
          fileCount: files.length,
          optionsSet: Object.keys(args.options || {}).length,
        });

        // Execute through layer manager with intelligent routing
        return await this.layerManager.processMultimodal(workflowTask.instructions, workflowTask.files, workflowTask.workflowType, workflowTask.options);
      },
      {
        maxAttempts: 3,
        delay: 2000,
        operationName: 'execute-workflow',
      }
    );
  }

  /**
   * Detect optimal workflow type based on files and instructions
   */
  private detectWorkflowType(files: FileReference[], instructions: string): WorkflowType {
    const fileTypes = files.map(f => this.determineFileType(f.path));
    const hasImages = fileTypes.includes('image');
    const hasDocuments = fileTypes.includes('document');
    const hasAudio = fileTypes.includes('audio');
    const hasVideo = fileTypes.includes('video');
    
    const lowerInstructions = instructions.toLowerCase();
    
    // Specific workflow detection
    if (lowerInstructions.includes('convert') || lowerInstructions.includes('transform')) {
      return 'conversion';
    }
    
    if (lowerInstructions.includes('extract') || lowerInstructions.includes('get data')) {
      return 'extraction';
    }
    
    if (lowerInstructions.includes('generate') || lowerInstructions.includes('create')) {
      return 'generation';
    }
    
    // Default to analysis for most cases
    return 'analysis';
  }

  /**
   * Generate analysis instructions for content
   */
  private generateAnalysisInstructions(files: MultimodalFile[]): string {
    const fileTypes = [...new Set(files.map(f => f.type))];
    const fileCount = files.length;
    
    let instructions = `Please analyze the provided ${fileCount} file${fileCount > 1 ? 's' : ''}. `;
    
    if (fileTypes.includes('image')) {
      instructions += 'For images, describe the visual content, identify objects, text, and any notable features. ';
    }
    
    if (fileTypes.includes('document')) {
      instructions += 'For documents, summarize the content, extract key information, and identify the main topics. ';
    }
    
    if (fileTypes.includes('audio')) {
      instructions += 'For audio files, transcribe the content and analyze the speech or music. ';
    }
    
    if (fileTypes.includes('video')) {
      instructions += 'For videos, describe the visual content and extract any audio/speech. ';
    }
    
    instructions += 'Provide a comprehensive analysis with structured output.';
    
    return instructions;
  }

  /**
   * Generate extraction instructions
   */
  private generateExtractionInstructions(extractionType: string): string {
    const instructions = {
      text: 'Extract all text content from the provided files. Maintain formatting and structure where possible.',
      metadata: 'Extract metadata information from the files including creation date, author, file properties, and technical details.',
      data: 'Extract structured data from the files including tables, lists, numbers, and key-value pairs.',
      structure: 'Extract the structural information showing the organization, hierarchy, and layout of the content.',
    };
    
    return instructions[extractionType as keyof typeof instructions] || 
           'Extract relevant information from the provided files.';
  }

  /**
   * Create file reference from path
   */
  private async createFileReference(filePath: string): Promise<FileReference> {
    const stats = await fs.stat(filePath);
    
    return {
      path: filePath,
      size: stats.size,
      type: this.determineFileType(filePath),
      encoding: 'utf-8',
    };
  }

  /**
   * Extract layers used from workflow result
   */
  private extractLayersFromWorkflowResult(result: WorkflowResult): ('claude' | 'gemini' | 'aistudio' | 'workflow' | 'tool' | 'orchestrator')[] {
    const validLayers = ['claude', 'gemini', 'aistudio', 'workflow', 'tool', 'orchestrator'] as const;
    const layers = new Set<typeof validLayers[number]>();
    
    Object.values(result.results).forEach(layerResult => {
      if (layerResult.metadata?.layer && validLayers.includes(layerResult.metadata.layer as any)) {
        layers.add(layerResult.metadata.layer as any);
      }
    });
    
    return Array.from(layers);
  }

  /**
   * Extract total tokens from workflow result
   */
  private extractTotalTokens(result: WorkflowResult): number {
    return Object.values(result.results).reduce((total, layerResult) => {
      return total + (layerResult.metadata?.tokens_used || 0);
    }, 0);
  }

  /**
   * Extract layers used from result
   */
  private extractLayersUsed(result: LayerResult): ('claude' | 'gemini' | 'aistudio' | 'workflow' | 'tool' | 'orchestrator')[] {
    const validLayers = ['claude', 'gemini', 'aistudio', 'workflow', 'tool', 'orchestrator'] as const;
    const layers = new Set<typeof validLayers[number]>();
    
    if (result.metadata?.layer && validLayers.includes(result.metadata.layer as any)) {
      layers.add(result.metadata.layer as any);
    }
    
    // Check for nested results indicating multiple layers
    if (typeof result.data === 'object' && result.data !== null) {
      const dataStr = JSON.stringify(result.data);
      validLayers.forEach(layer => {
        if (dataStr.includes(layer)) {
          layers.add(layer);
        }
      });
    }
    
    return Array.from(layers);
  }

  /**
   * Get supported file formats
   */
  getSupportedFormats(): typeof this.SUPPORTED_FORMATS {
    return this.SUPPORTED_FORMATS;
  }

  /**
   * Check if file type is supported
   */
  isFileSupported(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return Object.values(this.SUPPORTED_FORMATS)
      .some(formats => formats.includes(ext));
  }

  /**
   * Get processing limits
   */
  getProcessingLimits(): {
    maxFiles: number;
    maxFileSize: number;
    maxFileSizeMB: number;
  } {
    return {
      maxFiles: this.MAX_FILES,
      maxFileSize: this.MAX_FILE_SIZE,
      maxFileSizeMB: this.MAX_FILE_SIZE / 1024 / 1024,
    };
  }
}