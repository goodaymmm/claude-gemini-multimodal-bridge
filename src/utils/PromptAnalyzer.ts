import { logger } from './logger.js';

/**
 * PromptAnalyzer - Analyzes user prompts for keyword detection and optimal tool routing
 * Specifically designed for CGMB keyword detection to ensure proper tool selection
 */
export class PromptAnalyzer {
  /**
   * Detect CGMB keyword in the prompt (case-insensitive)
   * Returns true if the prompt contains CGMB keyword
   */
  public static detectCGMBKeyword(prompt: string): boolean {
    if (!prompt || typeof prompt !== 'string') {
      return false;
    }

    const normalizedPrompt = prompt.toLowerCase().trim();
    
    // CGMB keyword variations
    const cgmbKeywords = [
      'cgmb',
      'claude-gemini',
      'claude gemini',
      'multimodal bridge',
      'cgmb、', // Japanese comma
      'cgmb,',  // English comma
      'cgmb.', 
      'cgmb!',
      'cgmb?'
    ];
    
    const hasCGMBKeyword = cgmbKeywords.some(keyword => 
      normalizedPrompt.includes(keyword.toLowerCase())
    );
    
    if (hasCGMBKeyword) {
      logger.info('CGMB keyword detected in prompt', {
        prompt: prompt.substring(0, 100) + '...',
        detectedKeyword: cgmbKeywords.find(keyword => 
          normalizedPrompt.includes(keyword.toLowerCase())
        )
      });
    }
    
    return hasCGMBKeyword;
  }

  /**
   * Analyze the type of task from the prompt
   * This helps determine the best workflow for the request
   */
  public static analyzeTaskType(prompt: string): {
    type: 'analysis' | 'generation' | 'conversion' | 'extraction' | 'search' | 'general';
    confidence: number;
    hasFiles: boolean;
  } {
    const lowerPrompt = prompt.toLowerCase();
    
    // Analysis keywords
    const analysisPatterns = [
      /analyz[e]?/i, /分析/g, /解析/g, /review/i, /examine/i, /inspect/i
    ];
    
    // Generation keywords  
    const generationPatterns = [
      /generat[e]?/i, /creat[e]?/i, /生成/g, /作成/g, /make/i, /build/i
    ];
    
    // Conversion keywords
    const conversionPatterns = [
      /convert/i, /transform/i, /変換/g, /format/i, /export/i
    ];
    
    // Extraction keywords
    const extractionPatterns = [
      /extract/i, /抽出/g, /取得/g, /get/i, /retrieve/i
    ];
    
    // Search keywords
    const searchPatterns = [
      /search/i, /find/i, /検索/g, /探す/g, /look for/i, /latest/i, /current/i
    ];
    
    // File references
    const hasFiles = /@\w+\.\w+|attached|添付|file|ファイル/.test(lowerPrompt);
    
    // Calculate scores
    const scores = {
      analysis: analysisPatterns.reduce((score, pattern) => 
        score + (pattern.test(lowerPrompt) ? 1 : 0), 0),
      generation: generationPatterns.reduce((score, pattern) => 
        score + (pattern.test(lowerPrompt) ? 1 : 0), 0),
      conversion: conversionPatterns.reduce((score, pattern) => 
        score + (pattern.test(lowerPrompt) ? 1 : 0), 0),
      extraction: extractionPatterns.reduce((score, pattern) => 
        score + (pattern.test(lowerPrompt) ? 1 : 0), 0),
      search: searchPatterns.reduce((score, pattern) => 
        score + (pattern.test(lowerPrompt) ? 1 : 0), 0)
    };
    
    // Find the highest scoring type
    const maxScore = Math.max(...Object.values(scores));
    const detectedType = Object.entries(scores).find(([_, score]) => score === maxScore)?.[0] as any;
    
    const type = detectedType && maxScore > 0 ? detectedType : 'general';
    const confidence = maxScore > 0 ? Math.min(maxScore / 3, 1) : 0.1;
    
    logger.debug('Task type analysis completed', {
      prompt: prompt.substring(0, 50) + '...',
      type,
      confidence,
      hasFiles,
      scores
    });
    
    return { type, confidence, hasFiles };
  }

