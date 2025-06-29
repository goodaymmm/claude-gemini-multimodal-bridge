import { spawn } from 'child_process';
import { LayerInterface, LayerResult, MultimodalFile, MultimodalResult, ImageAnalysisType, ImageAnalysisResult, FileReference } from '../core/types.js';
import { logger } from '../utils/logger.js';
import { safeExecute, retry } from '../utils/errorHandler.js';
import { AuthVerifier } from '../auth/AuthVerifier.js';

/**
 * AIStudioLayer handles AI Studio MCP integration with enhanced authentication support
 * Provides multimodal file processing for PDF, images, audio, and documents
 */
export class AIStudioLayer implements LayerInterface {
  private authVerifier: AuthVerifier;
  private mcpServerProcess?: any;
  private isInitialized = false;
  private readonly DEFAULT_TIMEOUT = 120000; // 2 minutes for file processing
  private readonly MAX_RETRIES = 2;
  private readonly MAX_FILES = 10;
  private readonly MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB
  private readonly SUPPORTED_FILE_TYPES = {
    images: ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp'],
    documents: ['.pdf', '.txt', '.md', '.doc', '.docx'],
    audio: ['.mp3', '.wav', '.m4a', '.flac'],
    video: ['.mp4', '.mov', '.avi', '.webm'],
  };

  constructor() {
    this.authVerifier = new AuthVerifier();
  }

  /**
   * Initialize the AI Studio layer
   */
  async initialize(): Promise<void> {
    return safeExecute(
      async () => {
        if (this.isInitialized) {
          return;
        }

        logger.info('Initializing AI Studio layer...');

        // Verify AI Studio authentication
        const authResult = await this.authVerifier.verifyAIStudioAuth();
        if (!authResult.success) {
          throw new Error(`AI Studio authentication failed: ${authResult.error}`);
        }

        // Test MCP server availability
        await this.testMCPServerConnection();

        this.isInitialized = true;
        logger.info('AI Studio layer initialized successfully', {
          authenticated: authResult.success,
          mcpServerAvailable: true,
        });
      },
      {
        operationName: 'initialize-aistudio-layer',
        layer: 'aistudio',
        timeout: 30000,
      }
    );
  }

