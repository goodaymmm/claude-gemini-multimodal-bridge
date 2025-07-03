import {
  AnalysisType,
  DocumentAnalysisArgs,
  DocumentAnalysisResult,
  FileReference,
  LayerResult,
  ReasoningTask,
} from '../core/types.js';
import { LayerManager } from '../core/LayerManager.js';
import { ClaudeCodeLayer } from '../layers/ClaudeCodeLayer.js';
import { GeminiCLILayer } from '../layers/GeminiCLILayer.js';
import { AIStudioLayer } from '../layers/AIStudioLayer.js';
import { logger } from '../utils/logger.js';
import { retry, safeExecute } from '../utils/errorHandler.js';
import { AuthVerifier } from '../auth/AuthVerifier.js';
import path from 'path';
import fs from 'fs/promises';
// pdf-parse は extractPDFWithPdfParse() メソッド内で動的に読み込みます（フォールバック時のみ）

/**
 * DocumentAnalysis tool provides advanced document analysis capabilities
 * Combines all three layers for comprehensive document understanding and processing
 */
export class DocumentAnalysis {
  private layerManager: LayerManager;
  private claudeLayer: ClaudeCodeLayer;
  private geminiLayer: GeminiCLILayer;
  private aiStudioLayer: AIStudioLayer;
  private authVerifier: AuthVerifier;
  
  private readonly MAX_DOCUMENTS = 20;
  private readonly MAX_DOCUMENT_SIZE = 50 * 1024 * 1024; // 50MB per document
  private readonly SUPPORTED_DOCUMENT_TYPES = [
    '.pdf', '.txt', '.md', '.doc', '.docx', '.rtf', '.odt',
    '.ppt', '.pptx', '.odp', '.xls', '.xlsx', '.ods', '.csv'
  ];

  constructor() {
    // Create default config for LayerManager
    const defaultConfig = {
      gemini: { api_key: '', model: 'gemini-2.5-pro', timeout: 60000, max_tokens: 16384, temperature: 0.2 },
      claude: { code_path: '/usr/local/bin/claude', timeout: 300000 },
      aistudio: { enabled: true, max_files: 10, max_file_size: 100 },
      cache: { enabled: true, ttl: 3600 },
      logging: { level: 'info' as const },
    };
    this.layerManager = new LayerManager(defaultConfig);
    this.claudeLayer = new ClaudeCodeLayer();
    this.geminiLayer = new GeminiCLILayer();
    this.aiStudioLayer = new AIStudioLayer();
    this.authVerifier = new AuthVerifier();
  }

  /**
   * Perform comprehensive document analysis
   */
  async analyzeDocuments(args: DocumentAnalysisArgs): Promise<DocumentAnalysisResult> {
    return safeExecute(
      async () => {
        const startTime = Date.now();
        
        logger.info('Starting document analysis', {
          documentCount: args.documents.length,
          analysisType: args.analysis_type,
          requiresComparison: args.analysis_type === 'comparison',
        });

        // Validate inputs
        await this.validateAnalysisArgs(args);
        
        // Initialize required layers
        await this.initializeLayers(args);
        
        // Convert document paths to FileReference objects
        const documentRefs = this.convertPathsToFileRefs(args.documents);
        
        // Prepare documents for analysis
        const processedDocs = await this.prepareDocuments(documentRefs);
        
        // Execute analysis based on type
        const analysisResult = await this.executeAnalysis(args, processedDocs);
        
        // Generate comprehensive summary if multiple documents
        const summary = args.documents.length > 1 
          ? await this.generateSummary(analysisResult, args)
          : null;
        
        const totalDuration = Date.now() - startTime;
        
        return {
          success: true,
          analysis_type: args.analysis_type,
          content: typeof analysisResult === 'string' ? analysisResult : JSON.stringify(analysisResult),
          documents_processed: args.documents,
          processing_time: totalDuration,
          insights: await this.generateInsights(analysisResult, args),
          metadata: {
            total_duration: totalDuration,
            tokens_used: this.estimateTokensUsed(analysisResult),
            cost: 0,
            quality_score: 0.8,
          },
        };
      },
      {
        operationName: 'document-analysis',
        layer: 'tool',
        timeout: 900000, // 15 minutes for complex analysis
      }
    );
  }

