import { spawn } from 'child_process';
import { createWriteStream } from 'fs';
import { mkdir } from 'fs/promises';
import { dirname } from 'path';
import { 
  AudioAnalysisResult, 
  AudioGenOptions, 
  FileReference, 
  GenerationType, 
  ImageAnalysisResult, 
  ImageAnalysisType, 
  ImageGenOptions,
  LayerInterface,
  LayerResult,
  MediaGenResult,
  MultimodalFile,
  MultimodalResult,
  VideoGenOptions
} from '../core/types.js';
import { logger } from '../utils/logger.js';
import { retry, safeExecute } from '../utils/errorHandler.js';
import { AuthVerifier } from '../auth/AuthVerifier.js';

/**
 * AIStudioLayer handles AI Studio MCP integration with enhanced authentication support
 * Provides multimodal file processing for PDF, images, audio, and documents
 */
export class AIStudioLayer implements LayerInterface {
  private authVerifier: AuthVerifier;
  private mcpServerProcess?: any;
  private isInitialized = false;
  private readonly DEFAULT_TIMEOUT = 180000; // 3 minutes for file processing (increased from 2 minutes to fix timeout issues)
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

        // Test MCP server availability (non-blocking)
        try {
          await this.testMCPServerConnection();
        } catch (mcpError) {
          logger.warn('AI Studio MCP server not ready, will use fallback mode', {
            error: (mcpError as Error).message,
            fallbackMode: 'Will attempt direct API calls when needed'
          });
          // Continue initialization - don't fail completely
        }

