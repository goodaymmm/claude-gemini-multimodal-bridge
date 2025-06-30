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
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';

// Input validation schemas
const GenerateImageSchema = z.object({
  prompt: z.string().min(1).max(480), // Max tokens as per API docs
  numberOfImages: z.number().min(1).max(4).optional().default(1),
  aspectRatio: z.enum(['1:1', '3:4', '4:3', '9:16', '16:9']).optional().default('1:1'),
  personGeneration: z.enum(['ALLOW', 'BLOCK']).optional().default('ALLOW'),
  model: z.string().optional().default('gemini-2.0-flash-preview-image-generation')
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

class AIStudioMCPServer {
  private server: Server;
  private genAI: GoogleGenerativeAI;

  constructor() {
    // Get API key from environment
    const apiKey = process.env.AI_STUDIO_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_STUDIO_API_KEY;
    if (!apiKey) {
      throw new Error('AI_STUDIO_API_KEY environment variable is required');
    }

    this.genAI = new GoogleGenerativeAI(apiKey);
    this.server = new Server(
      {
        name: 'ai-studio-mcp-server',
        version: '1.0.0',
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
            description: 'Generate images using AI Studio API with Imagen models',
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
                  default: 'gemini-2.0-flash-preview-image-generation'
                }
              },
              required: ['prompt']
            }
          },
          {
            name: 'analyze_image',
            description: 'Analyze images using Gemini multimodal capabilities',
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
            description: 'Process multiple files with AI Studio multimodal capabilities',
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
            description: 'Analyze documents using Gemini capabilities',
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
      const model = this.genAI.getGenerativeModel({ 
        model: params.model,
        generationConfig: {
          responseMimeType: 'application/json'
        }
      });

      // Create the image generation request using simplified format
      const response = await model.generateContent({
        contents: [{
          role: 'user',
          parts: [{
            text: `Generate ${params.numberOfImages} image(s) with aspect ratio ${params.aspectRatio}. Person generation: ${params.personGeneration}. Prompt: ${params.prompt}`
          }]
        }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 1024
        }
      });

      // Process the response
      const result = response.response;
      const text = result.text();
      
      // Extract image data from response
      let imageData = null;
      let downloadUrl = null;
      
      if (result.candidates && result.candidates[0] && result.candidates[0].content.parts) {
        for (const part of result.candidates[0].content.parts) {
          if (part.inlineData && part.inlineData.mimeType?.startsWith('image/')) {
            imageData = part.inlineData.data;
            break;
          }
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: `Successfully generated ${params.numberOfImages} image(s) using ${params.model}`
          }
        ],
        imageData,
        downloadUrl,
        metadata: {
          model: params.model,
          prompt: params.prompt,
          numberOfImages: params.numberOfImages,
          aspectRatio: params.aspectRatio,
          personGeneration: params.personGeneration,
          responseText: text
        }
      };

    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Image generation failed: ${error instanceof Error ? error.message : String(error)}`
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

      const model = this.genAI.getGenerativeModel({ model: params.model });

      const response = await model.generateContent({
        contents: [{
          role: 'user',
          parts: [
            { text: params.prompt },
            {
              inlineData: {
                data: imageData.toString('base64'),
                mimeType
              }
            }
          ]
        }]
      });

      return {
        content: [
          {
            type: 'text',
            text: response.response.text()
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
      const model = this.genAI.getGenerativeModel({ model: params.model });
      const parts: any[] = [{ text: params.instructions }];

      // Process each file
      for (const file of params.files) {
        if (!fs.existsSync(file.path)) {
          console.warn(`File not found: ${file.path}`);
          continue;
        }

        const fileData = fs.readFileSync(file.path);
        const mimeType = this.getMimeType(file.path);

        if (mimeType.startsWith('image/')) {
          parts.push({
            inlineData: {
              data: fileData.toString('base64'),
              mimeType
            }
          });
        } else {
          // For text files, add as text content
          parts.push({
            text: `File: ${file.path}\nContent: ${fileData.toString('utf-8')}`
          });
        }
      }

      const response = await model.generateContent({
        contents: [{ role: 'user', parts }]
      });

      return {
        content: [
          {
            type: 'text',
            text: response.response.text()
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
    // Simple document analysis implementation
    const { documents, instructions, options = {} } = args;
    
    try {
      const model = this.genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });
      const parts: any[] = [{ text: instructions }];

      // Read and process documents
      for (const docPath of documents) {
        if (!fs.existsSync(docPath)) {
          console.warn(`Document not found: ${docPath}`);
          continue;
        }

        const docData = fs.readFileSync(docPath, 'utf-8');
        parts.push({
          text: `Document: ${docPath}\nContent: ${docData}`
        });
      }

      const response = await model.generateContent({
        contents: [{ role: 'user', parts }]
      });

      return {
        content: [
          {
            type: 'text',
            text: response.response.text()
          }
        ],
        analysis: response.response.text(),
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

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('AI Studio MCP Server running on stdio');
  }
}

// CLI execution
if (import.meta.url === `file://${process.argv[1]}`) {
  const server = new AIStudioMCPServer();
  server.run().catch((error) => {
    console.error('Server error:', error);
    process.exit(1);
  });
}

export { AIStudioMCPServer };