  /**
   * Analyze single document with detailed examination
   */
  async analyzeSingleDocument(
    documentPath: string,
    analysisType: AnalysisType = 'comprehensive',
    options?: { depth?: 'shallow' | 'medium' | 'deep'; extractImages?: boolean }
  ): Promise<DocumentAnalysisResult> {
    return this.analyzeDocuments({
      documents: [documentPath],
      analysis_type: 'summary',
      options: {
        depth: options?.depth || 'medium',
        extractMetadata: options?.extractImages || false,
      },
    });
  }

  /**
   * Compare multiple documents
   */
  async compareDocuments(
    documentPaths: string[],
    comparisonType: 'similarity' | 'differences' | 'comprehensive' = 'comprehensive'
  ): Promise<DocumentAnalysisResult> {
    if (documentPaths.length < 2) {
      throw new Error('At least 2 documents required for comparison');
    }

    return this.analyzeDocuments({
      documents: documentPaths,
      analysis_type: 'comparison',
      options: {
        depth: 'deep',
        detailed: true,
      },
    });
  }

  /**
   * Extract structured data from documents
   */
  async extractStructuredData(
    documentPaths: string[],
    dataTypes: string[] = ['tables', 'lists', 'key-value-pairs', 'entities']
  ): Promise<DocumentAnalysisResult> {
    return this.analyzeDocuments({
      documents: documentPaths,
      analysis_type: 'extraction',
      options: {
        depth: 'deep',
        structured: true,
        extractionType: dataTypes.join(','),
      },
    });
  }

  /**
   * Summarize documents with key insights
   */
  async summarizeDocuments(
    documentPaths: string[],
    summaryLength: 'brief' | 'detailed' | 'comprehensive' = 'detailed'
  ): Promise<DocumentAnalysisResult> {
    return this.analyzeDocuments({
      documents: documentPaths,
      analysis_type: 'summary',
      options: {
        depth: summaryLength === 'comprehensive' ? 'deep' : 'medium',
        detailed: summaryLength !== 'brief',
      },
    });
  }

  /**
   * Extract text from PDF using Gemini API File API (recommended by Google)
   * Falls back to pdf-parse for compatibility
   */
  private async extractPDFText(pdfPath: string): Promise<string> {
    // Try Gemini API File API first (recommended approach)
    try {
      const geminiResult = await this.extractPDFWithGeminiFileAPI(pdfPath);
      if (geminiResult && geminiResult.length > 0) {
        logger.info('PDF extraction completed using Gemini File API', {
          pdfPath,
          textLength: geminiResult.length,
          textPreview: geminiResult.substring(0, 100) + (geminiResult.length > 100 ? '...' : '')
        });
        return geminiResult;
      }
    } catch (geminiError) {
      logger.warn('Gemini File API extraction failed, falling back to pdf-parse', {
        pdfPath,
        error: geminiError instanceof Error ? geminiError.message : String(geminiError)
      });
    }

    // Fallback to traditional pdf-parse extraction
    return this.extractPDFWithPdfParse(pdfPath);
  }

