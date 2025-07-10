import { spawn } from 'child_process';
import { createWriteStream, promises as fsPromises } from 'fs';
import { mkdir } from 'fs/promises';
import * as fs from 'fs';
import { dirname, join } from 'path';
import * as path from 'path';
// Commented out unused import for safety - Modality may be needed for future multimodal processing
import { GoogleGenAI /*, Modality */ } from '@google/genai';
import { 
  AI_MODELS, 
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
import { TimeoutManager } from '../utils/TimeoutManager.js';
import pkg from 'wavefile';
const { WaveFile } = pkg;

// Language detection patterns for auto-translation
const LANGUAGE_PATTERNS = {
  ja: /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/,    // Hiragana, Katakana, CJK Unified Ideographs
  ko: /[\uAC00-\uD7AF]/,                              // Hangul Syllables
  zh: /[\u4E00-\u9FFF]/,                              // CJK Unified Ideographs Extended
  fr: /[àâäéèêëïîôöùûüÿç]/,                          // French special characters
  de: /[äöüßÄÖÜ]/,                                   // German special characters
  es: /[ñáéíóúü¿¡]/,                                 // Spanish special characters
  ru: /[\u0400-\u04FF]/,                             // Cyrillic
  ar: /[\u0600-\u06FF]/,                             // Arabic
  hi: /[\u0900-\u097F]/,                             // Devanagari
  th: /[\u0E00-\u0E7F]/                              // Thai
};

const SUPPORTED_LANGUAGES = {
  ja: 'Japanese',
  ko: 'Korean', 
  zh: 'Chinese',
  fr: 'French',
  de: 'German',
  es: 'Spanish',
  ru: 'Russian',
  ar: 'Arabic',
  hi: 'Hindi',
  th: 'Thai'
};

// Problematic words to safe alternatives mapping
const promptSanitizer: Record<string, string> = {
  // Emotional modifiers to specific descriptions
  'cute': 'friendly-looking',
  'adorable': 'appealing',
  'sweet': 'pleasant',
  'baby': 'young',
  'little': 'small-sized',
  'tiny': 'miniature',
  'sexy': 'elegant',
  'hot': 'striking',
  'beautiful': 'visually pleasing',
  'pretty': 'well-formed'
};

// Function to detect language of prompt text
function detectLanguage(text: string): string | null {
  // Remove spaces and check for patterns
  const cleanText = text.trim();
  
  // Check each language pattern
  for (const [langCode, pattern] of Object.entries(LANGUAGE_PATTERNS)) {
    if (pattern.test(cleanText)) {
      return langCode;
    }
  }
  
  // Default to English if no pattern matches
  return 'en';
}

// Function to sanitize prompts by replacing problematic words
function sanitizePrompt(prompt: string): string {
  let sanitized = prompt;
  for (const [problem, safe] of Object.entries(promptSanitizer)) {
    const regex = new RegExp(`\\b${problem}\\b`, 'gi');
    sanitized = sanitized.replace(regex, safe);
  }
  return sanitized;
}

/**
 * AIStudioLayer handles AI Studio MCP integration with enhanced authentication support
 * Provides multimodal file processing for PDF, images, audio, and documents
 */
export class AIStudioLayer implements LayerInterface {
  private readonly instanceId: string;
  private authVerifier: AuthVerifier;
  private genAI: GoogleGenAI | null = null;
  private geminiLayer?: any; // Reference to GeminiCLILayer for translation
  private mcpServerProcess?: any;
  private persistentMCPProcess?: any; // Persistent MCP process for better performance
  private mcpProcessStartTime = 0; // Track when MCP process was started
  private readonly MCP_PROCESS_TTL = 10 * 60 * 1000; // 10 minutes MCP process lifetime
  private isInitialized = false;
  private isLightweightInitialized = false; // Fast initialization for simple tasks
  private lastAuthCheck = 0; // Timestamp of last auth verification
  private readonly AUTH_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days auth cache (API keys are typically long-lived)
  private readonly DEFAULT_TIMEOUT = 300000; // 5 minutes for file processing (increased to fix timeout issues)
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

  constructor(geminiLayer?: any) {
    // Generate unique instance ID for duplicate detection
    this.instanceId = `aistudio-${Math.random().toString(36).slice(2, 9)}-${Date.now().toString(36)}`;
    
    logger.info(`🔧 [${this.instanceId}] AIStudioLayer constructor called - with latest translation fixes`, {
      instanceId: this.instanceId,
      timestamp: Date.now(),
      hasGeminiLayer: !!geminiLayer,
      version: 'v2025-07-03-instance-tracking'
    });
    
    // GHOST LOG DETECTIVE: Monkey-patch console to catch external library logs
    this.setupGhostLogDetection();
    
    this.authVerifier = new AuthVerifier();
    this.geminiLayer = geminiLayer;
    
    // Initialize Google AI Studio API client
    const apiKey = process.env.AI_STUDIO_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_STUDIO_API_KEY;
    if (apiKey) {
      logger.info(`[${this.instanceId}] Creating GoogleGenAI instance with API key`, {
        instanceId: this.instanceId,
        hasApiKey: !!apiKey,
        apiKeySource: process.env.AI_STUDIO_API_KEY ? 'AI_STUDIO_API_KEY' : 
                     process.env.GEMINI_API_KEY ? 'GEMINI_API_KEY' : 
                     process.env.GOOGLE_AI_STUDIO_API_KEY ? 'GOOGLE_AI_STUDIO_API_KEY' : 'unknown'
      });
      console.trace(`[${this.instanceId}] TRACE: GoogleGenAI instance creation`);
      this.genAI = new GoogleGenAI({ apiKey });
      logger.info(`[${this.instanceId}] GoogleGenAI instance created successfully`, {
        instanceId: this.instanceId,
        hasGenAI: !!this.genAI
      });
    }
  }

  /**
   * Lightweight initialization for simple tasks (skips MCP server tests)
   */
  async initializeLightweight(): Promise<void> {
    if (this.isLightweightInitialized) {
      return;
    }

    logger.debug(`[${this.instanceId}] Performing lightweight AI Studio initialization...`);

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
    logger.debug(`[${this.instanceId}] Lightweight AI Studio initialization completed`);
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

        logger.info(`[${this.instanceId}] Initializing AI Studio layer...`);

        // Verify AI Studio authentication
        const authResult = await this.authVerifier.verifyAIStudioAuth();
        if (!authResult.success) {
          throw new Error(`AI Studio authentication failed: ${authResult.error}`);
        }

        // Test MCP server availability (non-blocking)
        try {
          await this.testMCPServerConnection();
        } catch (mcpError) {
          logger.warn(`[${this.instanceId}] AI Studio MCP server prerequisites check failed, using MCP-only architecture`, {
            instanceId: this.instanceId,
            error: (mcpError as Error).message,
            architecture: 'MCP-only (direct API integration disabled for consistency)'
          });
          // Continue initialization - MCP server will be started when needed
        }

        this.isInitialized = true;
        logger.info(`[${this.instanceId}] AI Studio layer initialized successfully`, {
          instanceId: this.instanceId,
          authenticated: authResult.success,
          architecture: 'MCP-only integration (direct API disabled)',
          mcpServerReady: 'Will be started when needed',
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
          if (task.action === 'multimodal_process' && (!task.files || task.files.length === 0)) {
            await this.initializeLightweight();
          } else {
            await this.initialize();
          }
        }

        logger.info(`🔧 [${this.instanceId}] Executing AI Studio task - DEBUG`, {
          instanceId: this.instanceId,
          taskType: task.type || 'general',
          action: task.action || 'execute', 
          fileCount: task.files ? task.files.length : 0,
          taskKeys: Object.keys(task),
          taskStructure: JSON.stringify(task, null, 2).substring(0, 500)
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
            logger.info('🔧 Processing document analysis in execute method', {
              hasFiles: !!(task.files || task.documents),
              fileCount: (task.files || task.documents || []).length,
              hasInstructions: !!task.instructions
            });
            result = await this.analyzeDocuments(task.files || task.documents, task.instructions);
            break;
          case 'image':
            result = await this.analyzeImage(task.imagePath || task.files?.[0]?.path, task.analysisType || 'detailed');
            break;
          case 'image_generation':
          case 'generate_image':
            logger.info('🔧 Calling generateImage from execute method', {
              taskType: task.type,
              prompt: task.prompt || task.text,
              hasOptions: !!task.options
            });
            result = await this.generateImage(task.prompt || task.text, task.options || {});
            break;
          case 'video_generation':
          case 'generate_video':
            throw new Error('Video generation is not yet implemented');
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
    logger.info('🔧 UPDATED generateImage method called - with translation fix', {
      timestamp: Date.now(),
      version: 'v2025-07-03-translation-fix'
    });
    
    logger.info('Generating image using GeminiCLI translation + MCP pattern', {
      promptLength: prompt.length,
      model: AI_MODELS.IMAGE_GENERATION,
      quality: options.quality || 'standard'
    });

    const startTime = Date.now();
    let processedPrompt = prompt;
    let translationInfo: any = {
      detectedLanguage: 'en',
      languageName: 'English',
      wasTranslated: false
    };
    
    // Extract core prompt by removing common English safety prefixes for accurate language detection
    const safetyPrefixes = [
      'digital illustration of',
      'artistic rendering of', 
      'professional diagram showing',
      'creative visualization of',
      'stylized representation of',
      'reference image showing',
      'technical visualization of',
      'scientific diagram of',
      'educational illustration of',
      'documentary-style image of'
    ];
    
    let corePrompt = prompt;
    for (const prefix of safetyPrefixes) {
      if (prompt.toLowerCase().startsWith(prefix.toLowerCase())) {
        corePrompt = prompt.substring(prefix.length).trim();
        break;
      }
    }
    
    logger.info('Language detection analysis', {
      originalPrompt: prompt,
      corePrompt,
      promptLength: prompt.length,
      corePromptLength: corePrompt.length
    });
    
    // Auto-detect language and translate using GeminiCLI for token optimization
    const detectedLang = detectLanguage(corePrompt);
    if (detectedLang && detectedLang !== 'en') {
      const languageName = SUPPORTED_LANGUAGES[detectedLang as keyof typeof SUPPORTED_LANGUAGES] || detectedLang;
      logger.info(`Non-English prompt detected (${languageName}), using GeminiCLI for translation...`, {
        originalPrompt: prompt,
        detectedLanguage: detectedLang
      });

      if (this.geminiLayer) {
        logger.info('GeminiCLI layer available, checking translateToEnglish method', {
          hasTranslateMethod: typeof this.geminiLayer.translateToEnglish === 'function',
          layerType: this.geminiLayer.constructor.name,
          availableMethods: Object.getOwnPropertyNames(Object.getPrototypeOf(this.geminiLayer)).slice(0, 10),
          hasExecute: typeof this.geminiLayer.execute === 'function'
        });
        
        if (typeof this.geminiLayer.translateToEnglish === 'function') {
          try {
            // Ensure GeminiCLI layer is initialized before translation
            if (!await this.geminiLayer.isAvailable()) {
              logger.warn('GeminiCLI layer not available, initializing...');
              await this.geminiLayer.initialize();
            }
            
            logger.info('🔧 About to call translateToEnglish method', {
              hasMethod: typeof this.geminiLayer.translateToEnglish === 'function',
              geminiLayerType: this.geminiLayer.constructor.name,
              corePrompt: corePrompt.substring(0, 50)
            });
            
            const translatedCore = await this.geminiLayer.translateToEnglish(corePrompt, detectedLang);
            // Reconstruct prompt with original prefix + translated core
            const originalPrefix = prompt.substring(0, prompt.length - corePrompt.length);
            processedPrompt = originalPrefix + translatedCore;
            
            translationInfo = {
              detectedLanguage: detectedLang,
              languageName,
              originalPrompt: prompt,
              translatedPrompt: processedPrompt,
              wasTranslated: true
            };
            
            logger.info('GeminiCLI translation completed', {
              originalPrompt: prompt,
              translatedPrompt: processedPrompt,
              language: `${languageName} → English`
            });
          } catch (translationError) {
            logger.warn('Translation unavailable. Continuing with image generation in the input language.', {
              error: translationError instanceof Error ? translationError.message : String(translationError),
              originalLanguage: detectedLang,
              languageName,
              originalPrompt: prompt.substring(0, 100)
            });
            
            console.log('⚠️ Translation unavailable. Continuing with image generation in the input language.');
            // processedPrompt remains as original prompt
          }
        } else {
          logger.warn('Translation unavailable. Continuing with image generation in the input language.', {
            reason: 'translateToEnglish method not found',
            originalLanguage: detectedLang,
            languageName
          });
          
          console.log('⚠️ Translation unavailable. Continuing with image generation in the input language.');
        }
      } else {
        logger.warn('Translation unavailable. Continuing with image generation in the input language.', {
          reason: 'GeminiCLI layer not available',
          originalLanguage: detectedLang,
          languageName
        });
        
        console.log('⚠️ Translation unavailable. Continuing with image generation in the input language.');
      }
    }
    
    try {
      // Use MCP command (matches working timeout pattern from image/PDF analysis)
      // Translation now handled by GeminiCLI for token distribution
      const mcpResult = await this.executeMCPCommand('generate_image', {
        prompt: processedPrompt,
        numberOfImages: options.numberOfImages || 1,
        aspectRatio: options.aspectRatio || '1:1',
        personGeneration: options.personGeneration || 'ALLOW',
        model: AI_MODELS.IMAGE_GENERATION
      });

      const duration = Date.now() - startTime;

      // Extract data from MCP response
      const outputPath = mcpResult.file?.path || '';
      const fileSize = mcpResult.file?.size || 0;
      const imageData = mcpResult.imageData || null;

      return {
        success: true,
        generationType: 'image' as GenerationType,
        outputPath,
        originalPrompt: prompt,
        metadata: {
          duration,
          fileSize,
          format: 'png',
          dimensions: {
            width: options.width || 1024,
            height: options.height || 1024,
          },
          model: AI_MODELS.IMAGE_GENERATION,
          settings: options,
          cost: this.calculateGenerationCost('image', options),
          responseText: mcpResult.metadata?.responseText || '',
          translation: translationInfo
        },
        media: {
          type: 'image',
          data: imageData,
          metadata: {
            format: 'png',
            dimensions: `${options.width || 1024}x${options.height || 1024}`
          }
        }
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Image generation failed: ${errorMessage}`);
    }
  }


  /**
   * Generate audio using AI Studio MCP command (unified timeout pattern)
   */
  async generateAudio(text: string, options: Partial<AudioGenOptions> = {}): Promise<MediaGenResult> {
    logger.info('Generating audio using MCP command (unified timeout pattern)', {
      textLength: text.length,
      voice: options.voice || 'Kore',
      format: 'wav',
      model: AI_MODELS.AUDIO_GENERATION
    });

    const startTime = Date.now();
    
    try {
      // Use MCP command (matches working timeout pattern from image/PDF analysis)
      const mcpResult = await this.executeMCPCommand('generate_audio', {
        text,
        voice: options.voice || 'Kore',
        model: AI_MODELS.AUDIO_GENERATION
      });

      const duration = Date.now() - startTime;

      // Extract data from MCP response
      const outputPath = mcpResult.file?.path || '';
      const fileSize = mcpResult.file?.size || 0;
      const audioData = mcpResult.audioData || null;

      return {
        success: true,
        generationType: 'audio' as GenerationType,
        outputPath,
        originalPrompt: text,
        metadata: {
          duration,
          fileSize,
          format: 'wav',
          model: AI_MODELS.AUDIO_GENERATION,
          settings: options,
          cost: this.calculateGenerationCost('audio', options),
          voice: options.voice || 'Kore'
        },
        media: {
          type: 'audio',
          data: audioData,
          metadata: {
            format: 'wav',
            voice: options.voice || 'Kore'
          }
        }
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Audio generation failed: ${errorMessage}`);
    }
  }

  /**
   * Generate audio with script generation (2-step process)
   */
  async generateAudioWithScript(prompt: string, options: any = {}): Promise<MediaGenResult> {
    logger.info('Generating audio with script generation', {
      prompt: prompt.substring(0, 100),
      hasMultipleSpeakers: !!options.speakers
    });

    try {
      // Step 1: Generate script using gemini-2.0-flash
      const scriptPrompt = options.scriptPrompt || 
        `Generate a script for the following request: ${prompt}. ` +
        (options.speakers ? 
          `Include dialogue for speakers: ${options.speakers.map((s: any) => s.name).join(', ')}.` : 
          'Write it as a single narrator script.');
      
      const scriptResult = await this.executeMCPCommandOptimized('generate_text', {
        prompt: scriptPrompt,
        model: 'gemini-2.0-flash',
        maxOutputTokens: 1000
      });

      const script = scriptResult.text || scriptResult.content?.[0]?.text || 'No script generated';
      logger.info('Script generated successfully', { scriptLength: script.length });

      // Step 2: Convert script to audio
      const audioOptions = {
        ...options,
        script // Pass the generated script for reference
      };
      
      return await this.generateAudio(script, audioOptions);
      
    } catch (error) {
      logger.error('Failed to generate audio with script', error as Error);
      throw error;
    }
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
    logger.info('🔧 analyzeDocuments method called - with timeout fix', {
      fileCount: files.length,
      instructionsLength: instructions.length,
      timestamp: Date.now(),
      version: 'v2025-07-03-document-fix'
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
   * REMOVED: Enforcing MCP-only architecture for consistency
   */
  private canUseDirectAPI(params: any): boolean {
    // Always use MCP server to enforce architectural consistency
    return false;
  }

  /**
   * Execute direct API call for simple operations
   * DEPRECATED: Direct API bypass removed to enforce MCP-only architecture
   */
  private async executeDirectAPI(command: string, params: any): Promise<any> {
    // Direct API bypass removed to enforce architectural consistency
    logger.error(`[${this.instanceId}] GHOST LOG DETECTED: Direct API call attempted but should be disabled!`, {
      instanceId: this.instanceId,
      command,
      params,
      stack: new Error().stack
    });
    console.trace(`[${this.instanceId}] GHOST LOG TRACE: Direct API call attempted:`, command);
    throw new Error(`Direct API integration disabled. All operations must use MCP server for architectural consistency. Command: ${command}`);
  }

  /**
   * Calculate optimized timeout based on operation complexity
   */
  private calculateOptimizedTimeout(command: string, params: any): number {
    let timeout = 60000; // Base: 1 minute for optimized operations
    
    if (command === 'generate_image') {
      timeout = 180000; // 3 minutes for image generation (increased from 2 minutes)
    } else if (command === 'generate_audio') {
      timeout = 120000; // 2 minutes for audio generation
    } else if (command === 'generate_video') {
      timeout = 300000; // 5 minutes for video generation
    } else if (command === 'multimodal_process' || command === 'analyze_documents') {
      timeout = 300000; // 5 minutes for document processing
    } else if (params?.files && params.files.length > 0) {
      timeout = 120000 + (params.files.length * 20000); // 2 minutes + 20s per file
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
      throw new Error('Video generation is not yet implemented');
    }
    
    if (this.isAudioGenerationRequest(prompt)) {
      logger.info('Detected audio generation request in general processing', {
        prompt: prompt.substring(0, 100)
      });
      return await this.generateAudio(prompt, task.options || {});
    }

    // Special handling for multiple PDFs using Gemini File API
    if (task.options?.multiplePDFs && task.files && task.files.length > 1) {
      const pdfFiles = task.files.filter((file: any) => file.path.toLowerCase().endsWith('.pdf'));
      if (pdfFiles.length > 1) {
        logger.info('Processing multiple PDFs with Gemini File API', {
          pdfCount: pdfFiles.length,
          totalFiles: task.files.length
        });
        return await this.processMultiplePDFs(pdfFiles, prompt);
      }
    }
    
    return await this.executeMCPCommandOptimized('multimodal_process', {
      files: task.files || [],
      instructions: prompt,
      model: 'gemini-2.5-flash',
    });
  }

  /**
   * Resolve MCP server path with multiple fallback strategies
   */
  private resolveMCPServerPath(): string {
    const serverFileName = 'ai-studio-mcp-server.js';
    
    // Strategy 1: Development mode (current working directory)
    const devPath = join(process.cwd(), 'dist', 'mcp-servers', serverFileName);
    if (fs.existsSync(devPath)) {
      logger.debug('Using development MCP server path', { path: devPath });
      return devPath;
    }
    
    // Strategy 2: NPM local install (node_modules)
    const localNpmPath = join(process.cwd(), 'node_modules', 'claude-gemini-multimodal-bridge', 'dist', 'mcp-servers', serverFileName);
    if (fs.existsSync(localNpmPath)) {
      logger.debug('Using local npm install MCP server path', { path: localNpmPath });
      return localNpmPath;
    }
    
    // Strategy 3: Global npm install via require.resolve
    try {
      const packagePath = require.resolve('claude-gemini-multimodal-bridge/package.json');
      const packageDir = dirname(packagePath);
      const globalNpmPath = join(packageDir, 'dist', 'mcp-servers', serverFileName);
      if (fs.existsSync(globalNpmPath)) {
        logger.debug('Using global npm install MCP server path', { path: globalNpmPath });
        return globalNpmPath;
      }
    } catch (error) {
      logger.debug('Could not resolve package via require.resolve', { error: (error as Error).message });
    }
    
    // Strategy 4: Search in typical global npm locations
    const globalPaths = [
      join(process.env.HOME || process.env.USERPROFILE || '', '.nvm', 'versions', 'node', process.version, 'lib', 'node_modules', 'claude-gemini-multimodal-bridge', 'dist', 'mcp-servers', serverFileName),
      join('/usr/local/lib/node_modules/claude-gemini-multimodal-bridge/dist/mcp-servers', serverFileName),
      join('/opt/homebrew/lib/node_modules/claude-gemini-multimodal-bridge/dist/mcp-servers', serverFileName)
    ];
    
    for (const globalPath of globalPaths) {
      if (fs.existsSync(globalPath)) {
        logger.debug('Using global npm path from search', { path: globalPath });
        return globalPath;
      }
    }
    
    // Strategy 5: Check if running from global npm installation (current directory check)
    const currentDirPath = join(__dirname, '..', 'mcp-servers', serverFileName);
    if (fs.existsSync(currentDirPath)) {
      logger.debug('Using current directory relative path', { path: currentDirPath });
      return currentDirPath;
    }
    
    // Strategy 6: Last resort - try module directory traversal
    try {
      const moduleDir = dirname(require.resolve('claude-gemini-multimodal-bridge'));
      const modulePath = join(moduleDir, 'mcp-servers', serverFileName);
      if (fs.existsSync(modulePath)) {
        logger.debug('Using module directory path', { path: modulePath });
        return modulePath;
      }
    } catch (error) {
      logger.debug('Module directory traversal failed', { error: (error as Error).message });
    }
    
    // If all strategies fail, return the development path as fallback
    logger.warn('Could not resolve MCP server path, using development fallback', { 
      fallbackPath: devPath,
      cwd: process.cwd(),
      __dirname,
      strategies_tried: ['development', 'local_npm', 'global_npm_resolve', 'global_paths_search', 'current_dir_relative', 'module_traversal']
    });
    
    return devPath;
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
      
      const mcpServerPath = this.resolveMCPServerPath();
      
      // Verify the MCP server exists before spawning
      if (!fs.existsSync(mcpServerPath)) {
        logger.error('MCP server not found at resolved path for persistent process', { 
          mcpServerPath,
          cwd: process.cwd(),
          __dirname
        });
        throw new Error(`AI Studio MCP server not found at: ${mcpServerPath}`);
      }
      
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
    if (command === 'multimodal_process' && this.canUseDirectAPI(params)) {
      return await this.executeDirectAPI(command, params);
    }
    
    // Use persistent MCP process for complex operations
    const process = await this.getPersistentMCPProcess();
    
    return new Promise<any>((resolve, reject) => {
      const timeout = this.calculateOptimizedTimeout(command, params);
      
      logger.debug(`[${this.instanceId}] Executing optimized MCP command`, {
        instanceId: this.instanceId,
        command,
        hasParams: !!params,
        timeout,
        usesPersistentProcess: true,
      });

      let output = '';
      let errorOutput = '';

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

      // Create cleanup function to ensure proper timeout clearing
      let isResolved = false;
      let timeoutId: NodeJS.Timeout;
      
      const cleanup = () => {
        if (!isResolved) {
          isResolved = true;
          if (timeoutId) {
            clearTimeout(timeoutId);
          }
          try {
            process.stdout.removeListener('data', dataHandler);
            process.stderr.removeListener('data', errorHandler);
          } catch (error) {
            // Ignore cleanup errors
          }
        }
      };
      
      try {
        process.stdin.write(JSON.stringify(mcpRequest) + '\n');
      } catch (error) {
        cleanup();
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
                cleanup(); // 即座にクリーンアップとタイムアウトクリア
                
                if (mcpResponse.error) {
                  reject(new Error(`MCP Error: ${mcpResponse.error.message || 'Unknown error'}`));
                } else {
                  resolve(mcpResponse.result); // 即座にresolve（タイムアウト問題の修正）
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
      
      // Set up timeout with immediate cleanup
      timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error(`AI Studio MCP command timeout after ${timeout}ms - operation completed but response delayed`));
      }, timeout);

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
    
    // Image generation with optimized timeout (immediate response on success)
    if (command === 'generate_image' || this.isImageGenerationCommand(command, params)) {
      timeout = Math.max(120000, this.DEFAULT_TIMEOUT * 0.8); // Optimized to 2 minutes for image generation
      logger.debug('Optimized timeout for image generation', {
        command,
        timeoutMs: timeout,
        timeoutMinutes: Math.round(timeout / 60000),
        reason: 'Immediate timeout clear on success reduces actual wait time'
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
      const mcpServerPath = this.resolveMCPServerPath();
      
      // Verify the MCP server exists before spawning
      if (!fs.existsSync(mcpServerPath)) {
        logger.error('MCP server not found at resolved path', { 
          mcpServerPath,
          cwd: process.cwd(),
          __dirname
        });
        reject(new Error(`AI Studio MCP server not found at: ${mcpServerPath}`));
        return;
      }
      
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
          // Immediate resolution pattern for new installations
          // Process results immediately without waiting for additional processing
          try {
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
                continue;
              }
            }
            
            logger.debug(`[${this.instanceId}] MCP command completed successfully - immediate resolution`, {
              instanceId: this.instanceId,
              command,
              outputLength: output.length,
              code,
              resultType: typeof result,
              hasResult: !!result
            });
            
            resolve(result);
          } catch (parseError) {
            logger.debug(`[${this.instanceId}] MCP parsing failed, using raw output fallback`, {
              instanceId: this.instanceId,
              parseError: parseError instanceof Error ? parseError.message : String(parseError)
            });
            resolve({ content: output.trim() });
          }
        } else {
          const error = `AI Studio MCP command failed with code ${code}: ${errorOutput}`;
          logger.error(`[${this.instanceId}] MCP command failed`, { 
            instanceId: this.instanceId,
            command, 
            code, 
            error: errorOutput 
          });
          reject(new Error(error));
        }
      });

      child.on('error', (error) => {
        clearTimeout(timeoutId); // エラー時も即座にクリア
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
   * Setup ghost log detection to catch external library logs
   * This helps identify where "direct API integration" logs are coming from
   */
  private setupGhostLogDetection(): void {
    const originalConsoleDebug = console.debug;
    const originalConsoleLog = console.log;
    const originalConsoleWarn = console.warn;
    const originalConsoleInfo = console.info;

    // Monkey-patch console methods to detect library logs
    console.debug = (...args: any[]) => {
      const message = args.join(' ');
      if (message.includes('direct') || message.includes('API') || message.includes('integration') || 
          message.includes('precedence') || message.includes('Vertex')) {
        logger.error(`[${this.instanceId}] GHOST LOG DETECTED - console.debug:`, {
          instanceId: this.instanceId,
          message,
          stack: new Error().stack,
          source: '@google/genai or external library'
        });
        console.trace(`[${this.instanceId}] GHOST LOG TRACE - console.debug:`, message);
      }
      originalConsoleDebug.apply(console, args);
    };

    console.log = (...args: any[]) => {
      const message = args.join(' ');
      if (message.includes('direct') || message.includes('API') || message.includes('integration') ||
          message.includes('AI Studio') || message.includes('using')) {
        logger.error(`[${this.instanceId}] GHOST LOG DETECTED - console.log:`, {
          instanceId: this.instanceId,
          message,
          stack: new Error().stack,
          source: 'External library or unknown'
        });
        console.trace(`[${this.instanceId}] GHOST LOG TRACE - console.log:`, message);
      }
      originalConsoleLog.apply(console, args);
    };

    logger.info(`[${this.instanceId}] Ghost log detection active - monitoring console methods`, {
      instanceId: this.instanceId,
      monitoredMethods: ['console.debug', 'console.log', 'console.warn', 'console.info'],
      purpose: 'Detect external library logs about direct API integration'
    });
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
        
        // Force MCP server usage for unified timeout handling
        logger.info('AI Studio layer ready with MCP-only architecture', {
          apiKeyAvailable: true,
          architecture: 'MCP-only integration',
          note: 'Direct API integration disabled for architectural consistency'
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
   * Create a WAV file with proper headers manually (fallback method)
   */
  private createManualWavHeader(pcmData: Buffer, sampleRate: number, bitDepth: number, channels: number): Buffer {
    const byteRate = sampleRate * channels * (bitDepth / 8);
    const blockAlign = channels * (bitDepth / 8);
    const dataSize = pcmData.length;
    const fileSize = 36 + dataSize;
    
    // Create WAV header buffer
    const header = Buffer.alloc(44);
    
    // RIFF chunk descriptor
    header.write('RIFF', 0);
    header.writeUInt32LE(fileSize, 4);
    header.write('WAVE', 8);
    
    // fmt sub-chunk
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16); // PCM format chunk size
    header.writeUInt16LE(1, 20);  // PCM format
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitDepth, 34);
    
    // data sub-chunk
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);
    
    // Combine header and PCM data
    const wavBuffer = Buffer.concat([header, pcmData]);
    
    logger.debug('Manual WAV header created', {
      headerSize: header.length,
      dataSize: pcmData.length,
      totalSize: wavBuffer.length,
      sampleRate,
      bitDepth,
      channels,
      byteRate,
      blockAlign
    });
    
    return wavBuffer;
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
      if (Math.abs(ratio - 1) < 0.1) {return '1:1';}
      if (Math.abs(ratio - 0.75) < 0.1) {return '3:4';}
      if (Math.abs(ratio - 1.33) < 0.1) {return '4:3';}
      if (Math.abs(ratio - 0.56) < 0.1) {return '9:16';}
      if (Math.abs(ratio - 1.78) < 0.1) {return '16:9';}
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
   * Save generated audio from base64 data
   */
  private async saveGeneratedAudio(base64Data: string, format: string = 'wav'): Promise<string> {
    const outputDir = join(process.cwd(), 'output', 'audio');
    await mkdir(outputDir, { recursive: true });
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `generated-audio-${timestamp}.${format}`;
    const outputPath = join(outputDir, filename);
    
    // Create proper WAV file with headers if format is wav
    let finalBuffer: Buffer;
    if (format === 'wav') {
      const rawAudioBuffer = Buffer.from(base64Data, 'base64');
      
      logger.debug('Processing audio data for saveGeneratedAudio', {
        rawDataSize: rawAudioBuffer.length,
        format
      });
      
      try {
        // Create WAV file with proper headers using WaveFile library (google_docs.md specification)
        const wav = new WaveFile();
        
        // Google AI Studio returns L16 PCM data (16-bit signed integers)
        // Convert Buffer to Int16Array for WaveFile.fromScratch()
        const pcmSamples = [];
        for (let i = 0; i < rawAudioBuffer.length; i += 2) {
          // Read 16-bit signed little-endian integers
          const sample = rawAudioBuffer.readInt16LE(i);
          pcmSamples.push(sample);
        }
        
        // fromScratch expects: channels, sampleRate, bitDepth, PCM samples array
        wav.fromScratch(1, 24000, '16', pcmSamples);
        const wavData = wav.toBuffer();
        finalBuffer = Buffer.from(wavData);
        
        // Validate WAV header
        const riffHeader = finalBuffer.toString('ascii', 0, 4);
        const waveHeader = finalBuffer.toString('ascii', 8, 12);
        
        if (riffHeader !== 'RIFF' || waveHeader !== 'WAVE') {
          throw new Error(`Invalid WAV header: RIFF=${riffHeader}, WAVE=${waveHeader}`);
        }
        
        logger.info('Generated WAV file with proper headers', {
          originalDataSize: rawAudioBuffer.length,
          finalWavSize: finalBuffer.length,
          sampleRate: 24000,
          bitDepth: 16,
          channels: 1
        });
        
      } catch (wavError) {
        logger.error('WAV creation failed in saveGeneratedAudio, using manual header', {
          error: (wavError as Error).message
        });
        
        // Fallback to manual WAV header creation
        finalBuffer = this.createManualWavHeader(rawAudioBuffer, 24000, 16, 1);
        
        logger.warn('Used manual WAV header fallback in saveGeneratedAudio', {
          finalWavSize: finalBuffer.length
        });
      }
    } else {
      finalBuffer = Buffer.from(base64Data, 'base64');
    }
    
    await new Promise<void>((resolve, reject) => {
      const stream = createWriteStream(outputPath);
      stream.write(finalBuffer);
      stream.end();
      stream.on('finish', resolve);
      stream.on('error', reject);
    });
    
    logger.info('Saved generated audio', { outputPath, size: finalBuffer.length });
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
      return AI_MODELS.IMAGE_GENERATION;
    }
    
    // Document processing uses gemini-2.5-flash for better performance
    if (taskType.includes('document') || taskType.includes('pdf') || taskType.includes('text') || taskType.includes('analyze')) {
      return AI_MODELS.DOCUMENT_PROCESSING;
    }
    
    // Audio generation uses TTS model
    if (taskType.includes('audio') || taskType.includes('speech') || taskType.includes('tts') || taskType.includes('voice')) {
      return AI_MODELS.AUDIO_GENERATION;
    }
    
    // Script generation for audio uses regular flash model
    if (taskType.includes('script') || taskType.includes('transcript')) {
      return AI_MODELS.GEMINI_FLASH;
    }
    
    // Default for other multimodal tasks
    return AI_MODELS.MULTIMODAL_DEFAULT;
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
    if (model === AI_MODELS.IMAGE_GENERATION) {
      config.generationConfig.responseMimeType = 'application/json';
      // Note: responseModalities would be set here if supported by the SDK
    }
    
    return config;
  }

  /**
   * Process multiple PDFs using Gemini File API batch processing
   * Based on Google official documentation: https://ai.google.dev/gemini-api/docs/document-processing
   */
  private async processMultiplePDFs(pdfFiles: any[], prompt: string): Promise<any> {
    logger.info('Starting multiple PDF processing with Gemini File API', {
      pdfCount: pdfFiles.length,
      promptLength: prompt.length
    });

    // Validate file sizes - Google AI Studio supports up to 50MB per PDF
    for (const file of pdfFiles) {
      const stats = await fs.promises.stat(file.path);
      const fileSizeMB = stats.size / (1024 * 1024);
      
      if (fileSizeMB > 50) {
        throw new Error(`PDF file ${file.path} is ${fileSizeMB.toFixed(1)}MB, which exceeds the 50MB limit for Gemini File API`);
      }
      
      logger.debug('PDF file validation passed', {
        path: file.path,
        sizeMB: fileSizeMB.toFixed(1)
      });
    }

    // Use MCP server for multiple PDF processing
    const result = await this.executeMCPCommandOptimized('multimodal_process', {
      files: pdfFiles,
      instructions: `${prompt}\n\nProcess these ${pdfFiles.length} PDF documents using Gemini File API batch processing. Compare and analyze content across all documents.`,
      model: 'gemini-2.5-flash',
      options: {
        batchProcessing: true,
        multiplePDFs: true,
        extractStructure: true,
        compareDocuments: pdfFiles.length > 1
      }
    });

    logger.info('Multiple PDF processing completed', {
      pdfCount: pdfFiles.length,
      success: !!result
    });

    return result;
  }
}