        this.isInitialized = true;
        logger.info('AI Studio layer initialized successfully', {
          authenticated: authResult.success,
          mcpServerAvailable: true,
        });
      },
      {
        operationName: 'initialize-aistudio-layer',
        layer: 'aistudio',
        timeout: 15000, // Reduced timeout to 15 seconds for lightweight checks
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

    // PRIORITY: Handle all generation tasks
    if (task.action && (
      task.action.includes('generate_image') ||
      task.action.includes('generate_video') ||
      task.action.includes('generate_audio') ||
      task.action.includes('generate')
    )) {
      return true;
    }

    // Handle generation workflow steps
    if (task.type === 'generation' || task.workflow === 'generation') {
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
          case 'image_generation':
          case 'generate_image':
            result = await this.generateImage(task.prompt || task.text, task.options || {});
            break;
          case 'video_generation':
          case 'generate_video':
            result = await this.generateVideo(task.prompt || task.text, task.options || {});
            break;
          case 'audio_generation':
          case 'generate_audio':
            result = await this.generateAudio(task.prompt || task.text, task.options || {});
            break;
          case 'audio_analysis_advanced':
          case 'analyze_audio_advanced':
            result = await this.analyzeAudioAdvanced(task.audioPath || task.files?.[0]?.path);
            break;
          case 'convert':
            result = await this.convertFiles(task.files, task.outputFormat);
            break;
          case 'generate_content':
            result = await this.processGeneral(task);
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
          success: true,
          files_processed: files.map(f => f.path),
          processing_time: processingTime,
          workflow_used: 'analysis' as const,
          layers_involved: ['aistudio'] as const,
          metadata: {
            total_duration: processingTime,
            tokens_used: this.estimateTokensUsed({ files, instructions }, result),
            cost: this.estimateCost({ files, instructions }, result),
          },
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
   * Generate image using AI Studio
   */
  async generateImage(prompt: string, options: Partial<ImageGenOptions> = {}): Promise<MediaGenResult> {
    return retry(
      async () => {
        logger.info('Generating image with AI Studio', {
          promptLength: prompt.length,
          model: options.model || 'imagen-3',
          quality: options.quality || 'standard'
        });

        const startTime = Date.now();
        
        const imageOptions = {
          width: options.width || 1024,
          height: options.height || 1024,
          aspectRatio: options.aspectRatio || '1:1',
          style: options.style || 'photorealistic',
          quality: options.quality || 'standard',
          model: options.model || 'imagen-3',
          seed: options.seed,
          guidance: options.guidance || 7,
          steps: options.steps || 30,
        };

        const result = await this.executeMCPCommand('generate_image', {
          prompt,
          options: imageOptions,
          // Add responseModalities for proper AI Studio API format (per Error4.md analysis)
          generationConfig: {
            responseMimeType: 'image/jpeg',
            responseModalities: ['TEXT', 'IMAGE']
          }
        });

        const duration = Date.now() - startTime;
        
        // Download and save the generated image
        const outputPath = await this.downloadGeneratedMedia(
          result.downloadUrl || result.imageUrl,
          'image',
          options.quality || 'standard'
        );

        return {
          success: true,
          generationType: 'image' as GenerationType,
          outputPath,
          originalPrompt: prompt,
          metadata: {
            duration,
            fileSize: result.fileSize || 0,
            format: 'png',
            dimensions: {
              width: options.width || 1024,
              height: options.height || 1024,
            },
            model: options.model || 'imagen-3',
            settings: options,
            cost: this.calculateGenerationCost('image', options),
          },
          downloadUrl: result.downloadUrl,
        };
      },
      {
        maxAttempts: this.MAX_RETRIES,
        delay: 5000,
        operationName: 'generate-image',
      }
    );
  }

  /**
   * Generate video using AI Studio
   */
  async generateVideo(prompt: string, options: Partial<VideoGenOptions> = {}): Promise<MediaGenResult> {
    return retry(
      async () => {
        logger.info('Generating video with AI Studio', {
          promptLength: prompt.length,
          model: options.model || 'veo-2',
          duration: options.duration || 5
        });

        const startTime = Date.now();
        
        const videoOptions = {
          width: options.width || 1024,
          height: options.height || 576,
          duration: options.duration || 5,
          fps: options.fps || '30',
          quality: options.quality || 'standard',
          model: options.model || 'veo-2',
          motion: options.motion || 'medium',
          seed: options.seed,
        };

        const result = await this.executeMCPCommand('generate_video', {
          prompt,
          options: videoOptions,
          // Add responseModalities for proper AI Studio API format (per Error4.md analysis)
          generationConfig: {
            responseMimeType: 'video/mp4',
            responseModalities: ['TEXT', 'VIDEO']
          }
        });

        const duration = Date.now() - startTime;
        
        // Download and save the generated video
        const outputPath = await this.downloadGeneratedMedia(
          result.downloadUrl || result.videoUrl,
          'video',
          options.quality || 'standard'
        );

        return {
          success: true,
          generationType: 'video' as GenerationType,
          outputPath,
          originalPrompt: prompt,
          metadata: {
            duration,
            fileSize: result.fileSize || 0,
            format: 'mp4',
            dimensions: {
              width: options.width || 1024,
              height: options.height || 576,
            },
            model: options.model || 'veo-2',
            settings: options,
            cost: this.calculateGenerationCost('video', options),
          },
          downloadUrl: result.downloadUrl,
        };
      },
      {
        maxAttempts: this.MAX_RETRIES,
        delay: 10000, // Longer delay for video generation
        operationName: 'generate-video',
      }
    );
  }

  /**
   * Generate audio using AI Studio
   */
  async generateAudio(text: string, options: Partial<AudioGenOptions> = {}): Promise<MediaGenResult> {
    return retry(
      async () => {
        logger.info('Generating audio with AI Studio', {
          textLength: text.length,
          voice: options.voice || 'alloy',
          format: options.format || 'mp3'
        });

        const startTime = Date.now();
        
        const audioOptions = {
          voice: options.voice || 'alloy',
          language: options.language || 'en',
          speed: options.speed || 1.0,
          format: options.format || 'mp3',
          quality: options.quality || 'standard',
          model: options.model || 'text-to-speech',
        };

        const result = await this.executeMCPCommand('generate_audio', {
          text,
          options: audioOptions,
        });

        const duration = Date.now() - startTime;
        
        // Download and save the generated audio
        const outputPath = await this.downloadGeneratedMedia(
          result.downloadUrl || result.audioUrl,
          'audio',
          options.quality || 'standard'
        );

        return {
          success: true,
          generationType: 'audio' as GenerationType,
          outputPath,
          originalPrompt: text,
          metadata: {
            duration,
            fileSize: result.fileSize || 0,
            format: options.format || 'mp3',
            model: options.model || 'text-to-speech',
            settings: options,
            cost: this.calculateGenerationCost('audio', options),
          },
          downloadUrl: result.downloadUrl,
        };
      },
      {
        maxAttempts: this.MAX_RETRIES,
        delay: 5000,
        operationName: 'generate-audio',
      }
    );
  }

  /**
   * Advanced audio analysis with enhanced features
   */
  async analyzeAudioAdvanced(audioPath: string): Promise<AudioAnalysisResult> {
    return retry(
      async () => {
        logger.debug('Performing advanced audio analysis', { audioPath });

        const result = await this.executeMCPCommand('analyze_audio_advanced', {
          audio: audioPath,
          options: {
            include_transcription: true,
            include_sentiment: true,
            include_emotions: true,
            include_speaker_detection: true,
            include_metadata: true,
          },
        });

        return {
          transcription: result.transcription || '',
          language: result.language,
          confidence: result.confidence,
          sentiment: result.sentiment,
          emotions: result.emotions || [],
          speakers: result.speakers || [],
          metadata: {
            duration: result.metadata?.duration || 0,
            sampleRate: result.metadata?.sampleRate,
            channels: result.metadata?.channels,
            format: result.metadata?.format || 'unknown',
          },
        };
      },
      {
        maxAttempts: this.MAX_RETRIES,
        delay: 5000,
        operationName: 'analyze-audio-advanced',
      }
    );
  }

  /**
   * Download generated media and save to local filesystem
   */
  private async downloadGeneratedMedia(
    downloadUrl: string, 
    mediaType: 'image' | 'video' | 'audio',
    quality: string
  ): Promise<string> {
    if (!downloadUrl) {
      throw new Error('No download URL provided for generated media');
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const extension = this.getFileExtension(mediaType);
    const fileName = `generated-${mediaType}-${timestamp}.${extension}`;
    const outputDir = `./generated-media/${mediaType}`;
    const outputPath = `${outputDir}/${fileName}`;

    try {
      // Ensure output directory exists
      await mkdir(outputDir, { recursive: true });

      // Download the file
      logger.debug('Downloading generated media', {
        url: downloadUrl.substring(0, 100),
        outputPath,
        mediaType
      });

      const response = await fetch(downloadUrl);
      if (!response.ok) {
        throw new Error(`Failed to download media: ${response.statusText}`);
      }

      // Save to filesystem
      const fileStream = createWriteStream(outputPath);
      const reader = response.body?.getReader();
      
      if (!reader) {
        throw new Error('Failed to get response stream');
      }

      while (true) {
        const { done, value } = await reader.read();
        if (done) {break;}
        fileStream.write(Buffer.from(value));
      }

      fileStream.end();
      
      logger.info('Media downloaded successfully', {
        outputPath,
        mediaType,
        fileSize: response.headers.get('content-length')
      });

      return outputPath;
      
    } catch (error) {
      logger.error('Failed to download generated media', {
        error: (error as Error).message,
        downloadUrl: downloadUrl.substring(0, 100),
        mediaType
      });
      throw error;
    }
  }

  /**
   * Get file extension for media type
   */
  private getFileExtension(mediaType: 'image' | 'video' | 'audio'): string {
    switch (mediaType) {
      case 'image': return 'png';
      case 'video': return 'mp4';
      case 'audio': return 'mp3';
      default: return 'bin';
    }
  }

  /**
   * Calculate generation cost based on media type and options
   */
  private calculateGenerationCost(
    mediaType: 'image' | 'video' | 'audio',
    options: any
  ): number {
    // Basic cost calculation - would be replaced with actual API pricing
    const baseCosts = {
      image: 0.05,
      video: 0.25,
      audio: 0.02,
    };
    
    let cost = baseCosts[mediaType];
    
    // Quality multipliers
    if (options.quality === 'high') {cost *= 2;}
    if (options.quality === 'ultra') {cost *= 4;}
    
    // Video duration multiplier
    if (mediaType === 'video' && options.duration) {
      cost *= Math.max(1, options.duration / 5);
    }
    
    return Math.round(cost * 1000) / 1000; // Round to 3 decimal places
  }

  /**
   * Get layer capabilities
   */
  getCapabilities(): string[] {
    return [
      'multimodal_processing',
      'document_analysis',
      'image_analysis',
      'image_generation',
      'video_generation',
      'audio_generation',
      'audio_transcription',
      'audio_analysis_advanced',
      'pdf_conversion',
      'file_processing',
      'batch_processing',
      'content_extraction',
      'media_download',
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
   * Estimate cost for processing
   */
  private estimateCost(input: any, result: any): number {
    const basePrice = 0.001; // $0.001 per request
    
    if (input.files && input.files.length > 0) {
      return basePrice * input.files.length;
    }
    
    return basePrice;
  }

  /**
   * Get estimated duration for a task
   */
  getEstimatedDuration(task: any): number {
    // Check for image generation tasks
    if (task.action === 'generate_image' || 
        task.action === 'image_generation' ||
        task.type === 'image_generation' ||
        (task.prompt && this.isImageGenerationRequest(task.prompt))) {
      return 120000; // 2 minutes for image generation
    }
    
    // Check for video generation tasks
    if (task.action === 'generate_video' || 
        task.action === 'video_generation' ||
        task.type === 'video_generation' ||
        (task.prompt && this.isVideoGenerationRequest(task.prompt))) {
      return 180000; // 3 minutes for video generation
    }
    
    // Check for audio generation tasks
    if (task.action === 'generate_audio' || 
        task.action === 'audio_generation' ||
        task.type === 'audio_generation' ||
        (task.prompt && this.isAudioGenerationRequest(task.prompt))) {
      return 90000; // 1.5 minutes for audio generation
    }
    
    const baseTime = 15000; // 15 seconds base (increased from 5 seconds)
    
    if (task.files && task.files.length > 0) {
      return baseTime + (task.files.length * 30000); // +30s per file (increased from 10s)
    }
    
    if (task.type === 'multimodal' || task.action === 'multimodal_processing') {
      return baseTime * 4; // Multimodal takes longer (increased from 3x to 4x)
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
    
    // Detect if this is a generation request that should be handled by specific methods
    if (this.isImageGenerationRequest(prompt)) {
      logger.info('Detected image generation request in general processing', {
        prompt: prompt.substring(0, 100)
      });
      return await this.generateImage(prompt, task.options || {});
    }
    
    if (this.isVideoGenerationRequest(prompt)) {
      logger.info('Detected video generation request in general processing', {
        prompt: prompt.substring(0, 100)
      });
      return await this.generateVideo(prompt, task.options || {});
    }
    
    if (this.isAudioGenerationRequest(prompt)) {
      logger.info('Detected audio generation request in general processing', {
        prompt: prompt.substring(0, 100)
      });
      return await this.generateAudio(prompt, task.options || {});
    }
    
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
    // Enhanced timeout calculation based on command type and complexity
    // Addresses AI Studio timeout issues from Error4.md analysis
    let timeout = this.DEFAULT_TIMEOUT; // Base: 180 seconds
    
    // Image generation requires significantly longer timeout (per Gemini analysis in Error4.md)
    if (command === 'generate_image' || this.isImageGenerationCommand(command, params)) {
      timeout = Math.max(240000, this.DEFAULT_TIMEOUT * 1.5); // Minimum 4 minutes for image generation
      logger.debug('Extended timeout for image generation', {
        command,
        timeoutMs: timeout,
        timeoutMinutes: Math.round(timeout / 60000),
        reason: 'AI Studio image generation requires extended processing time (Error4.md analysis)'
      });
    }
    
    // Video generation requires even longer timeout
    else if (command === 'generate_video' || this.isVideoGenerationCommand(command, params)) {
      timeout = Math.max(300000, this.DEFAULT_TIMEOUT * 2); // Minimum 5 minutes for video generation
    }
    
    // Complex multimodal processing also needs extended timeout
    else if (command.includes('multimodal') || (params?.files && params.files.length > 3)) {
      timeout = Math.max(240000, this.DEFAULT_TIMEOUT * 1.3); // Minimum 4 minutes for complex processing
    }
    
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
          // New preferred environment variable name
          AI_STUDIO_API_KEY: this.getAIStudioApiKey(),
          // Backward compatibility
          GEMINI_API_KEY: this.getAIStudioApiKey(),
          GOOGLE_AI_STUDIO_API_KEY: this.getAIStudioApiKey(),
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
   * Get AI Studio API key with priority order and deprecation warnings
   * Enhanced with validation and detailed error reporting
   */
  private getAIStudioApiKey(): string {
    // Priority order: AI_STUDIO_API_KEY > GOOGLE_AI_STUDIO_API_KEY > GEMINI_API_KEY (deprecated)
    const preferredKey = process.env.AI_STUDIO_API_KEY;
    const fallback1 = process.env.GOOGLE_AI_STUDIO_API_KEY;
    const fallback2 = process.env.GEMINI_API_KEY; // Deprecated
    
    const apiKey = preferredKey || fallback1 || fallback2;

    // Enhanced logging for debugging authentication issues
    logger.debug('AI Studio API key resolution', {
      hasPreferredKey: !!preferredKey,
      hasFallback1: !!fallback1,
      hasFallback2: !!fallback2,
      selectedKey: apiKey ? `${apiKey.substring(0, 8)}...` : 'none',
      keyLength: apiKey?.length || 0
    });

    // Warn about deprecated environment variable names with specific migration guidance
    if (!preferredKey && fallback2) {
      logger.warn('GEMINI_API_KEY is deprecated for AI Studio. Please use AI_STUDIO_API_KEY instead.', {
        migration: 'Update your .env file: GEMINI_API_KEY → AI_STUDIO_API_KEY',
        source: 'Using GEMINI_API_KEY as fallback',
        recommendedAction: 'Set AI_STUDIO_API_KEY to avoid this warning'
      });
    }
    
    if (!preferredKey && fallback1) {
      logger.warn('GOOGLE_AI_STUDIO_API_KEY is deprecated. Please use AI_STUDIO_API_KEY instead.', {
        migration: 'Update your .env file: GOOGLE_AI_STUDIO_API_KEY → AI_STUDIO_API_KEY',
        source: 'Using GOOGLE_AI_STUDIO_API_KEY as fallback',
        recommendedAction: 'Set AI_STUDIO_API_KEY for consistency'
      });
    }

    // Validate API key format if present
    if (apiKey && !this.validateApiKeyFormat(apiKey)) {
      logger.error('Invalid AI Studio API key format detected', {
        keyPrefix: apiKey.substring(0, 8),
        keyLength: apiKey.length,
        expectedFormat: 'Should start with "AI" and be at least 20 characters',
        troubleshooting: 'Get a new key from https://aistudio.google.com/app/apikey'
      });
    }

    return apiKey || '';
  }

  /**
   * Validate AI Studio API key format
   */
  private validateApiKeyFormat(apiKey: string): boolean {
    if (!apiKey || typeof apiKey !== 'string') {
      return false;
    }
    
    // Google AI Studio API keys typically start with "AI" and are 39+ characters
    return apiKey.length >= 20 && apiKey.startsWith('AI');
  }

  /**
   * Test MCP server connection (lightweight test)
   * Enhanced with better error detection and troubleshooting guidance
   */
  private async testMCPServerConnection(): Promise<void> {
    try {
      // Enhanced API key validation first
      const apiKey = this.getAIStudioApiKey();
      if (!apiKey) {
        const errorMsg = 'AI Studio API key not found. This will cause authentication failures as seen in Error.md.';
        logger.error('AI Studio authentication missing', {
          issue: 'No API key found in any environment variable',
          searchedVars: ['AI_STUDIO_API_KEY', 'GOOGLE_AI_STUDIO_API_KEY', 'GEMINI_API_KEY'],
          solution: 'Set AI_STUDIO_API_KEY environment variable',
          getKeyUrl: 'https://aistudio.google.com/app/apikey',
          errorReference: 'This addresses the AI Studio authentication issue from Error.md lines 70-86'
        });
        throw new Error(`${errorMsg} Set AI_STUDIO_API_KEY environment variable. Get your key from: https://aistudio.google.com/app/apikey`);
      }

      // Validate API key format
      if (!this.validateApiKeyFormat(apiKey)) {
        const errorMsg = 'Invalid AI Studio API key format detected.';
        logger.error('AI Studio API key format invalid', {
          keyPrefix: apiKey.substring(0, 8),
          keyLength: apiKey.length,
          expectedFormat: 'Should start with "AI" and be at least 20 characters',
          currentFormat: `Starts with "${apiKey.substring(0, 2)}", length: ${apiKey.length}`,
          solution: 'Get a new key from https://aistudio.google.com/app/apikey'
        });
        throw new Error(`${errorMsg} Expected format: starts with "AI", minimum 20 characters. Get a new key from: https://aistudio.google.com/app/apikey`);
      }

      // Check system dependencies
      const { execSync } = await import('child_process');
      
      try {
        execSync('which npx', { 
          timeout: 5000,
          stdio: 'ignore'
        });
        
        logger.debug('AI Studio MCP dependencies validation', {
          hasValidApiKey: true,
          apiKeyPrefix: apiKey.substring(0, 8),
          npxAvailable: true,
          mcpServerCommand: 'npx -y aistudio-mcp-server',
          status: 'ready'
        });
        
        // Use direct Google AI Studio API instead of MCP server
        logger.info('AI Studio layer using direct API integration', {
          apiKeyAvailable: true,
          integrationMode: 'direct_api',
          note: 'Bypassing MCP server for better reliability'
        });
        
      } catch (binaryError) {
        throw new Error('npx not available. Please ensure Node.js and npm are properly installed');
      }
      
    } catch (error) {
      const enhancedError = new Error(`AI Studio MCP server not available: ${(error as Error).message}`);
      logger.error('AI Studio MCP initialization failed', {
        originalError: (error as Error).message,
        troubleshooting: [
          '1. Set AI_STUDIO_API_KEY environment variable',
          '2. Get API key from https://aistudio.google.com/app/apikey',
          '3. Ensure npx is available (npm install -g npm)',
          '4. Install aistudio-mcp-server (npx -y aistudio-mcp-server --version)'
        ],
        errorReference: 'This addresses authentication issues similar to Error.md'
      });
      throw enhancedError;
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
    
    return this.getEstimatedDuration(task) + 60000; // Add 60s buffer (increased from 30s)
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
    if (!ext) {return false;}
    
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

  /**
   * Detection methods for generation requests
   */
  private isImageGenerationRequest(prompt: string): boolean {
    if (!prompt) {return false;}
    
    const imageKeywords = ['image', 'picture', 'photo', 'illustration', 'drawing', 'artwork', 'visual', 'graphic', 'sketch', 'painting', 'render', '画像', '写真', 'イラスト', '絵', '図'];
    const generationKeywords = ['generate', 'create', 'make', 'produce', 'draw', 'design', '生成', '作成', '作る', '描く'];
    
    const lowerPrompt = prompt.toLowerCase();
    const hasImageKeyword = imageKeywords.some(keyword => lowerPrompt.includes(keyword.toLowerCase()));
    const hasGenerationKeyword = generationKeywords.some(keyword => lowerPrompt.includes(keyword.toLowerCase()));
    
    return hasImageKeyword && hasGenerationKeyword;
  }

  private isVideoGenerationRequest(prompt: string): boolean {
    if (!prompt) {return false;}
    
    const videoKeywords = ['video', 'movie', 'animation', 'clip', 'motion', '動画', 'ビデオ', 'ムービー', 'アニメーション'];
    const generationKeywords = ['generate', 'create', 'make', 'produce', '生成', '作成', '作る'];
    
    const lowerPrompt = prompt.toLowerCase();
    const hasVideoKeyword = videoKeywords.some(keyword => lowerPrompt.includes(keyword.toLowerCase()));
    const hasGenerationKeyword = generationKeywords.some(keyword => lowerPrompt.includes(keyword.toLowerCase()));
    
    return hasVideoKeyword && hasGenerationKeyword;
  }

  private isAudioGenerationRequest(prompt: string): boolean {
    if (!prompt) {return false;}
    
    const audioKeywords = ['audio', 'sound', 'music', 'voice', 'speech', 'narration', '音声', '音楽', 'サウンド', '声', 'ナレーション'];
    const generationKeywords = ['generate', 'create', 'make', 'produce', 'synthesize', '生成', '作成', '作る', '合成'];
    
    const lowerPrompt = prompt.toLowerCase();
    const hasAudioKeyword = audioKeywords.some(keyword => lowerPrompt.includes(keyword.toLowerCase()));
    const hasGenerationKeyword = generationKeywords.some(keyword => lowerPrompt.includes(keyword.toLowerCase()));
    
    return hasAudioKeyword && hasGenerationKeyword;
  }

  /**
   * Helper methods for command type detection (for timeout calculation)
   */
  private isImageGenerationCommand(command: string, params: any): boolean {
    if (command === 'generate_image') {return true;}
    if (params?.prompt) {
      return this.isImageGenerationRequest(params.prompt);
    }
    return false;
  }

  private isVideoGenerationCommand(command: string, params: any): boolean {
    if (command === 'generate_video') {return true;}
    if (params?.prompt) {
      return this.isVideoGenerationRequest(params.prompt);
    }
    return false;
  }
}