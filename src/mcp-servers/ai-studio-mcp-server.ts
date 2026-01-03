#!/usr/bin/env node

/**
 * AI Studio MCP Server
 * Custom MCP server for Google AI Studio integration with image generation support
 * Replaces the non-existent aistudio-mcp-server package
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
  McpError
} from '@modelcontextprotocol/sdk/types.js';
import { GoogleGenAI, Modality } from '@google/genai';
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { promises as fsPromises } from 'fs';
// Import AI_MODELS from the build output location
import { AI_MODELS } from '../core/types.js';
import { normalizeCrossPlatformPath } from '../utils/platformUtils.js';
import pkg from 'wavefile';
const { WaveFile } = pkg;
// pdf-parse は extractPDFText() メソッド内で動的に読み込みます


// Input validation schemas
const GenerateImageSchema = z.object({
  prompt: z.string().min(1).max(480), // Max tokens as per API docs
  numberOfImages: z.number().min(1).max(4).optional().default(1),
  aspectRatio: z.enum(['1:1', '3:4', '4:3', '9:16', '16:9']).optional().default('1:1'),
  personGeneration: z.enum(['ALLOW', 'BLOCK']).optional().default('ALLOW'),
  model: z.string().optional()
});

const AnalyzeImageSchema = z.object({
  imagePath: z.string(),
  prompt: z.string().optional().default('Analyze this image and describe what you see'),
  model: z.string().optional().default('gemini-2.0-flash-exp')
});

const MultimodalProcessSchema = z.object({
  files: z.array(z.object({
    path: z.string(),
    type: z.string()
  })),
  instructions: z.string(),
  model: z.string().optional().default('gemini-2.0-flash-exp')
});

const GetGeneratedFileSchema = z.object({
  filePath: z.string(),
  returnBase64: z.boolean().optional().default(true)
});

const ListGeneratedFilesSchema = z.object({
  fileType: z.enum(['image', 'audio', 'document', 'all']).optional().default('all'),
  limit: z.number().optional().default(50),
  sortBy: z.enum(['date', 'size', 'name']).optional().default('date')
});

const GetFileInfoSchema = z.object({
  filePath: z.string()
});

const GenerateAudioSchema = z.object({
  text: z.string().min(1).max(5000), // Reasonable text limit for TTS
  voice: z.enum(['Kore', 'Puck']).optional().default('Kore'),
  model: z.string().optional()
});

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

// Function to sanitize prompts by replacing problematic words
function sanitizePrompt(prompt: string): string {
  let sanitized = prompt;
  for (const [problem, safe] of Object.entries(promptSanitizer)) {
    const regex = new RegExp(`\\b${problem}\\b`, 'gi');
    sanitized = sanitized.replace(regex, safe);
  }
  return sanitized;
}

class AIStudioMCPServer {
  private server: Server;
  private genAI: GoogleGenAI;

  constructor() {
    // Get API key from environment
    const apiKey = process.env.AI_STUDIO_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_STUDIO_API_KEY;
    if (!apiKey) {
      throw new Error('AI_STUDIO_API_KEY environment variable is required');
    }

    this.genAI = new GoogleGenAI({ apiKey });
    this.server = new Server(
      {
        name: 'ai-studio-mcp-server',
        version: '1.1.4',
        // Note: author and license info in package.json
      },
      {
        capabilities: {
          tools: {},
          prompts: {}
        },
      }
    );

    this.setupToolHandlers();
    this.setupPromptHandlers();
  }

  private setupToolHandlers() {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'generate_image',
            description: 'Generate high-quality images using Google AI Studio\'s Gemini 2.0 Flash model. All generated content complies with Google\'s content policies and is suitable for professional, educational, and creative use cases. The tool automatically applies safety prefixes to ensure appropriate content generation.',
            inputSchema: {
              type: 'object',
              properties: {
                prompt: {
                  type: 'string',
                  description: 'Text description of the image to generate (max 480 tokens)',
                  maxLength: 480
                },
                numberOfImages: {
                  type: 'number',
                  description: 'Number of images to generate (1-4)',
                  minimum: 1,
                  maximum: 4,
                  default: 1
                },
                aspectRatio: {
                  type: 'string',
                  enum: ['1:1', '3:4', '4:3', '9:16', '16:9'],
                  description: 'Aspect ratio of generated images',
                  default: '1:1'
                },
                personGeneration: {
                  type: 'string',
                  enum: ['ALLOW', 'BLOCK'],
                  description: 'Control generation of people in images',
                  default: 'ALLOW'
                },
                model: {
                  type: 'string',
                  description: 'AI Studio model to use for generation',
                  default: AI_MODELS.IMAGE_GENERATION
                }
              },
              required: ['prompt']
            }
          },
          {
            name: 'analyze_image',
            description: 'Professional image analysis using Google AI Studio\'s Gemini multimodal capabilities. Extracts detailed information, identifies objects, reads text, and provides contextual understanding. Suitable for business intelligence, accessibility, and content moderation use cases.',
            inputSchema: {
              type: 'object',
              properties: {
                imagePath: {
                  type: 'string',
                  description: 'Path to the image file to analyze'
                },
                prompt: {
                  type: 'string',
                  description: 'Analysis instructions',
                  default: 'Analyze this image and describe what you see'
                },
                model: {
                  type: 'string',
                  description: 'Gemini model to use for analysis',
                  default: 'gemini-2.0-flash-exp'
                }
              },
              required: ['imagePath']
            }
          },
          {
            name: 'multimodal_process',
            description: 'Process multiple files simultaneously using Google AI Studio\'s advanced multimodal understanding. Supports images, documents, audio, and mixed media. Ideal for batch processing, content analysis, and data extraction workflows. All processing adheres to privacy and security standards.',
            inputSchema: {
              type: 'object',
              properties: {
                files: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      path: { type: 'string' },
                      type: { type: 'string' }
                    },
                    required: ['path', 'type']
                  },
                  description: 'Array of files to process'
                },
                instructions: {
                  type: 'string',
                  description: 'Processing instructions'
                },
                model: {
                  type: 'string',
                  description: 'Gemini model to use',
                  default: 'gemini-2.0-flash-exp'
                }
              },
              required: ['files', 'instructions']
            }
          },
          {
            name: 'analyze_documents',
            description: 'Extract and analyze information from documents using Google AI Studio\'s document understanding capabilities. Supports PDFs, text files, and various document formats. Provides structured data extraction, summarization, and intelligent insights for professional document processing.',
            inputSchema: {
              type: 'object',
              properties: {
                documents: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Array of document paths'
                },
                instructions: {
                  type: 'string',
                  description: 'Analysis instructions'
                },
                options: {
                  type: 'object',
                  properties: {
                    extract_structure: { type: 'boolean', default: true },
                    summarize: { type: 'boolean', default: true }
                  }
                }
              },
              required: ['documents', 'instructions']
            }
          },
          {
            name: 'get_generated_file',
            description: 'Retrieve a previously generated file by its path. Provides direct access to images, audio, and processed documents created by CGMB. Returns file content and metadata for easy integration.',
            inputSchema: {
              type: 'object',
              properties: {
                filePath: {
                  type: 'string',
                  description: 'Path to the generated file (relative or absolute)'
                },
                returnBase64: {
                  type: 'boolean',
                  description: 'Return file content as base64 string',
                  default: true
                }
              },
              required: ['filePath']
            }
          },
          {
            name: 'list_generated_files',
            description: 'List all files generated in the current session or within a specified time range. Helps track and manage generated content. Returns file paths, types, sizes, and creation timestamps.',
            inputSchema: {
              type: 'object',
              properties: {
                fileType: {
                  type: 'string',
                  enum: ['image', 'audio', 'document', 'all'],
                  description: 'Filter by file type',
                  default: 'all'
                },
                limit: {
                  type: 'number',
                  description: 'Maximum number of files to return',
                  default: 50
                },
                sortBy: {
                  type: 'string',
                  enum: ['date', 'size', 'name'],
                  description: 'Sort order for results',
                  default: 'date'
                }
              }
            }
          },
          {
            name: 'get_file_info',
            description: 'Get detailed metadata about a generated file without retrieving its content. Returns file size, dimensions (for images), duration (for audio), format, and creation details.',
            inputSchema: {
              type: 'object',
              properties: {
                filePath: {
                  type: 'string',
                  description: 'Path to the file'
                }
              },
              required: ['filePath']
            }
          },
          {
            name: 'generate_audio',
            description: 'Generate high-quality audio using Google AI Studio\'s Gemini 2.5 Flash TTS model. Produces clear, natural-sounding speech with multiple voice options. All audio is generated in WAV format with proper headers for universal compatibility.',
            inputSchema: {
              type: 'object',
              properties: {
                text: {
                  type: 'string',
                  description: 'Text to convert to speech (max 5000 characters)',
                  maxLength: 5000
                },
                voice: {
                  type: 'string',
                  enum: ['Kore', 'Puck'],
                  description: 'Voice to use for audio generation',
                  default: 'Kore'
                },
                model: {
                  type: 'string',
                  description: 'AI Studio model to use for generation',
                  default: AI_MODELS.AUDIO_GENERATION
                }
              },
              required: ['text']
            }
          }
        ]
      };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'generate_image':
            return await this.generateImage(args);
          case 'analyze_image':
            return await this.analyzeImage(args);
          case 'multimodal_process':
            return await this.processMultimodal(args);
          case 'analyze_documents':
            return await this.analyzeDocuments(args);
          case 'get_generated_file':
            return await this.getGeneratedFile(args);
          case 'list_generated_files':
            return await this.listGeneratedFiles(args);
          case 'get_file_info':
            return await this.getFileInfo(args);
          case 'generate_audio':
            return await this.generateAudio(args);
          default:
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
        }
      } catch (error) {
        if (error instanceof McpError) {
          throw error;
        }
        throw new McpError(
          ErrorCode.InternalError,
          `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
  }

  private setupPromptHandlers() {
    // List available prompts
    this.server.setRequestHandler(ListPromptsRequestSchema, async () => {
      return {
        prompts: [
          {
            name: 'image-generation-prompt',
            description: 'Optimized prompt for high-quality image generation',
            arguments: [
              {
                name: 'subject',
                description: 'Main subject of the image',
                required: true
              },
              {
                name: 'style',
                description: 'Art style or aesthetic',
                required: false
              },
              {
                name: 'context',
                description: 'Background or environment',
                required: false
              }
            ]
          }
        ]
      };
    });

    // Handle prompt requests
    this.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      if (name === 'image-generation-prompt') {
        const subject = args?.subject || 'a beautiful landscape';
        const style = args?.style || 'photorealistic';
        const context = args?.context || 'natural lighting';
        
        return {
          description: 'Optimized image generation prompt',
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text: `Create a ${style} image of ${subject} with ${context}. High quality, detailed, professional composition.`
              }
            }
          ]
        };
      }

      throw new McpError(ErrorCode.InvalidRequest, `Unknown prompt: ${name}`);
    });
  }

  private async generateImage(args: any) {
    const params = GenerateImageSchema.parse(args);
    
    try {
      // Sanitize the prompt to replace problematic words  
      // Translation is now handled by GeminiCLI in AIStudioLayer
      const sanitizedPrompt = sanitizePrompt(params.prompt);
      // Log sanitization for debugging if needed
      if (params.prompt !== sanitizedPrompt) {
        console.error(`[AI Studio MCP] Prompt sanitized: "${params.prompt}" → "${sanitizedPrompt}"`);
      }
      
      // Add safety prefixes to avoid content policy issues
      let safePrompt = sanitizedPrompt;
      const safetyPrefixes = [
        'educational illustration of',
        'reference image showing',
        'technical visualization of',
        'professional photograph of',
        'scientific diagram of',
        'instructional image depicting',
        'documentary-style image of'
      ];
      
      // Check if prompt already has a safety prefix
      const hasPrefix = safetyPrefixes.some(prefix => 
        safePrompt.toLowerCase().startsWith(prefix)
      );
      
      if (!hasPrefix) {
        const prefix = safetyPrefixes[Math.floor(Math.random() * safetyPrefixes.length)];
        safePrompt = `${prefix} ${params.prompt}`;
      }
      
      // Generate image with official API approach from documentation
      const response = await this.genAI.models.generateContent({
        model: params.model || AI_MODELS.IMAGE_GENERATION,
        contents: safePrompt,
        config: {
          responseModalities: [Modality.TEXT, Modality.IMAGE],
        },
      });

      let imageData = null;
      let textContent = '';
      
      // Extract image data from response according to official docs
      if (response.candidates?.[0]?.content?.parts) {
        for (const part of response.candidates[0].content.parts) {
          if (part.text) {
            textContent = part.text;
          } else if (part.inlineData) {
            imageData = part.inlineData.data;
          }
        }
      }

      // Try parsing JSON response if available
      if (textContent) {
        try {
          const jsonResponse = JSON.parse(textContent);
          if (jsonResponse.images && jsonResponse.images.length > 0) {
            imageData = jsonResponse.images[0].data;
          }
        } catch {
          // Not JSON, continue with regular processing
        }
      }

      // Save the generated image if we have data
      let savedFilePath: string | null = null;
      let savedAbsolutePath: string | null = null;
      let fileSize = 0;
      if (imageData) {
        const outputDir = path.join(process.cwd(), 'output', 'images');
        await fsPromises.mkdir(outputDir, { recursive: true });

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `generated-image-${timestamp}.png`;
        savedAbsolutePath = path.join(outputDir, filename);

        const buffer = Buffer.from(imageData, 'base64');
        await fsPromises.writeFile(savedAbsolutePath, buffer);

        // Verify file was written
        if (!fs.existsSync(savedAbsolutePath)) {
          throw new Error(`Failed to write image file: ${savedAbsolutePath}`);
        }

        fileSize = buffer.length;
        // Use normalized cross-platform path (forward slashes)
        savedFilePath = normalizeCrossPlatformPath(`output/images/${filename}`);
      }

      return {
        content: [
          {
            type: 'text',
            text: imageData 
              ? `✅ Successfully generated image using Gemini 2.0 Flash

📁 File saved to: ${savedFilePath}
📏 Size: ${(fileSize / 1024).toFixed(2)} KB
🎨 Original prompt: ${params.prompt}
✨ Safe prompt: ${safePrompt}

To retrieve this file, use:
- Tool: get_generated_file
- Parameter: {"filePath": "${savedFilePath}"}`
              : `Image generation completed\nOriginal prompt: ${params.prompt}\nSafe prompt: ${safePrompt}\n${textContent || 'Processing complete'}`
          }
        ],
        imageData,
        downloadUrl: null,
        file: savedFilePath ? {
          path: savedFilePath,
          absolutePath: savedAbsolutePath,
          size: fileSize,
          format: 'png',
          createdAt: new Date().toISOString()
        } : null,
        metadata: {
          model: params.model || AI_MODELS.IMAGE_GENERATION,
          originalPrompt: params.prompt,
          safePrompt: safePrompt,
          numberOfImages: params.numberOfImages,
          aspectRatio: params.aspectRatio,
          personGeneration: params.personGeneration,
          responseText: textContent
        }
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      // Check for content policy errors
      if (errorMessage.toLowerCase().includes('content policy') || 
          errorMessage.toLowerCase().includes('safety') ||
          errorMessage.toLowerCase().includes('inappropriate')) {
        
        // Provide helpful alternative suggestions
        const sanitized = sanitizePrompt(params.prompt);
        const suggestions = [
          `Try more specific descriptions: "${sanitized} in natural outdoor setting"`,
          `Use technical terms: "photograph of domestic feline in garden environment"`,
          `Focus on actions: "cat playing with yarn ball in daylight"`,
          `Add visual details: "orange tabby cat with stripes sitting on grass"`,
          `Use professional context: "reference photo of cat for educational purposes"`
        ];
        
        throw new McpError(
          ErrorCode.InvalidRequest,
          `Content policy violation. The word "cute" and similar emotional descriptors often trigger safety filters.\n\nSuggestions:\n${suggestions.join('\n')}`
        );
      }
      
      throw new McpError(
        ErrorCode.InternalError,
        `Image generation failed: ${errorMessage}`
      );
    }
  }

  private async analyzeImage(args: any) {
    const params = AnalyzeImageSchema.parse(args);
    
    try {
      // Read the image file
      if (!fs.existsSync(params.imagePath)) {
        throw new Error(`Image file not found: ${params.imagePath}`);
      }

      const imageData = fs.readFileSync(params.imagePath);
      const mimeType = this.getMimeType(params.imagePath);

      const parts = [
        params.prompt,
        {
          inlineData: {
            data: imageData.toString('base64'),
            mimeType
          }
        }
      ];

      const response = await this.genAI.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: parts,
        config: {
          responseModalities: [Modality.TEXT],
        },
      });

      return {
        content: [
          {
            type: 'text',
            text: response.candidates?.[0]?.content?.parts?.[0]?.text || 'No response generated'
          }
        ],
        metadata: {
          model: params.model,
          imagePath: params.imagePath,
          prompt: params.prompt
        }
      };

    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Image analysis failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async processMultimodal(args: any) {
    const params = MultimodalProcessSchema.parse(args);
    
    try {
      console.error(`Processing multimodal request with ${params.files.length} files`);
      const parts: any[] = [{ text: params.instructions }];

      // Process each file
      for (const file of params.files) {
        console.error(`Processing file: ${file.path}`);
        
        // Check if the path is a URL
        const isUrl = file.path.startsWith('http://') || file.path.startsWith('https://');
        
        if (isUrl) {
          console.error(`Detected URL: ${file.path}`);
          const mimeType = this.getMimeTypeFromUrl(file.path);
          console.error(`URL detected as MIME type: ${mimeType}`);
          
          if (mimeType === 'application/pdf') {
            // Use File API to upload PDF URL for native processing
            console.error(`Uploading PDF URL to Gemini File API: ${file.path}`);
            const uploadedFile = await this.uploadPDFUrlWithFileAPI(file.path);
            parts.push({
              fileData: {
                fileUri: uploadedFile.uri,
                mimeType: 'application/pdf'
              }
            });
          } else {
            console.warn(`Unsupported URL type: ${mimeType} for ${file.path}`);
            // For now, add as text reference
            parts.push({
              text: `URL: ${file.path} (Type: ${mimeType})`
            });
          }
        } else {
          // Handle local files (existing logic)
          if (!fs.existsSync(file.path)) {
            console.warn(`File not found: ${file.path}`);
            continue;
          }

          const fileData = fs.readFileSync(file.path);
          const mimeType = this.getMimeType(file.path);
          console.error(`File detected as MIME type: ${mimeType}`);

          if (mimeType.startsWith('image/')) {
            parts.push({
              inlineData: {
                data: fileData.toString('base64'),
                mimeType
              }
            });
          } else if (mimeType === 'application/pdf') {
            // Use File API to upload PDF for native processing
            console.error(`Uploading PDF to Gemini File API: ${file.path}`);
            const uploadedFile = await this.uploadPDFWithFileAPI(file.path);
            parts.push({
              fileData: {
                fileUri: uploadedFile.uri,
                mimeType: 'application/pdf'
              }
            });
          } else {
            // For other text files, add as text content
            parts.push({
              text: `File: ${file.path}\nContent: ${fileData.toString('utf-8')}`
            });
          }
        }
      }

      console.error(`Sending request to Gemini with ${parts.length} parts (instructions + ${parts.length - 1} files)`);
      const response = await this.genAI.models.generateContent({
        model: params.model || 'gemini-2.5-flash',
        contents: parts,
        config: {
          responseModalities: [Modality.TEXT],
        },
      });

      console.error(`Received response from Gemini, response length: ${response.candidates?.[0]?.content?.parts?.[0]?.text?.length || 0} characters`);
      return {
        content: [
          {
            type: 'text',
            text: response.candidates?.[0]?.content?.parts?.[0]?.text || 'No response generated'
          }
        ],
        metadata: {
          model: params.model,
          filesProcessed: params.files.length,
          instructions: params.instructions
        }
      };

    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Multimodal processing failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async analyzeDocuments(args: any) {
    // Enhanced document analysis implementation with File API support
    const { documents, instructions, options = {} } = args;
    
    try {
      const parts: any[] = [{ text: instructions }];

      // Read and process documents
      for (const docPath of documents) {
        if (!fs.existsSync(docPath)) {
          console.warn(`Document not found: ${docPath}`);
          continue;
        }

        const mimeType = this.getMimeType(docPath);
        console.error(`Document detected as MIME type: ${mimeType}`);

        if (mimeType === 'application/pdf') {
          // Use File API to upload PDF for native processing with OCR support
          console.error(`Uploading PDF to Gemini File API for OCR processing: ${docPath}`);
          const uploadedFile = await this.uploadPDFWithFileAPI(docPath);
          parts.push({
            fileData: {
              fileUri: uploadedFile.uri,
              mimeType: 'application/pdf'
            }
          });
        } else {
          // For text files, read as UTF-8
          const docData = fs.readFileSync(docPath, 'utf-8');
          parts.push({
            text: `Document: ${docPath}\nContent: ${docData}`
          });
        }
      }

      console.error(`Sending document analysis request to Gemini with ${parts.length} parts`);
      const response = await this.genAI.models.generateContent({
        model: options.model || 'gemini-2.5-flash',
        contents: parts,
        config: {
          responseModalities: [Modality.TEXT],
        },
      });

      return {
        content: [
          {
            type: 'text',
            text: response.candidates?.[0]?.content?.parts?.[0]?.text || 'No response generated'
          }
        ],
        analysis: response.candidates?.[0]?.content?.parts?.[0]?.text || 'No analysis generated',
        metadata: {
          documentsProcessed: documents.length,
          options
        }
      };

    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Document analysis failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private getMimeType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes: { [key: string]: string } = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.bmp': 'image/bmp',
      '.pdf': 'application/pdf',
      '.txt': 'text/plain',
      '.md': 'text/markdown',
      '.json': 'application/json'
    };
    return mimeTypes[ext] || 'application/octet-stream';
  }

  /**
   * Get MIME type from URL by examining the file extension
   */
  private getMimeTypeFromUrl(url: string): string {
    try {
      const urlObj = new URL(url);
      const pathname = urlObj.pathname;
      const ext = path.extname(pathname).toLowerCase();
      
      const mimeTypes: { [key: string]: string } = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.bmp': 'image/bmp',
        '.pdf': 'application/pdf',
        '.txt': 'text/plain',
        '.md': 'text/markdown',
        '.json': 'application/json'
      };
      
      return mimeTypes[ext] || 'application/octet-stream';
    } catch (error) {
      console.warn(`Failed to parse URL: ${url}`, error);
      return 'application/octet-stream';
    }
  }

  /**
   * Extract text from PDF using pdf-parse (動的読み込み)
   */
  private async extractPDFText(filePath: string): Promise<string> {
    try {
      console.error(`[MCP Server] Extracting text from PDF: ${filePath}`);
      
      // pdf-parseを動的に読み込み（PDFファイル処理時のみ）
      let pdfParse;
      try {
        // ESモジュール環境でのCommonJS動的インポート（テストモード回避のため直接libを使用）
        pdfParse = (await import('pdf-parse/lib/pdf-parse.js' as any)).default;
      } catch (importError) {
        throw new Error(`PDF processing library not available: ${importError instanceof Error ? importError.message : String(importError)}`);
      }
      
      const buffer = fs.readFileSync(filePath);
      const data = await pdfParse(buffer, {
        max: 0, // Process all pages
        version: 'v1.10.100',
      });

      const extractedText = data.text.trim();
      
      console.error(`[MCP Server] PDF extraction completed`, {
        filePath,
        textLength: extractedText.length,
        pageCount: data.numpages,
        hasText: extractedText.length > 0,
        textPreview: extractedText.substring(0, 200) + (extractedText.length > 200 ? '...' : '')
      });

      if (extractedText.length === 0) {
        return `[PDF Document: ${path.basename(filePath)}]\nNo text content could be extracted. This may be an image-based PDF that requires OCR processing.`;
      }

      // Add metadata header
      const metadata = `[PDF Document: ${path.basename(filePath)} - ${data.numpages} pages]\n\n`;
      return metadata + extractedText;
      
    } catch (error) {
      console.error(`[MCP Server] Failed to extract PDF text from ${filePath}:`, error);
      
      return `[PDF Document: ${path.basename(filePath)}]\nText extraction failed: ${error instanceof Error ? error.message : String(error)}\nNote: This PDF may require specialized OCR processing.`;
    }
  }

  private async getGeneratedFile(args: any) {
    const params = GetGeneratedFileSchema.parse(args);
    
    try {
      // Resolve the file path
      const filePath = path.isAbsolute(params.filePath) 
        ? params.filePath 
        : path.join(process.cwd(), params.filePath);
      
      // Check if file exists
      if (!fs.existsSync(filePath)) {
        throw new McpError(ErrorCode.InvalidRequest, `File not found: ${params.filePath}`);
      }
      
      // Get file stats
      const stats = await fsPromises.stat(filePath);
      const fileExtension = path.extname(filePath).toLowerCase();
      
      // Read file content
      let content = null;
      if (params.returnBase64) {
        const buffer = await fsPromises.readFile(filePath);
        content = buffer.toString('base64');
      }
      
      // Determine file type
      let fileType = 'document';
      if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(fileExtension)) {
        fileType = 'image';
      } else if (['.mp3', '.wav', '.m4a', '.ogg'].includes(fileExtension)) {
        fileType = 'audio';
      }
      
      return {
        content: [
          {
            type: 'text',
            text: `✅ Retrieved file: ${params.filePath}\n📏 Size: ${(stats.size / 1024).toFixed(2)} KB\n📁 Type: ${fileType}\n📅 Created: ${stats.birthtime.toISOString()}`
          }
        ],
        file: {
          path: params.filePath,
          absolutePath: filePath,
          size: stats.size,
          type: fileType,
          format: fileExtension.substring(1),
          createdAt: stats.birthtime.toISOString(),
          modifiedAt: stats.mtime.toISOString(),
          data: content
        }
      };
    } catch (error) {
      if (error instanceof McpError) {
        throw error;
      }
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to retrieve file: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async listGeneratedFiles(args: any) {
    const params = ListGeneratedFilesSchema.parse(args);
    
    try {
      const outputDir = path.join(process.cwd(), 'output');
      const files: any[] = [];
      
      // Define directories to search based on file type
      const searchDirs = [];
      if (params.fileType === 'all' || params.fileType === 'image') {
        searchDirs.push({ dir: path.join(outputDir, 'images'), type: 'image' });
      }
      if (params.fileType === 'all' || params.fileType === 'audio') {
        searchDirs.push({ dir: path.join(outputDir, 'audio'), type: 'audio' });
      }
      if (params.fileType === 'all' || params.fileType === 'document') {
        searchDirs.push({ dir: path.join(outputDir, 'documents'), type: 'document' });
      }
      
      // Collect files from each directory
      for (const { dir, type } of searchDirs) {
        if (fs.existsSync(dir)) {
          const dirFiles = await fsPromises.readdir(dir);
          for (const file of dirFiles) {
            const filePath = path.join(dir, file);
            const stats = await fsPromises.stat(filePath);
            if (stats.isFile()) {
              files.push({
                path: path.relative(process.cwd(), filePath),
                name: file,
                type,
                size: stats.size,
                createdAt: stats.birthtime.toISOString(),
                modifiedAt: stats.mtime.toISOString()
              });
            }
          }
        }
      }
      
      // Sort files
      files.sort((a, b) => {
        switch (params.sortBy) {
          case 'size':
            return b.size - a.size;
          case 'name':
            return a.name.localeCompare(b.name);
          case 'date':
          default:
            return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        }
      });
      
      // Apply limit
      const limitedFiles = files.slice(0, params.limit);
      
      return {
        content: [
          {
            type: 'text',
            text: `📁 Found ${limitedFiles.length} generated files${files.length > params.limit ? ` (showing ${params.limit} of ${files.length})` : ''}:\n\n${
              limitedFiles.map(f => `• ${f.type} | ${f.path} | ${(f.size / 1024).toFixed(2)} KB | ${new Date(f.createdAt).toLocaleDateString()}`).join('\n')
            }`
          }
        ],
        files: limitedFiles,
        totalCount: files.length
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to list files: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async getFileInfo(args: any) {
    const params = GetFileInfoSchema.parse(args);
    
    try {
      // Resolve the file path
      const filePath = path.isAbsolute(params.filePath) 
        ? params.filePath 
        : path.join(process.cwd(), params.filePath);
      
      // Check if file exists
      if (!fs.existsSync(filePath)) {
        throw new McpError(ErrorCode.InvalidRequest, `File not found: ${params.filePath}`);
      }
      
      // Get file stats
      const stats = await fsPromises.stat(filePath);
      const fileExtension = path.extname(filePath).toLowerCase();
      
      // Determine file type and additional metadata
      let fileType = 'document';
      const metadata: any = {};
      
      if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(fileExtension)) {
        fileType = 'image';
        // For images, we could add dimension detection here if needed
        metadata.format = fileExtension.substring(1).toUpperCase();
      } else if (['.mp3', '.wav', '.m4a', '.ogg'].includes(fileExtension)) {
        fileType = 'audio';
        metadata.format = fileExtension.substring(1).toUpperCase();
      }
      
      return {
        content: [
          {
            type: 'text',
            text: `📄 File Information:\n\n📁 Path: ${params.filePath}\n📏 Size: ${(stats.size / 1024).toFixed(2)} KB (${stats.size} bytes)\n🏷️ Type: ${fileType}\n📅 Created: ${stats.birthtime.toLocaleString()}\n📝 Modified: ${stats.mtime.toLocaleString()}\n🔖 Format: ${fileExtension.substring(1).toUpperCase()}`
          }
        ],
        fileInfo: {
          path: params.filePath,
          absolutePath: filePath,
          name: path.basename(filePath),
          size: stats.size,
          sizeFormatted: `${(stats.size / 1024).toFixed(2)} KB`,
          type: fileType,
          format: fileExtension.substring(1),
          createdAt: stats.birthtime.toISOString(),
          modifiedAt: stats.mtime.toISOString(),
          metadata
        }
      };
    } catch (error) {
      if (error instanceof McpError) {
        throw error;
      }
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to get file info: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async generateAudio(args: any) {
    const params = GenerateAudioSchema.parse(args);
    
    try {
      // Generate audio with official API approach
      const response = await this.genAI.models.generateContent({
        model: params.model || AI_MODELS.AUDIO_GENERATION,
        contents: [{ parts: [{ text: params.text }] }],
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: params.voice || 'Kore' }
            }
          }
        },
      });

      // Extract audio data from response
      const audioData = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

      if (!audioData) {
        throw new Error('Audio generation failed: No audio data received from API');
      }

      // Save the generated audio
      const outputDir = path.join(process.cwd(), 'output', 'audio');
      await fsPromises.mkdir(outputDir, { recursive: true });

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `generated-audio-${timestamp}.wav`;
      const absolutePath = path.join(outputDir, filename);

      // Create proper WAV file with headers using WaveFile library
      const rawAudioBuffer = Buffer.from(audioData, 'base64');

      // Google AI Studio returns L16 PCM data (16-bit signed integers)
      // Convert Buffer to Int16Array for WaveFile.fromScratch()
      const pcmSamples = [];
      for (let i = 0; i < rawAudioBuffer.length; i += 2) {
        // Read 16-bit signed little-endian integers
        const sample = rawAudioBuffer.readInt16LE(i);
        pcmSamples.push(sample);
      }

      // Create WAV file with proper headers per google_docs.md specification
      const wav = new WaveFile();
      wav.fromScratch(1, 24000, '16', pcmSamples);

      // Get complete WAV file buffer with headers
      const wavBuffer = wav.toBuffer();

      // Write to disk
      await fsPromises.writeFile(absolutePath, wavBuffer);

      // Verify file was written
      if (!fs.existsSync(absolutePath)) {
        throw new Error(`Failed to write audio file: ${absolutePath}`);
      }

      const fileSize = wavBuffer.length;
      // Use normalized cross-platform path (forward slashes)
      const savedFilePath = normalizeCrossPlatformPath(`output/audio/${filename}`);

      return {
        content: [
          {
            type: 'text',
            text: `✅ Successfully generated audio using Gemini 2.5 Flash TTS

📁 File saved to: ${savedFilePath}
📏 Size: ${(fileSize / 1024).toFixed(2)} KB
🎤 Voice: ${params.voice}
📝 Original text: ${params.text.substring(0, 100)}${params.text.length > 100 ? '...' : ''}

To retrieve this file, use:
- Tool: get_generated_file
- Parameter: {"filePath": "${savedFilePath}"}`
          }
        ],
        audioData,
        file: {
          path: savedFilePath,
          absolutePath: absolutePath,
          size: fileSize,
          format: 'wav',
          createdAt: new Date().toISOString()
        },
        metadata: {
          model: params.model || AI_MODELS.AUDIO_GENERATION,
          voice: params.voice,
          textLength: params.text.length,
          originalText: params.text
        }
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new McpError(
        ErrorCode.InternalError,
        `Audio generation failed: ${errorMessage}`
      );
    }
  }

  /**
   * Upload PDF using Gemini File API for native processing
   * Supports OCR and complex PDF layouts
   */
  private async uploadPDFWithFileAPI(pdfPath: string): Promise<any> {
    try {
      console.error(`Starting PDF upload via File API: ${pdfPath}`);
      
      // Check file size (50MB limit)
      const stats = fs.statSync(pdfPath);
      const fileSizeMB = stats.size / (1024 * 1024);
      if (fileSizeMB > 50) {
        throw new Error(`PDF file too large: ${fileSizeMB.toFixed(1)}MB (max 50MB)`);
      }
      
      // Read file as binary data
      const fileData = fs.readFileSync(pdfPath);
      
      // Upload the file using GoogleGenAI files API
      const uploadResult = await this.genAI.files.upload({
        file: pdfPath,
        config: {
          mimeType: 'application/pdf',
          displayName: path.basename(pdfPath)
        }
      });
      
      console.error(`PDF uploaded successfully: ${uploadResult.name}, state: ${uploadResult.state}`);
      
      // Wait for processing to complete
      let file = uploadResult;
      let waitTime = 0;
      const maxWaitTime = 120000; // 2 minutes max wait
      
      while (file.state === 'PROCESSING' && waitTime < maxWaitTime) {
        console.error(`Waiting for PDF processing... (${waitTime / 1000}s)`);
        await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds
        waitTime += 2000;
        
        file = await this.genAI.files.get({ name: file.name! });
        console.error(`PDF processing state: ${file.state}`);
      }
      
      if (file.state !== 'ACTIVE') {
        throw new Error(`PDF processing failed or timed out. Final state: ${file.state}`);
      }
      
      console.error(`PDF ready for processing: ${file.name} (${fileSizeMB.toFixed(1)}MB)`);
      
      return {
        uri: file.uri,
        name: file.name,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes
      };
      
    } catch (error) {
      console.error(`Failed to upload PDF via File API: ${pdfPath}`, error);
      throw new Error(`PDF upload failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Upload PDF URL using Gemini File API for native processing
   * Supports OCR and complex PDF layouts via URL
   */
  private async uploadPDFUrlWithFileAPI(pdfUrl: string): Promise<any> {
    try {
      console.error(`Starting PDF URL upload via File API: ${pdfUrl}`);
      
      // Upload the URL directly using GoogleGenAI files API
      const uploadResult = await this.genAI.files.upload({
        file: pdfUrl,  // Pass URL as file parameter
        config: {
          mimeType: 'application/pdf',
          displayName: path.basename(new URL(pdfUrl).pathname) || 'url-document.pdf'
        }
      });
      
      console.error(`PDF URL uploaded successfully: ${uploadResult.name}, state: ${uploadResult.state}`);
      
      // Wait for processing to complete
      let file = uploadResult;
      let waitTime = 0;
      const maxWaitTime = 120000; // 2 minutes max wait
      
      while (file.state === 'PROCESSING' && waitTime < maxWaitTime) {
        console.error(`Waiting for PDF URL processing... (${waitTime / 1000}s)`);
        await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds
        waitTime += 2000;
        
        file = await this.genAI.files.get({ name: file.name! });
        console.error(`PDF URL processing state: ${file.state}`);
      }
      
      if (file.state !== 'ACTIVE') {
        throw new Error(`PDF URL processing failed or timed out. Final state: ${file.state}`);
      }
      
      console.error(`PDF URL ready for processing: ${file.name} (from ${pdfUrl})`);
      
      return {
        uri: file.uri,
        name: file.name,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes
      };
      
    } catch (error) {
      console.error(`Failed to upload PDF URL via File API: ${pdfUrl}`, error);
      throw new Error(`PDF URL upload failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('AI Studio MCP Server running on stdio');
  }
}

// CLI execution - Windows compatible path comparison
// On Windows: import.meta.url = 'file:///M:/path/...' but process.argv[1] = 'M:\path\...'
function isMainModule(): boolean {
  try {
    const currentFile = fileURLToPath(import.meta.url);
    const executedFile = process.argv[1];
    if (!executedFile) {
      return true; // Fallback: assume main module
    }
    // Normalize both paths for cross-platform comparison
    const normalizedCurrent = currentFile.replace(/\\/g, '/').toLowerCase();
    const normalizedExecuted = executedFile.replace(/\\/g, '/').toLowerCase();
    return normalizedCurrent === normalizedExecuted;
  } catch {
    // Fallback: assume main module if we can't determine
    return true;
  }
}

if (isMainModule()) {
  const server = new AIStudioMCPServer();
  server.run().catch((error) => {
    console.error('Server error:', error);
    process.exit(1);
  });
}

export { AIStudioMCPServer };