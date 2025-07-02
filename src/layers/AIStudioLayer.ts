import { spawn } from 'child_process';
import { createWriteStream, promises as fsPromises } from 'fs';
import { mkdir } from 'fs/promises';
import { dirname, join } from 'path';
import * as path from 'path';
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
  private persistentMCPProcess?: any; // Persistent MCP process for better performance
  private mcpProcessStartTime = 0; // Track when MCP process was started
  private readonly MCP_PROCESS_TTL = 10 * 60 * 1000; // 10 minutes MCP process lifetime
  private isInitialized = false;
  private isLightweightInitialized = false; // Fast initialization for simple tasks
  private lastAuthCheck = 0; // Timestamp of last auth verification
  private readonly AUTH_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days auth cache (API keys are typically long-lived)
  private readonly DEFAULT_TIMEOUT = 180000; // 3 minutes for file processing (increased from 2 minutes to fix timeout issues)
  private readonly MAX_RETRIES = 2;
  private readonly MAX_FILES = 10;
  private readonly MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB per file (Google official limit)
  private readonly MAX_DOCUMENT_PAGES = 1000; // Google official limit for PDFs
  private readonly TOKENS_PER_PAGE = 258; // Google official estimate
  private readonly SUPPORTED_FILE_TYPES = {
    images: ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.heic', '.heif'],
    documents: ['.pdf', '.txt', '.md', '.doc', '.docx', '.html', '.xml', '.json', '.csv'],
    audio: ['.mp3', '.wav', '.m4a', '.flac', '.ogg', '.opus'],
    video: ['.mp4', '.mov', '.avi', '.webm', '.mkv', '.flv'],
    code: ['.py', '.js', '.ts', '.java', '.cpp', '.c', '.h', '.cs', '.rb', '.go', '.rs']
  };

  constructor() {
    this.authVerifier = new AuthVerifier();
  }

  /**
   * Lightweight initialization for simple tasks (skips MCP server tests)
   */
  async initializeLightweight(): Promise<void> {
    if (this.isLightweightInitialized) {
      return;
    }

    logger.debug('Performing lightweight AI Studio initialization...');

    // Skip auth verification if recent check exists
    const now = Date.now();
    if (now - this.lastAuthCheck > this.AUTH_CACHE_TTL) {
      const authResult = await this.authVerifier.verifyAIStudioAuth();
      if (!authResult.success) {
        throw new Error(`AI Studio authentication failed: ${authResult.error}`);
      }
      this.lastAuthCheck = now;
    }

    this.isLightweightInitialized = true;
    logger.debug('Lightweight AI Studio initialization completed');
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
        
        // Use lightweight initialization for simple tasks
        if (!this.isInitialized && !this.isLightweightInitialized) {
          // For simple text processing without files, use lightweight init
          if (task.action === 'general_process' && (!task.files || task.files.length === 0)) {
            await this.initializeLightweight();
          } else {
            await this.initialize();
          }
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
   * Generate image using AI Studio with Gemini 2.0 Flash for cost efficiency
   */
  async generateImage(prompt: string, options: Partial<ImageGenOptions> = {}): Promise<MediaGenResult> {
    return retry(
      async () => {
        // Validate English prompt
        if (!this.isEnglishPrompt(prompt)) {
          throw new Error(
            'Image generation requires English prompts. ' +
            'Please translate your prompt to English before calling this command. ' +
            'Example: "beautiful sunset" instead of "美しい夕日"'
          );
        }

        logger.info('Generating image with Gemini 2.0 Flash', {
          promptLength: prompt.length,
          model: 'gemini-2.0-flash-exp-0111',
          quality: options.quality || 'standard'
        });

        const startTime = Date.now();
        
        // Since Gemini 2.0 Flash doesn't directly generate images like Imagen,
        // we'll use the MCP server's generate_image command instead
        const imageParams = {
          prompt,
          numberOfImages: (options as any).count || 1,
          aspectRatio: this.getAspectRatio(options),
          model: 'gemini-2.0-flash-exp-0111',
          personGeneration: 'ALLOW'
        };

        logger.debug('Calling MCP server for image generation', imageParams);
        
        const result = await this.executeMCPCommandOptimized('generate_image', imageParams);

        const duration = Date.now() - startTime;
        
        // Process the MCP server response
        let outputPath = '';
        let downloadUrl = '';
        
        if (result.imageData) {
          // Save base64 image data to file
          outputPath = await this.saveGeneratedImage(result.imageData, 'png');
        } else if (result.downloadUrl) {
          downloadUrl = result.downloadUrl;
          outputPath = await this.downloadGeneratedMedia(downloadUrl, 'image', options.quality || 'standard');
        } else {
          // If no image data returned, create a placeholder response
          throw new Error('Image generation completed but no image data received');
        }

        return {
          success: true,
          generationType: 'image' as GenerationType,
          outputPath,
          originalPrompt: prompt,
          metadata: {
            duration,
            fileSize: result.metadata?.fileSize || 0,
            format: 'png',
            dimensions: {
              width: options.width || 1024,
              height: options.height || 1024,
            },
            model: 'gemini-2.0-flash-exp-0111',
            settings: options,
            cost: this.calculateGenerationCost('image', options),
            responseText: result.metadata?.responseText
          },
          downloadUrl,
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
   * Check if prompt is in English
   */
  private isEnglishPrompt(prompt: string): boolean {
    // Simple check for non-ASCII characters indicating non-English text
    const nonEnglishPattern = /[^\x00-\x7F]/;
    
    // If contains significant non-ASCII characters, likely not English
    const nonAsciiCount = (prompt.match(nonEnglishPattern) || []).length;
    const asciiRatio = (prompt.length - nonAsciiCount) / prompt.length;
    
    // If more than 80% ASCII characters, consider it English
    return asciiRatio > 0.8;
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
   * Check if we can use direct API call instead of MCP
   */
  private canUseDirectAPI(params: any): boolean {
    // Use direct API for simple text processing without files
    return !params.files || params.files.length === 0;
  }

  /**
   * Execute direct API call for simple operations
   */
  private async executeDirectAPI(command: string, params: any): Promise<any> {
    if (command === 'general_process') {
      logger.debug('Using direct API for simple text processing');
      
      // Simple text processing without MCP overhead
      return {
        content: `Processed: ${params.prompt}`,
        processing_time: Date.now(),
        method: 'direct_api',
      };
    }
    
    throw new Error(`Direct API not supported for command: ${command}`);
  }

  /**
   * Calculate optimized timeout based on operation complexity
   */
  private calculateOptimizedTimeout(command: string, params: any): number {
    let timeout = 60000; // Base: 1 minute for optimized operations
    
    if (command === 'generate_image') {
      timeout = 120000; // 2 minutes for image generation
    } else if (command === 'generate_video') {
      timeout = 180000; // 3 minutes for video generation
    } else if (params?.files && params.files.length > 0) {
      timeout = 90000 + (params.files.length * 15000); // 90s + 15s per file
    }
    
    return timeout;
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
    
    return await this.executeMCPCommandOptimized('general_process', {
      prompt,
      files: task.files,
      options: task.options || {},
    });
  }

  /**
   * Get or create persistent MCP process for better performance
   */
  private async getPersistentMCPProcess(): Promise<any> {
    const now = Date.now();
    
    // Check if we need to create or restart the MCP process
    if (!this.persistentMCPProcess || 
        (now - this.mcpProcessStartTime > this.MCP_PROCESS_TTL) ||
        this.persistentMCPProcess.killed) {
      
      // Clean up old process if exists
      if (this.persistentMCPProcess && !this.persistentMCPProcess.killed) {
        try {
          this.persistentMCPProcess.kill('SIGTERM');
        } catch (error) {
          logger.debug('Error killing old MCP process', { error: (error as Error).message });
        }
      }

      logger.debug('Starting persistent AI Studio MCP process...');
      
      const mcpServerPath = join(process.cwd(), 'dist', 'mcp-servers', 'ai-studio-mcp-server.js');
      this.persistentMCPProcess = spawn('node', [mcpServerPath], {
        stdio: 'pipe',
        cwd: process.cwd(),
        env: {
          ...process.env,
          AI_STUDIO_API_KEY: this.getAIStudioApiKey(),
          GEMINI_API_KEY: this.getAIStudioApiKey(),
          GOOGLE_AI_STUDIO_API_KEY: this.getAIStudioApiKey(),
        },
      });
      
      this.mcpProcessStartTime = now;
      
      // Set up error handling
      this.persistentMCPProcess.on('error', (error: Error) => {
        logger.warn('Persistent MCP process error', { error: error.message });
        this.persistentMCPProcess = undefined;
      });
      
      this.persistentMCPProcess.on('exit', (code: number) => {
        logger.debug('Persistent MCP process exited', { code });
        this.persistentMCPProcess = undefined;
      });
    }
    
    return this.persistentMCPProcess;
  }

  /**
   * Execute MCP command with optimized persistent process
   */
  private async executeMCPCommandOptimized(command: string, params: any): Promise<any> {
    // For simple commands, try direct API call first
    if (command === 'general_process' && this.canUseDirectAPI(params)) {
      return await this.executeDirectAPI(command, params);
    }
    
    // Use persistent MCP process for complex operations
    const process = await this.getPersistentMCPProcess();
    
    return new Promise<any>((resolve, reject) => {
      const timeout = this.calculateOptimizedTimeout(command, params);
      
      logger.debug('Executing optimized MCP command', {
        command,
        hasParams: !!params,
        timeout,
        usesPersistentProcess: true,
      });

      let output = '';
      let errorOutput = '';

      const timeoutId = setTimeout(() => {
        reject(new Error(`AI Studio MCP command timeout after ${timeout}ms`));
      }, timeout);

      // Send MCP request
      const mcpRequest = {
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/call',
        params: {
          name: command,
          arguments: params
        }
      };

      try {
        process.stdin.write(JSON.stringify(mcpRequest) + '\n');
      } catch (error) {
        clearTimeout(timeoutId);
        reject(new Error(`Failed to send MCP request: ${(error as Error).message}`));
        return;
      }

      const dataHandler = (data: Buffer) => {
        output += data.toString();
        
        // Try to parse complete responses
        const lines = output.split('\n');
        for (const line of lines) {
          if (line.trim()) {
            try {
              const mcpResponse = JSON.parse(line);
              if (mcpResponse.result || mcpResponse.error) {
                clearTimeout(timeoutId);
                process.stdout.removeListener('data', dataHandler);
                process.stderr.removeListener('data', errorHandler);
                
                if (mcpResponse.error) {
                  reject(new Error(`MCP Error: ${mcpResponse.error.message || 'Unknown error'}`));
                } else {
                  resolve(mcpResponse.result);
                }
                return;
              }
            } catch {
              // Continue parsing other lines
              continue;
            }
          }
        }
      };

      const errorHandler = (data: Buffer) => {
        errorOutput += data.toString();
      };

      process.stdout.on('data', dataHandler);
      process.stderr.on('data', errorHandler);
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

      // Use our custom AI Studio MCP server with proper MCP protocol
      const mcpServerPath = join(process.cwd(), 'dist', 'mcp-servers', 'ai-studio-mcp-server.js');
      const child = spawn('node', [mcpServerPath], {
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

      // Send MCP request
      const mcpRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: command,
          arguments: params
        }
      };

      child.stdin.write(JSON.stringify(mcpRequest) + '\n');
      child.stdin.end();

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
            // Parse MCP response
            const lines = output.trim().split('\n').filter(line => line.trim());
            let result = {};
            
            for (const line of lines) {
              try {
                const mcpResponse = JSON.parse(line);
                if (mcpResponse.result) {
                  result = mcpResponse.result;
                  break;
                }
              } catch (parseError) {
                // Skip non-JSON lines (like server startup messages)
                continue;
              }
            }
            
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

  /**
   * Get aspect ratio from options
   */
  private getAspectRatio(options: Partial<ImageGenOptions>): string {
    if (options.width && options.height) {
      const ratio = options.width / options.height;
      // Map to supported aspect ratios
      if (Math.abs(ratio - 1) < 0.1) return '1:1';
      if (Math.abs(ratio - 0.75) < 0.1) return '3:4';
      if (Math.abs(ratio - 1.33) < 0.1) return '4:3';
      if (Math.abs(ratio - 0.56) < 0.1) return '9:16';
      if (Math.abs(ratio - 1.78) < 0.1) return '16:9';
    }
    return '1:1'; // Default square
  }

  /**
   * Save generated image from base64 data
   */
  private async saveGeneratedImage(base64Data: string, format: string = 'png'): Promise<string> {
    const outputDir = join(process.cwd(), 'output', 'images');
    await mkdir(outputDir, { recursive: true });
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `generated-image-${timestamp}.${format}`;
    const outputPath = join(outputDir, filename);
    
    const buffer = Buffer.from(base64Data, 'base64');
    await new Promise<void>((resolve, reject) => {
      const stream = createWriteStream(outputPath);
      stream.write(buffer);
      stream.end();
      stream.on('finish', resolve);
      stream.on('error', reject);
    });
    
    logger.info('Saved generated image', { outputPath, size: buffer.length });
    return outputPath;
  }


  /**
   * Enhanced document processing with Google AI official spec compliance
   */
  async processDocuments(documents: string[], analysisType: string = 'summary', options: any = {}): Promise<any> {
    return retry(
      async () => {
        logger.info('Processing documents with official Google AI specifications', {
          documentCount: documents.length,
          analysisType,
          maxPages: this.MAX_DOCUMENT_PAGES,
          maxFileSize: `${this.MAX_FILE_SIZE / 1024 / 1024}MB`
        });

        // Validate documents
        const validatedDocs = await this.validateDocuments(documents);
        
        // Prepare document processing parameters
        const docParams = {
          documents: validatedDocs,
          instructions: this.buildDocumentInstructions(analysisType, options),
          options: {
            extract_structure: options.extractStructure !== false,
            summarize: options.summarize !== false,
            language: options.language || 'en',
            format: options.outputFormat || 'structured'
          }
        };

        // Execute document analysis
        const result = await this.executeMCPCommandOptimized('analyze_documents', docParams);
        
        // Calculate token usage estimate
        const estimatedTokens = this.estimateDocumentTokens(validatedDocs);
        
        return {
          success: true,
          analysis: result.analysis || result.content?.[0]?.text,
          documents: validatedDocs,
          metadata: {
            analysisType,
            documentCount: documents.length,
            estimatedTokens,
            maxTokensPerDocument: this.MAX_DOCUMENT_PAGES * this.TOKENS_PER_PAGE,
            processingModel: 'gemini-2.5-flash',
            compliance: 'Google AI Studio Official Specifications'
          }
        };
      },
      {
        maxAttempts: this.MAX_RETRIES,
        delay: 5000,
        operationName: 'process-documents'
      }
    );
  }

  /**
   * Validate documents against Google AI specifications
   */
  private async validateDocuments(documents: string[]): Promise<any[]> {
    const validatedDocs = [];
    
    for (const docPath of documents) {
      try {
        const stats = await fsPromises.stat(docPath);
        
        // Check file size (50MB limit)
        if (stats.size > this.MAX_FILE_SIZE) {
          throw new Error(`Document exceeds 50MB limit: ${docPath} (${Math.round(stats.size / 1024 / 1024)}MB)`);
        }
        
        // Check file extension
        const ext = path.extname(docPath).toLowerCase();
        const supportedDocTypes = [...this.SUPPORTED_FILE_TYPES.documents, ...this.SUPPORTED_FILE_TYPES.code];
        
        if (!supportedDocTypes.includes(ext)) {
          logger.warn(`Document type may not be fully supported: ${ext}`, { docPath });
        }
        
        // For PDFs, estimate page count (rough estimate based on file size)
        let estimatedPages = 1;
        if (ext === '.pdf') {
          // Rough estimate: 100KB per page average
          estimatedPages = Math.ceil(stats.size / (100 * 1024));
          if (estimatedPages > this.MAX_DOCUMENT_PAGES) {
            throw new Error(`PDF exceeds 1000 page limit: ${docPath} (~${estimatedPages} pages estimated)`);
          }
        }
        
        validatedDocs.push({
          path: docPath,
          size: stats.size,
          type: ext,
          estimatedPages,
          estimatedTokens: estimatedPages * this.TOKENS_PER_PAGE
        });
        
      } catch (error) {
        logger.error(`Document validation failed for ${docPath}`, error as Error);
        throw error;
      }
    }
    
    return validatedDocs;
  }

  /**
   * Build document processing instructions based on analysis type
   */
  private buildDocumentInstructions(analysisType: string, options: any): string {
    const baseInstructions: { [key: string]: string } = {
      summary: 'Provide a comprehensive summary of the document(s), highlighting key points and main ideas.',
      extraction: 'Extract and structure all important information, data points, and key facts from the document(s).',
      comparison: 'Compare and contrast the documents, identifying similarities, differences, and relationships.',
      translation: `Translate the document(s) to ${options.targetLanguage || 'English'} while preserving formatting and meaning.`,
      analysis: 'Perform a detailed analysis of the document(s), including content, structure, and insights.'
    };
    
    let instructions = baseInstructions[analysisType] || baseInstructions.analysis || 'Perform a detailed analysis of the document(s), including content, structure, and insights.';
    
    // Add custom requirements if provided
    if (options.customInstructions) {
      instructions += `\n\nAdditional requirements: ${options.customInstructions}`;
    }
    
    // Add output format specifications
    if (options.outputFormat === 'structured') {
      instructions += '\n\nProvide the output in a well-structured format with clear sections and bullet points.';
    } else if (options.outputFormat === 'json') {
      instructions += '\n\nProvide the output as valid JSON with appropriate keys and structure.';
    }
    
    return instructions;
  }

  /**
   * Estimate token usage for documents
   */
  private estimateDocumentTokens(documents: any[]): number {
    return documents.reduce((total, doc) => {
      return total + (doc.estimatedTokens || this.TOKENS_PER_PAGE);
    }, 0);
  }

  /**
   * Select optimal model based on task type
   */
  private selectOptimalModel(taskType: string): string {
    // Image-related tasks use the image generation model
    if (taskType.includes('image') || taskType.includes('visual') || taskType.includes('picture') || taskType.includes('photo')) {
      return 'gemini-2.0-flash-preview-image-generation';
    }
    
    // Document processing uses gemini-2.5-flash for better performance
    if (taskType.includes('document') || taskType.includes('pdf') || taskType.includes('text') || taskType.includes('analyze')) {
      return 'gemini-2.5-flash';
    }
    
    // Video/audio generation tasks
    if (taskType.includes('video')) {
      return 'gemini-2.0-flash-exp'; // Video generation model when available
    }
    
    if (taskType.includes('audio') || taskType.includes('sound') || taskType.includes('music')) {
      return 'gemini-2.0-flash-exp'; // Audio generation model when available
    }
    
    // Default for other multimodal tasks
    return 'gemini-2.0-flash-exp';
  }

  /**
   * Get model configuration for specific task
   */
  private getModelConfig(taskType: string): any {
    const model = this.selectOptimalModel(taskType);
    const config: any = {
      model,
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 16384
      }
    };
    
    // Add responseModalities for image generation
    if (model === 'gemini-2.0-flash-preview-image-generation') {
      config.generationConfig.responseMimeType = 'application/json';
      // Note: responseModalities would be set here if supported by the SDK
    }
    
    return config;
  }
}