  /**
   * Check if AI Studio layer is available
   */
  async isAvailable(): Promise<boolean> {
    try {
      if (!this.isInitialized) {
        await this.initialize();
      }
      return this.isInitialized;
    } catch (error) {
      logger.debug('AI Studio layer not available', { error: (error as Error).message });
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

    // Handle multimodal processing
    if (task.type === 'multimodal' || task.action === 'multimodal_processing') {
      return true;
    }

    // Handle document analysis
    if (task.action === 'document_analysis' || task.type === 'document') {
      return true;
    }

    // Handle image analysis
    if (task.type === 'image' || task.analysisType) {
      return true;
    }

    // Handle file conversion
    if (task.action === 'convert' || task.conversion) {
      return true;
    }

    // Handle tasks with files
    if (task.files && Array.isArray(task.files)) {
      return true;
    }

    return false;
  }

  /**
   * Execute a task through AI Studio
   */
  async execute(task: any): Promise<LayerResult> {
    return safeExecute(
      async () => {
        const startTime = Date.now();
        
        if (!this.isInitialized) {
          await this.initialize();
        }

        logger.info('Executing AI Studio task', {
          taskType: task.type || 'general',
          action: task.action || 'execute',
          fileCount: task.files ? task.files.length : 0,
        });

        let result: any;

        // Route to appropriate execution method based on task type/action
        switch (task.action || task.type) {
          case 'multimodal_processing':
          case 'multimodal':
            result = await this.processMultimodal(task.files, task.prompt || task.instructions);
            break;
          case 'document_analysis':
          case 'document':
            result = await this.analyzeDocuments(task.files || task.documents, task.instructions);
            break;
          case 'image':
            result = await this.analyzeImage(task.imagePath || task.files?.[0]?.path, task.analysisType || 'detailed');
            break;
          case 'convert':
            result = await this.convertFiles(task.files, task.outputFormat);
            break;
          default:
            result = await this.processGeneral(task);
        }

        const duration = Date.now() - startTime;
        
        return {
          success: true,
          data: result,
          metadata: {
            layer: 'aistudio' as const,
            duration,
            tokens_used: this.estimateTokensUsed(task, result),
            cost: this.calculateCost(task, result),
            model: 'gemini-2.5-pro',
          },
        };
      },
      {
        operationName: 'execute-aistudio-task',
        layer: 'aistudio',
        timeout: this.getTaskTimeout(task),
      }
    );
  }

  /**
   * Process multimodal files
   */
  async processMultimodal(files: MultimodalFile[], instructions: string): Promise<MultimodalResult> {
    return retry(
      async () => {
        logger.debug('Processing multimodal files', {
          fileCount: files.length,
          instructionsLength: instructions.length,
        });

        // Validate files
        this.validateFileTypes(files);
        const processedFiles = await this.prepareFilesForProcessing(files);

        const startTime = Date.now();
        
        // Execute through MCP server
        const result = await this.executeMCPCommand('multimodal_process', {
          files: processedFiles,
          instructions,
          options: {
            quality: 'high',
            includeMetadata: true,
          },
        });

        const processingTime = Date.now() - startTime;

        return {
          content: result.content || result.response || 'Processing completed',
          files_processed: files.map(f => f.path),
          processing_time: processingTime,
          tokens_used: this.estimateTokensUsed({ files, instructions }, result),
          model_used: 'gemini-2.5-pro',
        };
      },
      {
        maxAttempts: this.MAX_RETRIES,
        delay: 3000,
        operationName: 'process-multimodal',
      }
    );
  }

  /**
   * Convert PDF to Markdown
   */
  async convertPDFToMarkdown(pdfPath: string): Promise<string> {
    return retry(
      async () => {
        logger.debug('Converting PDF to Markdown', { pdfPath });

        const result = await this.executeMCPCommand('convert_pdf', {
          input: pdfPath,
          output_format: 'markdown',
          options: {
            preserve_formatting: true,
            extract_images: false,
          },
        });

        return result.content || result.markdown || '';
      },
      {
        maxAttempts: this.MAX_RETRIES,
        delay: 5000,
        operationName: 'convert-pdf-markdown',
      }
    );
  }

  /**
   * Analyze image
   */
  async analyzeImage(imagePath: string, analysisType: ImageAnalysisType): Promise<ImageAnalysisResult> {
    return retry(
      async () => {
        logger.debug('Analyzing image', { imagePath, analysisType });

        const result = await this.executeMCPCommand('analyze_image', {
          image: imagePath,
          analysis_type: analysisType,
          options: {
            detailed: analysisType === 'detailed',
            extract_text: analysisType === 'extract_text',
            technical: analysisType === 'technical',
          },
        });

        return {
          type: analysisType,
          description: result.description || 'Image analysis completed',
          extracted_text: result.extracted_text,
          technical_details: result.technical_details,
          confidence: result.confidence || 0.8,
        };
      },
      {
        maxAttempts: this.MAX_RETRIES,
        delay: 3000,
        operationName: 'analyze-image',
      }
    );
  }

  /**
   * Transcribe audio
   */
  async transcribeAudio(audioPath: string): Promise<string> {
    return retry(
      async () => {
        logger.debug('Transcribing audio', { audioPath });

        const result = await this.executeMCPCommand('transcribe_audio', {
          audio: audioPath,
          options: {
            language: 'auto',
            include_timestamps: false,
          },
        });

        return result.transcription || result.text || '';
      },
      {
        maxAttempts: this.MAX_RETRIES,
        delay: 5000,
        operationName: 'transcribe-audio',
      }
    );
  }

  /**
   * Get layer capabilities
   */
  getCapabilities(): string[] {
    return [
      'multimodal_processing',
      'document_analysis',
      'image_analysis',
      'audio_transcription',
      'pdf_conversion',
      'file_processing',
      'batch_processing',
      'content_extraction',
    ];
  }

  /**
   * Get cost estimation for a task
   */
  getCost(task: any): number {
    // AI Studio costs vary by usage, assuming API key usage
    const basePrice = 0.001; // $0.001 per request
    
    if (task.files && task.files.length > 0) {
      return basePrice * task.files.length;
    }
    
    return basePrice;
  }

  /**
   * Get estimated duration for a task
   */
  getEstimatedDuration(task: any): number {
    const baseTime = 5000; // 5 seconds base
    
    if (task.files && task.files.length > 0) {
      return baseTime + (task.files.length * 10000); // +10s per file
    }
    
    if (task.type === 'multimodal' || task.action === 'multimodal_processing') {
      return baseTime * 3; // Multimodal takes longer
    }
    
    return baseTime;
  }

  /**
   * Analyze documents
   */
  private async analyzeDocuments(files: FileReference[], instructions: string): Promise<string> {
    logger.debug('Analyzing documents', {
      fileCount: files.length,
      instructionsLength: instructions.length,
    });

    const result = await this.executeMCPCommand('analyze_documents', {
      documents: files.map(f => f.path),
      instructions,
      options: {
        extract_structure: true,
        summarize: true,
      },
    });

    return result.analysis || result.content || 'Document analysis completed';
  }

  /**
   * Convert files
   */
  private async convertFiles(files: FileReference[], outputFormat: string): Promise<any[]> {
    logger.debug('Converting files', {
      fileCount: files.length,
      outputFormat,
    });

    const results = [];
    
    for (const file of files) {
      const result = await this.executeMCPCommand('convert_file', {
        input: file.path,
        output_format: outputFormat,
        options: {
          preserve_quality: true,
        },
      });
      
      results.push({
        original: file.path,
        converted: result.output_path || result.content,
        format: outputFormat,
      });
    }

    return results;
  }

  /**
   * Process general AI Studio task
   */
  private async processGeneral(task: any): Promise<any> {
    const prompt = task.prompt || task.instructions || task.request || 'Please process this content.';
    
    return await this.executeMCPCommand('general_process', {
      prompt,
      files: task.files,
      options: task.options || {},
    });
  }

  /**
   * Execute MCP command
   */
  private async executeMCPCommand(command: string, params: any): Promise<any> {
    const timeout = this.DEFAULT_TIMEOUT;
    
    return new Promise<any>((resolve, reject) => {
      logger.debug('Executing MCP command', {
        command,
        hasParams: !!params,
        timeout,
      });

      // Use npx to run aistudio-mcp-server
      const child = spawn('npx', ['-y', 'aistudio-mcp-server', command, JSON.stringify(params)], {
        stdio: 'pipe',
        cwd: process.cwd(),
        env: {
          ...process.env,
          GEMINI_API_KEY: process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_STUDIO_API_KEY,
        },
      });

      let output = '';
      let errorOutput = '';

      const timeoutId = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`AI Studio MCP command timeout after ${timeout}ms`));
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
          try {
            const result = JSON.parse(output.trim() || '{}');
            logger.debug('MCP command completed successfully', {
              command,
              outputLength: output.length,
              code,
            });
            resolve(result);
          } catch (parseError) {
            // If JSON parsing fails, return raw output
            resolve({ content: output.trim() });
          }
        } else {
          const error = `AI Studio MCP command failed with code ${code}: ${errorOutput}`;
          logger.error('MCP command failed', { command, code, error: errorOutput });
          reject(new Error(error));
        }
      });

      child.on('error', (error) => {
        clearTimeout(timeoutId);
        logger.error('MCP command process error', { command, error: error.message });
        reject(error);
      });
    });
  }

  /**
   * Test MCP server connection
   */
  private async testMCPServerConnection(): Promise<void> {
    try {
      // Test with a simple command
      await this.executeMCPCommand('health_check', {});
      logger.debug('AI Studio MCP server connection test successful');
    } catch (error) {
      // Try alternative test
      try {
        const result = await this.executeMCPCommand('version', {});
        logger.debug('AI Studio MCP server available', { version: result.version });
      } catch (testError) {
        throw new Error(`AI Studio MCP server not available: ${(testError as Error).message}`);
      }
    }
  }

  /**
   * Validate file types
   */
  private validateFileTypes(files: (FileReference | MultimodalFile)[]): void {
    if (files.length > this.MAX_FILES) {
      throw new Error(`Too many files. Maximum ${this.MAX_FILES} files allowed.`);
    }

    for (const file of files) {
      const path = file.path;
      const size = file.size;

      if (size && size > this.MAX_FILE_SIZE) {
        throw new Error(`File ${path} is too large. Maximum ${this.MAX_FILE_SIZE / 1024 / 1024}MB allowed.`);
      }

      const ext = path.toLowerCase().match(/\.[^.]+$/)?.[0];
      if (ext) {
        const isSupported = Object.values(this.SUPPORTED_FILE_TYPES)
          .some(types => types.includes(ext));
        
        if (!isSupported) {
          logger.warn('Potentially unsupported file type', { 
            path, 
            extension: ext 
          });
        }
      }
    }
  }

  /**
   * Prepare files for processing
   */
  private async prepareFilesForProcessing(files: (FileReference | MultimodalFile)[]): Promise<any[]> {
    return files.map(file => {
      // Both types have path, so we can safely access it
      const fileData = {
        path: file.path,
        type: file.type,
        size: file.size,
      };
      
      // Check if this is a MultimodalFile (has content property)
      if ('content' in file && file.content !== undefined) {
        return {
          ...fileData,
          content: file.content,
          mimeType: file.type,
        };
      } else {
        return {
          ...fileData,
          encoding: 'encoding' in file ? file.encoding : 'utf-8',
        };
      }
    });
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
    const basePrice = 0.001;
    
    if (task.files && task.files.length > 0) {
      return basePrice * task.files.length;
    }
    
    return basePrice;
  }

  /**
   * Check if file type is supported
   */
  isFileTypeSupported(filePath: string): boolean {
    const ext = filePath.toLowerCase().match(/\.[^.]+$/)?.[0];
    if (!ext) return false;
    
    return Object.values(this.SUPPORTED_FILE_TYPES)
      .some(types => types.includes(ext));
  }

  /**
   * Get supported file types
   */
  getSupportedFileTypes(): typeof this.SUPPORTED_FILE_TYPES {
    return this.SUPPORTED_FILE_TYPES;
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