  /**
   * Determine the optimal workflow based on prompt analysis
   * This helps route to the correct CGMB internal processing
   */
  public static determineOptimalWorkflow(prompt: string, files?: any[]): {
    workflow: 'analysis' | 'conversion' | 'extraction' | 'generation';
    priority: 'fast' | 'balanced' | 'quality';
    useSearch: boolean;
  } {
    const taskAnalysis = this.analyzeTaskType(prompt);
    const hasFiles = files && files.length > 0;
    
    // Determine workflow
    let workflow: 'analysis' | 'conversion' | 'extraction' | 'generation' = 'analysis';
    if (taskAnalysis.type === 'generation') workflow = 'generation';
    else if (taskAnalysis.type === 'conversion') workflow = 'conversion';
    else if (taskAnalysis.type === 'extraction') workflow = 'extraction';
    else workflow = 'analysis'; // Default for analysis, search, general
    
    // Determine priority based on prompt length and complexity
    const wordCount = prompt.split(/\s+/).length;
    let priority: 'fast' | 'balanced' | 'quality' = 'balanced';
    if (wordCount < 10 && !hasFiles) priority = 'fast';
    else if (wordCount > 50 || hasFiles) priority = 'quality';
    
    // Determine if search is needed
    const useSearch = taskAnalysis.type === 'search' || 
                     /latest|current|recent|今|最新/.test(prompt.toLowerCase());
    
    logger.info('Optimal workflow determined', {
      prompt: prompt.substring(0, 50) + '...',
      workflow,
      priority,
      useSearch,
      taskType: taskAnalysis.type,
      hasFiles
    });
    
    return { workflow, priority, useSearch };
  }

  /**
   * Extract file references from the prompt
   * Looks for @filename patterns and file mentions
   */
  public static extractFileReferences(prompt: string): string[] {
    const filePatterns = [
      /@([^\s]+\.\w+)/g,  // @filename.ext
      /file:\/\/([^\s]+)/g, // file:// URLs
      /([^\s]+\.(?:pdf|png|jpg|jpeg|gif|txt|docx|xlsx|mp3|mp4|wav))/gi // Extensions
    ];
    
    const files: string[] = [];
    
    filePatterns.forEach(pattern => {
      const matches = prompt.match(pattern);
      if (matches) {
        files.push(...matches.map(match => match.replace(/^@/, '')));
      }
    });
    
    // Remove duplicates
    const uniqueFiles = [...new Set(files)];
    
    if (uniqueFiles.length > 0) {
      logger.debug('File references extracted from prompt', {
        prompt: prompt.substring(0, 50) + '...',
        files: uniqueFiles
      });
    }
    
    return uniqueFiles;
  }

  /**
   * Generate processing suggestions based on prompt analysis
   * Provides guidance for optimal CGMB processing
   */
  public static generateProcessingSuggestions(prompt: string): {
    suggestions: string[];
    recommendedTool: 'cgmb' | 'cgmb_multimodal_process' | 'cgmb_document_analysis' | 'cgmb_workflow_orchestration';
    confidence: number;
  } {
    const hasCGMB = this.detectCGMBKeyword(prompt);
    const taskAnalysis = this.analyzeTaskType(prompt);
    const fileRefs = this.extractFileReferences(prompt);
    
    const suggestions: string[] = [];
    let recommendedTool: any = 'cgmb'; // Default to unified tool
    let confidence = 0.8;
    
    // If CGMB keyword is present, use unified tool
    if (hasCGMB) {
      suggestions.push('✅ CGMB keyword detected - using unified CGMB processor');
      recommendedTool = 'cgmb';
      confidence = 0.95;
    } else {
      // Fallback to specific tools based on task type
      if (taskAnalysis.type === 'analysis' && fileRefs.length > 0) {
        suggestions.push('📄 Document analysis detected - consider cgmb_document_analysis');
        recommendedTool = 'cgmb_document_analysis';
      } else if (taskAnalysis.type === 'generation' || taskAnalysis.type === 'conversion') {
        suggestions.push('🔄 Complex workflow detected - consider cgmb_workflow_orchestration');
        recommendedTool = 'cgmb_workflow_orchestration';
      } else {
        suggestions.push('🎯 General multimodal processing - using cgmb_multimodal_process');
        recommendedTool = 'cgmb_multimodal_process';
      }
      confidence = taskAnalysis.confidence;
    }
    
    // Add file-specific suggestions
    if (fileRefs.length > 0) {
      suggestions.push(`📁 ${fileRefs.length} file reference(s) detected`);
    }
    
    // Add task-specific suggestions
    if (taskAnalysis.type === 'search') {
      suggestions.push('🔍 Search request detected - web search will be enabled');
    }
    
    logger.info('Processing suggestions generated', {
      prompt: prompt.substring(0, 50) + '...',
      recommendedTool,
      confidence,
      suggestions: suggestions.length
    });
    
    return { suggestions, recommendedTool, confidence };
  }
}