  /**
   * Extract PDF using Gemini API File API (Official recommendation)
   * Supports up to 50MB files and 1,000 pages with native vision processing
   */
  private async extractPDFWithGeminiFileAPI(pdfPath: string): Promise<string> {
    try {
      logger.info('Extracting PDF with Gemini File API', { pdfPath });
      
      // Check file size - Gemini API supports up to 50MB
      const stats = await fs.stat(pdfPath);
      if (stats.size > 50 * 1024 * 1024) {
        throw new Error(`PDF file too large for Gemini File API: ${Math.round(stats.size / 1024 / 1024)}MB (max 50MB)`);
      }

      await this.aiStudioLayer.initialize();
      
      // Use AI Studio layer for direct Gemini API access
      const result = await this.aiStudioLayer.execute({
        action: 'multimodal_processing',
        files: [{
          path: pdfPath,
          type: 'document',
          encoding: 'binary'
        }],
        instructions: `Extract all text content from this PDF document using native vision processing. 
Follow these guidelines:
1. Process all pages (up to 1,000 pages supported)
2. Each page equals approximately 258 tokens
3. Preserve document structure and formatting
4. Extract both text and analyze any images within the PDF
5. Provide comprehensive content understanding
6. Focus on accuracy and completeness

Please extract the complete text content while maintaining readability and structure.`
      });

      if (result.success && result.data) {
        const extractedText = typeof result.data === 'string' ? result.data : 
          (result.data.content && typeof result.data.content === 'string') ? result.data.content :
          JSON.stringify(result.data);

        const metadata = `[PDF Document: ${path.basename(pdfPath)} - Processed with Gemini File API]\n\n`;
        return metadata + extractedText.trim();
      } else {
        throw new Error(result.error || 'Failed to extract PDF with Gemini File API');
      }
    } catch (error) {
      logger.error('Gemini File API PDF extraction failed', {
        pdfPath,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Extract text from PDF using pdf-parse for better analysis (fallback method)
   */
  private async extractPDFWithPdfParse(pdfPath: string): Promise<string> {
    try {
      logger.info('Extracting PDF with pdf-parse (fallback)', { pdfPath });
      
      // pdf-parseを動的に読み込み（Gemini File APIフォールバック時のみ）
      let pdfParse;
      try {
        // ESモジュール環境でのCommonJS動的インポート（テストモード回避のため直接libを使用）
        pdfParse = (await import('pdf-parse/lib/pdf-parse.js' as any)).default;
      } catch (importError) {
        throw new Error(`PDF processing library not available: ${importError instanceof Error ? importError.message : String(importError)}`);
      }
      
      const buffer = await fs.readFile(pdfPath);
      const data = await pdfParse(buffer, {
        // PDF parsing options optimized for Japanese content
        max: 0, // Process all pages
        version: 'v1.10.100', // Use specific version for compatibility
        pagerender: (pageData: any) => {
          // Enhanced page rendering for Japanese text and better structure
          let renderOptions = {
            normalizeWhitespace: false,
            disableCombineTextItems: false,
            includeMarkedContent: true, // Include tagged content for better structure
            textFilter: undefined // No text filtering to preserve all content
          };
          return pageData.getTextContent(renderOptions)
            .then((textContent: any) => {
              let lastY, text = '';
              let lineSpacing = 0;
              
              for (let item of textContent.items) {
                // Improved line break detection for Japanese text
                if (lastY && Math.abs(lastY - item.transform[5]) > lineSpacing) {
                  // Add line break for significant Y position changes
                  text += '\n' + item.str;
                } else {
                  // Add space for horizontal text flow (but not for Japanese characters)
                  const needsSpace = lastY && lastY === item.transform[5] && 
                    !/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/.test(item.str) &&
                    !/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/.test(text.slice(-1));
                  text += (needsSpace ? ' ' : '') + item.str;
                }
                lastY = item.transform[5];
                // Update line spacing based on font size if available
                if (item.height) {
                  lineSpacing = Math.max(lineSpacing, item.height * 0.3);
                }
              }
              return text;
            });
        }
      });

      const extractedText = data.text.trim();
      
      // Enhanced debugging and diagnostic information
      logger.debug('PDF parsing details', {
        pdfPath,
        pageCount: data.numpages,
        hasMetadata: !!data.metadata,
        metadataKeys: data.metadata ? Object.keys(data.metadata) : [],
        textLength: data.text.length,
        extractedSample: data.text.substring(0, 200),
        hasInfo: !!data.info,
        infoKeys: data.info ? Object.keys(data.info) : [],
        version: data.version || 'unknown'
      });
      
      logger.info('PDF text extraction completed', {
        pdfPath,
        textLength: extractedText.length,
        pageCount: data.numpages,
        hasText: extractedText.length > 0,
        textPreview: extractedText.substring(0, 100) + (extractedText.length > 100 ? '...' : '')
      });

      // Check if extracted text is too short or likely incomplete
      const isTextExtractionPoor = extractedText.length < 100 || 
        (extractedText.length < data.numpages * 50); // Less than 50 chars per page average
      
      if (extractedText.length === 0 || isTextExtractionPoor) {
        logger.warn('Poor text extraction from PDF, attempting AI Studio OCR fallback', { 
          pdfPath, 
          textLength: extractedText.length,
          expectedMinLength: data.numpages * 50
        });
        
        // Try AI Studio OCR as fallback
        try {
          await this.aiStudioLayer.initialize();
          const ocrResult = await this.aiStudioLayer.execute({
            action: 'multimodal_processing',
            files: [{ 
              path: pdfPath, 
              type: 'document',
              encoding: 'binary'
            }],
            instructions: 'Extract all text content from this PDF document. Preserve the structure and formatting as much as possible. Focus on extracting the actual readable text content.',
          });
          
          if (ocrResult.success && ocrResult.data) {
            const ocrText = typeof ocrResult.data === 'string' ? ocrResult.data : 
              (ocrResult.data.content && typeof ocrResult.data.content === 'string') ? ocrResult.data.content :
              JSON.stringify(ocrResult.data);
            
            logger.info('AI Studio OCR fallback successful', {
              pdfPath,
              originalTextLength: extractedText.length,
              ocrTextLength: ocrText.length,
              improvement: ocrText.length > extractedText.length
            });
            
            // Use OCR result if it's significantly better
            if (ocrText.length > extractedText.length * 2) {
              const metadata = `[PDF Document: ${path.basename(pdfPath)} - ${data.numpages} pages - Processed with AI OCR]\n\n`;
              return metadata + ocrText.trim();
            }
          }
        } catch (ocrError) {
          logger.warn('AI Studio OCR fallback failed', {
            pdfPath,
            error: ocrError instanceof Error ? ocrError.message : String(ocrError)
          });
        }
        
        if (extractedText.length === 0) {
          return `[PDF Document: ${path.basename(pdfPath)}]\nNo text content could be extracted. This may be an image-based PDF or contain special formatting that requires OCR processing.`;
        }
      }

      // Add metadata header
      const metadata = `[PDF Document: ${path.basename(pdfPath)} - ${data.numpages} pages]\n\n`;
      return metadata + extractedText;
      
    } catch (error) {
      logger.error('Failed to extract PDF text', {
        pdfPath,
        error: error instanceof Error ? error.message : String(error)
      });
      
      // Return fallback indication
      return `[PDF Document: ${path.basename(pdfPath)}]\nText extraction failed: ${error instanceof Error ? error.message : String(error)}\nNote: This PDF may require specialized OCR processing or multimodal AI analysis.`;
    }
  }

  /**
   * Preprocess document for better analysis (handles PDF text extraction)
   */
  private async preprocessDocument(documentPath: string): Promise<{ path: string; content?: string }> {
    const ext = path.extname(documentPath).toLowerCase();
    
    if (ext === '.pdf') {
      const extractedText = await this.extractPDFText(documentPath);
      return {
        path: documentPath,
        content: extractedText
      };
    }
    
    // For other document types, return as-is for multimodal processing
    return { path: documentPath };
  }

  /**
   * Validate analysis arguments
   */
  private async validateAnalysisArgs(args: DocumentAnalysisArgs): Promise<void> {
    if (!args.documents || args.documents.length === 0) {
      throw new Error('At least one document must be provided');
    }

    if (args.documents.length > this.MAX_DOCUMENTS) {
      throw new Error(`Too many documents. Maximum ${this.MAX_DOCUMENTS} allowed`);
    }

    for (const doc of args.documents) {
      // Check file exists
      try {
        await fs.access(doc);
      } catch {
        throw new Error(`Document not found: ${doc}`);
      }

      // Check file size
      const stats = await fs.stat(doc);
      if (stats.size > this.MAX_DOCUMENT_SIZE) {
        throw new Error(`Document too large: ${doc} (max ${this.MAX_DOCUMENT_SIZE / 1024 / 1024}MB)`);
      }

      // Check file type
      const ext = path.extname(doc).toLowerCase();
      if (!this.SUPPORTED_DOCUMENT_TYPES.includes(ext)) {
        logger.warn('Potentially unsupported document type', { path: doc, extension: ext });
      }
    }
  }

  /**
   * Initialize required layers based on analysis requirements
   */
  private async initializeLayers(args: DocumentAnalysisArgs): Promise<void> {
    const requiredLayers = this.determineLayersUsed(args);
    
    const initPromises = [];
    
    if (requiredLayers.includes('claude')) {
      initPromises.push(this.claudeLayer.initialize());
    }
    
    if (requiredLayers.includes('gemini')) {
      initPromises.push(this.geminiLayer.initialize());
    }
    
    if (requiredLayers.includes('aistudio')) {
      initPromises.push(this.aiStudioLayer.initialize());
    }

    await Promise.all(initPromises);
    
    logger.debug('Initialized layers for document analysis', { layers: requiredLayers });
  }

  /**
   * Determine which layers are needed for the analysis
   */
  private determineLayersUsed(args: DocumentAnalysisArgs): string[] {
    const layers = new Set<string>();
    
    // Always use Claude for reasoning and synthesis
    layers.add('claude');
    
    // Use AI Studio for PDF processing and multimodal content
    const hasPDFs = args.documents.some(doc => 
      path.extname(doc).toLowerCase() === '.pdf'
    );
    
    if (hasPDFs || (args.options?.extractMetadata) || (args.options?.structured)) {
      layers.add('aistudio');
    }
    
    // Use Gemini for additional context or real-time information
    if ((args.options?.requiresGrounding)) {
      layers.add('gemini');
    }
    
    return Array.from(layers);
  }

  /**
   * Convert document paths to FileReference objects
   */
  private convertPathsToFileRefs(documentPaths: string[]): FileReference[] {
    return documentPaths.map(path => ({
      path,
      type: 'document' as any,
      encoding: 'utf-8',
    }));
  }

  /**
   * Prepare documents for analysis
   */
  private async prepareDocuments(documents: FileReference[]): Promise<FileReference[]> {
    return retry(
      async () => {
        const processedDocs: FileReference[] = [];

        for (const doc of documents) {
          const stats = await fs.stat(doc.path);
          const fileType = this.determineDocumentType(doc.path);
          
          // Preprocess document (handles PDF text extraction)
          const preprocessed = await this.preprocessDocument(doc.path);
          
          const processedDoc: FileReference = {
            ...doc,
            size: stats.size,
            type: 'document' as any,
            encoding: doc.encoding || 'utf-8',
            // Add extracted content for PDFs
            content: preprocessed.content,
          };

          processedDocs.push(processedDoc);
          
          logger.debug('Document prepared for analysis', {
            path: processedDoc.path,
            type: processedDoc.type,
            size: processedDoc.size,
            hasExtractedContent: !!preprocessed.content,
            contentLength: preprocessed.content?.length || 0
          });
        }

        return processedDocs;
      },
      {
        maxAttempts: 2,
        delay: 1000,
        operationName: 'prepare-documents',
      }
    );
  }

  /**
   * Determine document type for processing optimization
   */
  private determineDocumentType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    
    const typeMap: Record<string, string> = {
      '.pdf': 'pdf',
      '.doc': 'word',
      '.docx': 'word',
      '.txt': 'text',
      '.md': 'markdown',
      '.ppt': 'presentation',
      '.pptx': 'presentation',
      '.xls': 'spreadsheet',
      '.xlsx': 'spreadsheet',
      '.csv': 'csv',
    };
    
    return typeMap[ext] || 'document';
  }

  /**
   * Execute the analysis workflow
   */
  private async executeAnalysis(
    args: DocumentAnalysisArgs,
    documents: FileReference[]
  ): Promise<any> {
    return retry(
      async () => {
        logger.info('Executing document analysis workflow', {
          analysisType: args.analysis_type,
          documentCount: documents.length,
        });

        switch (args.analysis_type) {
          case 'summary':
            return await this.executeSummarizationAnalysis(documents, args);
          
          case 'extraction':
            return await this.executeExtractionAnalysis(documents, args);
          
          case 'comparison':
            return await this.executeComparativeAnalysis(documents, args);
          
          case 'translation':
            return await this.executeTranslationAnalysis(documents, args);
          
          default:
            return await this.executeGeneralAnalysis(documents, args);
        }
      },
      {
        maxAttempts: 3,
        delay: 3000,
        operationName: 'execute-analysis',
      }
    );
  }

  /**
   * Execute comprehensive analysis
   */
  private async executeComprehensiveAnalysis(
    documents: FileReference[],
    args: DocumentAnalysisArgs
  ): Promise<any> {
    const results = [];
    
    // Step 1: Process each document through AI Studio for content extraction
    for (const doc of documents) {
      const extractionResult = await this.aiStudioLayer.execute({
        action: 'document_analysis',
        files: [doc],
        instructions: 'Extract all content, structure, and metadata from this document. Provide detailed analysis.',
      });
      
      results.push({
        document: doc.path,
        extraction: extractionResult.data,
      });
    }
    
    // Step 2: Use Claude for deep reasoning and analysis
    const reasoningTask = {
      prompt: this.buildComprehensiveAnalysisPrompt(documents, results),
      depth: args.options?.depth ?? 'medium',
      domain: 'document_analysis',
      context: `Analyzing ${documents.length} document(s) for comprehensive understanding`,
    } as const;
    
    const reasoningResult = await this.claudeLayer.executeComplexReasoning(reasoningTask);
    
    // Step 3: Combine results
    return {
      documentExtractions: results,
      analysis: reasoningResult,
      processingType: 'comprehensive',
    };
  }

  /**
   * Execute summarization analysis
   */
  private async executeSummarizationAnalysis(
    documents: FileReference[],
    args: DocumentAnalysisArgs
  ): Promise<any> {
    const summaries = [];
    
    // Process each document for summarization
    for (const doc of documents) {
      const summaryResult = await this.aiStudioLayer.execute({
        action: 'document_analysis',
        files: [doc],
        instructions: `Summarize this document with ${args.options?.detailed ? 'detailed' : 'standard'} level of detail. Focus on key points, main arguments, and important information.`,
      });
      
      summaries.push({
        document: doc.path,
        summary: summaryResult.data,
      });
    }
    
    // Generate overall synthesis if multiple documents
    if (documents.length > 1) {
      const synthesisResult = await this.claudeLayer.synthesizeResponse({
        request: 'Create a comprehensive synthesis of all document summaries',
        inputs: {
          summaries: summaries.map(s => s.summary).join('\n\n'),
          documentCount: documents.length,
        },
      });
      
      return {
        individualSummaries: summaries,
        overallSynthesis: synthesisResult,
        processingType: 'summarization',
      };
    }
    
    return {
      individualSummaries: summaries,
      processingType: 'summarization',
    };
  }

  /**
   * Execute extraction analysis
   */
  private async executeExtractionAnalysis(
    documents: FileReference[],
    args: DocumentAnalysisArgs
  ): Promise<any> {
    const extractions = [];
    
    for (const doc of documents) {
      const extractionResult = await this.aiStudioLayer.execute({
        action: 'document_analysis',
        files: [doc],
        instructions: `Extract structured data from this document: ${args.options?.extractionType || 'tables,lists,entities'}. Provide organized, structured output.`,
      });
      
      extractions.push({
        document: doc.path,
        extractedData: extractionResult.data,
      });
    }
    
    // Organize and structure the extracted data
    const organizationResult = await this.claudeLayer.execute({
      action: 'synthesize_response',
      request: 'Organize and structure the extracted data into a comprehensive format',
      inputs: {
        extractions: extractions,
        dataTypes: args.options?.extractionType?.split(',') || [],
      },
    });
    
    return {
      rawExtractions: extractions,
      organizedData: organizationResult.data,
      processingType: 'extraction',
    };
  }

  /**
   * Execute comparative analysis
   */
  private async executeComparativeAnalysis(
    documents: FileReference[],
    args: DocumentAnalysisArgs
  ): Promise<any> {
    if (documents.length < 2) {
      throw new Error('Comparative analysis requires at least 2 documents');
    }
    
    // Extract content from all documents
    const documentContents = [];
    
    for (const doc of documents) {
      const extractionResult = await this.aiStudioLayer.execute({
        action: 'document_analysis',
        files: [doc],
        instructions: 'Extract all textual content and key information for comparison purposes.',
      });
      
      documentContents.push({
        document: doc.path,
        content: extractionResult.data,
      });
    }
    
    // Perform comparison analysis
    const comparisonResult = await this.claudeLayer.execute({
      action: 'complex_reasoning',
      prompt: this.buildComparisonPrompt(documentContents, 'comprehensive'),
      depth: 'deep',
    });
    
    return {
      documentContents,
      comparison: comparisonResult.data,
      processingType: 'comparative',
    };
  }

  /**
   * Execute contextual analysis
   */
  private async executeContextualAnalysis(
    documents: FileReference[],
    args: DocumentAnalysisArgs
  ): Promise<any> {
    // First, extract document content
    const documentData = [];
    
    for (const doc of documents) {
      const extractionResult = await this.aiStudioLayer.execute({
        action: 'document_analysis',
        files: [doc],
        instructions: 'Extract content for contextual analysis. Focus on topics, themes, and key information.',
      });
      
      documentData.push({
        document: doc.path,
        content: extractionResult.data,
      });
    }
    
    // Use Gemini for contextual grounding
    const contextualResult = await this.geminiLayer.execute({
      action: 'contextual_analysis',
      prompt: `Analyze these documents in current context and provide relevant background information: ${JSON.stringify(documentData)}`,
      useSearch: true,
    });
    
    // Synthesize with Claude
    const synthesisResult = await this.claudeLayer.synthesizeResponse({
      request: 'Combine document analysis with contextual information',
      inputs: {
        documentAnalysis: documentData,
        contextualInformation: contextualResult.data,
      },
    });
    
    return {
      documentData,
      contextualInformation: contextualResult.data,
      synthesis: synthesisResult,
      processingType: 'contextual',
    };
  }

  /**
   * Execute translation analysis
   */
  private async executeTranslationAnalysis(
    documents: FileReference[],
    args: DocumentAnalysisArgs
  ): Promise<any> {
    const translations = [];
    
    for (const doc of documents) {
      const translationResult = await this.aiStudioLayer.execute({
        action: 'document_analysis',
        files: [doc],
        instructions: `Translate this document. Focus on accurate translation while preserving meaning and context.`,
      });
      
      translations.push({
        document: doc.path,
        translation: translationResult.data,
      });
    }
    
    return {
      translations,
      processingType: 'translation',
    };
  }

  /**
   * Execute general analysis
   */
  private async executeGeneralAnalysis(
    documents: FileReference[],
    args: DocumentAnalysisArgs
  ): Promise<any> {
    const results = [];
    
    for (const doc of documents) {
      const analysisResult = await this.aiStudioLayer.execute({
        action: 'document_analysis',
        files: [doc],
        instructions: 'Perform general analysis of this document. Identify key information, themes, and structure.',
      });
      
      results.push({
        document: doc.path,
        analysis: analysisResult.data,
      });
    }
    
    return {
      analyses: results,
      processingType: 'general',
    };
  }

  /**
   * Generate comprehensive summary
   */
  private async generateSummary(analysisResult: any, args: DocumentAnalysisArgs): Promise<string> {
    return retry(
      async () => {
        const summaryPrompt = `Generate a comprehensive summary of the document analysis results. Include key findings, important insights, and main conclusions. Analysis type: ${args.analysis_type}`;
        
        const summaryResult = await this.claudeLayer.synthesizeResponse({
          request: summaryPrompt,
          inputs: {
            analysisResults: analysisResult,
            documentCount: args.documents.length,
            analysisType: args.analysis_type,
          },
        });
        
        return summaryResult;
      },
      {
        maxAttempts: 2,
        delay: 1500,
        operationName: 'generate-summary',
      }
    );
  }

  /**
   * Generate insights from analysis
   */
  private async generateInsights(analysisResult: any, args: DocumentAnalysisArgs): Promise<string[]> {
    try {
      const insightsResult = await this.claudeLayer.execute({
        action: 'complex_reasoning',
        prompt: `Based on the document analysis results, identify key insights, patterns, and important observations. Provide them as a structured list.`,
        context: JSON.stringify(analysisResult),
      });
      
      // Extract insights from the result
      const insightsText = typeof insightsResult.data === 'string' 
        ? insightsResult.data 
        : JSON.stringify(insightsResult.data);
      
      // Simple extraction of bullet points or numbered lists
      const insights = insightsText
        .split('\n')
        .filter(line => {
          const trimmed = line.trim();
          return trimmed && (trimmed.startsWith('-') || trimmed.startsWith('•') || /^\d+\./.test(trimmed));
        })
        .map(line => line.trim().replace(/^[-•]\s*/, '').replace(/^\d+\.\s*/, ''))
        .filter(insight => insight.length > 10); // Filter out very short insights
      
      return insights.length > 0 ? insights : ['Analysis completed successfully'];
    } catch (error) {
      logger.warn('Failed to generate insights', { error: (error as Error).message });
      return ['Analysis completed successfully'];
    }
  }

  /**
   * Build comprehensive analysis prompt
   */
  private buildComprehensiveAnalysisPrompt(documents: FileReference[], extractions: any[]): string {
    let prompt = `Please perform a comprehensive analysis of ${documents.length} document(s). `;
    prompt += 'The documents have been processed and their content extracted. ';
    prompt += 'Please analyze the content for:\n';
    prompt += '1. Main themes and topics\n';
    prompt += '2. Key information and facts\n';
    prompt += '3. Document structure and organization\n';
    prompt += '4. Important insights and conclusions\n';
    prompt += '5. Relationships between different parts of the content\n\n';
    prompt += 'Extracted content:\n';
    prompt += JSON.stringify(extractions, null, 2);
    
    return prompt;
  }

  /**
   * Build comparison prompt
   */
  private buildComparisonPrompt(documentContents: any[], comparisonType: string): string {
    let prompt = `Please perform a ${comparisonType} comparison of the following documents:\n\n`;
    
    documentContents.forEach((doc, index) => {
      prompt += `Document ${index + 1} (${path.basename(doc.document)}):\n`;
      prompt += `${JSON.stringify(doc.content)}\n\n`;
    });
    
    prompt += 'Please analyze and compare these documents focusing on:\n';
    
    switch (comparisonType) {
      case 'similarity':
        prompt += '- Common themes and topics\n';
        prompt += '- Shared information and concepts\n';
        prompt += '- Similar conclusions or findings\n';
        break;
      case 'differences':
        prompt += '- Contrasting viewpoints\n';
        prompt += '- Different approaches or methodologies\n';
        prompt += '- Unique information in each document\n';
        break;
      default:
        prompt += '- Similarities and differences\n';
        prompt += '- Complementary information\n';
        prompt += '- Contradictions or conflicts\n';
        prompt += '- Overall relationship between documents\n';
    }
    
    return prompt;
  }


  /**
   * Get supported document types
   */
  getSupportedDocumentTypes(): string[] {
    return [...this.SUPPORTED_DOCUMENT_TYPES];
  }

  /**
   * Check if document type is supported
   */
  isDocumentSupported(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return this.SUPPORTED_DOCUMENT_TYPES.includes(ext);
  }

  /**
   * Get processing limits
   */
  getProcessingLimits(): {
    maxDocuments: number;
    maxDocumentSize: number;
    maxDocumentSizeMB: number;
  } {
    return {
      maxDocuments: this.MAX_DOCUMENTS,
      maxDocumentSize: this.MAX_DOCUMENT_SIZE,
      maxDocumentSizeMB: this.MAX_DOCUMENT_SIZE / 1024 / 1024,
    };
  }

  /**
   * Estimate tokens used in analysis
   */
  private estimateTokensUsed(analysisResult: any): number {
    const resultText = typeof analysisResult === 'string' ? analysisResult : JSON.stringify(analysisResult);
    // Rough estimate: 1 token ≈ 4 characters
    return Math.ceil(resultText.length / 4);
  }
}