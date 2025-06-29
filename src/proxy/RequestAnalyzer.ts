import { RequestAnalysis, EnhancementPlan } from '../core/types.js';
import { logger } from '../utils/logger.js';
import { safeExecute } from '../utils/errorHandler.js';

/**
 * RequestAnalyzer provides smart request analysis and enhancement detection
 * Determines optimal routing and enhancement opportunities for Claude requests
 */
export class RequestAnalyzer {
  private readonly FILE_EXTENSIONS = {
    multimodal: ['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.mp3', '.wav', '.m4a', '.mp4', '.mov', '.avi'],
    document: ['.doc', '.docx', '.txt', '.md', '.rtf', '.odt'],
    data: ['.csv', '.json', '.xml', '.yaml', '.yml'],
    code: ['.js', '.ts', '.py', '.java', '.c', '.cpp', '.go', '.rs', '.php'],
  };

  private readonly GROUNDING_KEYWORDS = [
    'latest', 'current', 'recent', 'today', 'now', 'search', 'find',
    'what is happening', 'news', 'update', 'trending', 'live',
    'real-time', 'up-to-date', 'fresh', 'new', 'breaking'
  ];

  private readonly COMPLEXITY_INDICATORS = {
    high: ['analyze', 'compare', 'evaluate', 'synthesize', 'comprehensive', 'detailed analysis'],
    medium: ['explain', 'describe', 'summarize', 'review', 'assess', 'examine'],
    low: ['list', 'show', 'display', 'print', 'output', 'format']
  };

  /**
   * Analyze Claude request for enhancement opportunities
   */
  async analyze(args: string[]): Promise<RequestAnalysis> {
    return safeExecute(
      async () => {
        const startTime = Date.now();
        logger.debug('Starting request analysis', { args });

        const input = args.join(' ');
        const analysis = {
          canEnhance: false,
          requiredCapabilities: [] as ('claude' | 'gemini' | 'aistudio')[],
          fallbackToOriginal: false,
          enhancementType: 'passthrough' as const,
          confidence: 0,
          priority: 'low' as const,
          estimatedComplexity: 'simple' as const,
        };

        // Check for help/version commands (should not be enhanced)
        if (this.isSystemCommand(args)) {
          logger.debug('System command detected, no enhancement needed');
          return {
            ...analysis,
            fallbackToOriginal: true,
            confidence: 1.0,
          };
        }

        // Analyze file attachments
        const fileAnalysis = this.analyzeFiles(args, input);
        if (fileAnalysis.hasMultimodalFiles) {
          analysis.canEnhance = true;
          analysis.enhancementType = 'multimodal';
          analysis.requiredCapabilities.push('aistudio');
          analysis.confidence = Math.max(analysis.confidence, 0.9);
          analysis.priority = 'high';
          analysis.estimatedComplexity = 'moderate';
          
          logger.debug('Multimodal files detected', fileAnalysis);
        }

        // Analyze grounding needs
        const groundingAnalysis = this.analyzeGroundingNeeds(input);
        if (groundingAnalysis.needsGrounding) {
          analysis.canEnhance = true;
          if (analysis.enhancementType === 'passthrough') {
            analysis.enhancementType = 'grounding';
          }
          analysis.requiredCapabilities.push('gemini');
          analysis.confidence = Math.max(analysis.confidence, groundingAnalysis.confidence);
          analysis.priority = groundingAnalysis.priority;
          
          logger.debug('Grounding needs detected', groundingAnalysis);
        }

        // Analyze complexity and reasoning needs
        const complexityAnalysis = this.analyzeComplexity(input);
        if (complexityAnalysis.needsReasoning) {
          analysis.canEnhance = true;
          if (analysis.enhancementType === 'passthrough') {
            analysis.enhancementType = 'reasoning';
          }
          analysis.requiredCapabilities.push('claude');
          analysis.confidence = Math.max(analysis.confidence, complexityAnalysis.confidence);
          analysis.estimatedComplexity = complexityAnalysis.complexity;
          
          logger.debug('Complex reasoning detected', complexityAnalysis);
        }

        // Always include Claude as fallback
        if (!analysis.requiredCapabilities.includes('claude')) {
          analysis.requiredCapabilities.push('claude');
        }

        // Determine fallback strategy
        analysis.fallbackToOriginal = this.shouldFallbackToOriginal(args, analysis);

        const duration = Date.now() - startTime;
        logger.info('Request analysis completed', {
          canEnhance: analysis.canEnhance,
          enhancementType: analysis.enhancementType,
          requiredCapabilities: analysis.requiredCapabilities,
          confidence: analysis.confidence,
          duration,
        });

        return analysis;
      },
      {
        operationName: 'analyze-request',
        layer: 'claude',
        timeout: 5000,
      }
    );
  }

  /**
   * Generate enhancement plan based on analysis
   */
  async generateEnhancementPlan(analysis: RequestAnalysis): Promise<EnhancementPlan> {
    return safeExecute(
      async () => {
        logger.debug('Generating enhancement plan', { analysis });

        if (!analysis.canEnhance || analysis.fallbackToOriginal) {
          return {
            enhance: false,
            type: 'passthrough',
            layers: ['claude'],
            confidence: 1.0,
            fallbackStrategy: {
              enabled: true,
              fallbackTo: ['claude'],
            },
          };
        }

        // Determine optimal layer order based on enhancement type
        const layers = this.determineLayerOrder(analysis);
        
        // Estimate execution duration
        const estimatedDuration = this.estimateExecutionDuration(analysis, layers);

        const plan: EnhancementPlan = {
          enhance: true,
          type: analysis.enhancementType,
          layers,
          confidence: analysis.confidence,
          fallbackStrategy: {
            enabled: true,
            fallbackTo: ['claude'], // Always fallback to Claude
          },
          estimatedDuration,
        };

        logger.info('Enhancement plan generated', plan);
        return plan;
      },
      {
        operationName: 'generate-enhancement-plan',
        layer: 'claude',
        timeout: 2000,
      }
    );
  }

  /**
   * Check if command is a system command that shouldn't be enhanced
   */
  private isSystemCommand(args: string[]): boolean {
    const systemCommands = ['--help', '-h', '--version', '-v', 'help', 'version'];
    return args.some(arg => systemCommands.includes(arg.toLowerCase()));
  }

  /**
   * Analyze files in the request
   */
  private analyzeFiles(args: string[], input: string): {
    hasFiles: boolean;
    hasMultimodalFiles: boolean;
    fileTypes: string[];
    fileCount: number;
  } {
    const fileArgs = args.filter(arg => arg.startsWith('@') || this.isFilePath(arg));
    const hasFiles = fileArgs.length > 0;
    
    let hasMultimodalFiles = false;
    const fileTypes: string[] = [];
    
    for (const fileArg of fileArgs) {
      const filePath = fileArg.startsWith('@') ? fileArg.slice(1) : fileArg;
      const extension = this.getFileExtension(filePath);
      
      if (this.FILE_EXTENSIONS.multimodal.includes(extension)) {
        hasMultimodalFiles = true;
        fileTypes.push('multimodal');
      } else if (this.FILE_EXTENSIONS.document.includes(extension)) {
        fileTypes.push('document');
      } else if (this.FILE_EXTENSIONS.data.includes(extension)) {
        fileTypes.push('data');
      } else if (this.FILE_EXTENSIONS.code.includes(extension)) {
        fileTypes.push('code');
      }
    }

    return {
      hasFiles,
      hasMultimodalFiles,
      fileTypes: [...new Set(fileTypes)],
      fileCount: fileArgs.length,
    };
  }

  /**
   * Analyze if request needs grounding
   */
  private analyzeGroundingNeeds(input: string): {
    needsGrounding: boolean;
    confidence: number;
    priority: 'low' | 'medium' | 'high';
    matchedKeywords: string[];
  } {
    const lowerInput = input.toLowerCase();
    const matchedKeywords = this.GROUNDING_KEYWORDS.filter(keyword => 
      lowerInput.includes(keyword)
    );

    const needsGrounding = matchedKeywords.length > 0;
    
    // Calculate confidence based on keyword matches and context
    let confidence = 0;
    if (needsGrounding) {
      confidence = Math.min(0.3 + (matchedKeywords.length * 0.2), 0.8);
      
      // Boost confidence for time-sensitive queries
      if (matchedKeywords.some(kw => ['today', 'now', 'current', 'latest'].includes(kw))) {
        confidence = Math.min(confidence + 0.2, 0.9);
      }
    }

    // Determine priority
    let priority: 'low' | 'medium' | 'high' = 'low';
    if (confidence > 0.7) priority = 'high';
    else if (confidence > 0.4) priority = 'medium';

    return {
      needsGrounding,
      confidence,
      priority,
      matchedKeywords,
    };
  }

  /**
   * Analyze complexity and reasoning needs
   */
  private analyzeComplexity(input: string): {
    needsReasoning: boolean;
    confidence: number;
    complexity: 'simple' | 'moderate' | 'complex';
  } {
    const lowerInput = input.toLowerCase();
    
    // Check for complexity indicators
    let complexity: 'simple' | 'moderate' | 'complex' = 'simple';
    let confidence = 0.3; // Base confidence for any Claude request
    
    for (const [level, keywords] of Object.entries(this.COMPLEXITY_INDICATORS)) {
      const matches = keywords.filter(keyword => lowerInput.includes(keyword));
      if (matches.length > 0) {
        complexity = level as 'simple' | 'moderate' | 'complex';
        confidence += matches.length * 0.1;
        break;
      }
    }
    
    // Additional factors
    const wordCount = input.split(/\s+/).length;
    if (wordCount > 100) {
      complexity = complexity === 'simple' ? 'moderate' : 'complex';
      confidence += 0.1;
    }
    
    if (wordCount > 200) {
      complexity = 'complex';
      confidence += 0.2;
    }

    // Check for reasoning patterns
    const reasoningPatterns = [
      'why', 'how', 'explain', 'because', 'therefore', 'however',
      'compare', 'contrast', 'analyze', 'evaluate', 'assess'
    ];
    
    const reasoningMatches = reasoningPatterns.filter(pattern => 
      lowerInput.includes(pattern)
    );
    
    if (reasoningMatches.length > 0) {
      confidence += reasoningMatches.length * 0.05;
    }

    const needsReasoning = complexity !== 'simple' || confidence > 0.5;
    
    return {
      needsReasoning,
      confidence: Math.min(confidence, 0.8),
      complexity,
    };
  }

  /**
   * Determine if should fallback to original Claude
   */
  private shouldFallbackToOriginal(args: string[], analysis: RequestAnalysis): boolean {
    // Always fallback for system commands
    if (this.isSystemCommand(args)) {
      return true;
    }
    
    // Fallback if confidence is too low
    if (analysis.confidence < 0.3) {
      return true;
    }
    
    // Fallback for very simple requests unless they have files
    const hasFiles = args.some(arg => arg.startsWith('@') || this.isFilePath(arg));
    if (!hasFiles && analysis.estimatedComplexity === 'simple' && analysis.confidence < 0.5) {
      return true;
    }
    
    return false;
  }

  /**
   * Determine optimal layer execution order
   */
  private determineLayerOrder(analysis: RequestAnalysis): ('claude' | 'gemini' | 'aistudio')[] {
    const layers: ('claude' | 'gemini' | 'aistudio')[] = [];
    
    switch (analysis.enhancementType) {
      case 'multimodal':
        // Process files first, then reason about them
        if (analysis.requiredCapabilities.includes('aistudio')) {
          layers.push('aistudio');
        }
        layers.push('claude');
        break;
        
      case 'grounding':
        // Get current information first, then reason about it
        if (analysis.requiredCapabilities.includes('gemini')) {
          layers.push('gemini');
        }
        layers.push('claude');
        break;
        
      case 'reasoning':
        // Complex reasoning primarily through Claude
        layers.push('claude');
        if (analysis.requiredCapabilities.includes('gemini')) {
          layers.push('gemini');
        }
        break;
        
      default:
        layers.push('claude');
    }
    
    // Remove duplicates while preserving order
    return [...new Set(layers)];
  }

  /**
   * Estimate execution duration based on analysis
   */
  private estimateExecutionDuration(analysis: RequestAnalysis, layers: string[]): number {
    let baseDuration = 2000; // 2 seconds base
    
    // Add time per layer
    baseDuration += layers.length * 1000;
    
    // Add time based on complexity
    switch (analysis.estimatedComplexity) {
      case 'complex':
        baseDuration += 10000; // +10 seconds
        break;
      case 'moderate':
        baseDuration += 5000; // +5 seconds
        break;
      default:
        // No additional time
    }
    
    // Add time for multimodal processing
    if (analysis.enhancementType === 'multimodal') {
      baseDuration += 15000; // +15 seconds for file processing
    }
    
    return baseDuration;
  }

  /**
   * Check if string looks like a file path
   */
  private isFilePath(str: string): boolean {
    // Simple heuristic: contains file extension or looks like a path
    return /\.[a-zA-Z0-9]{1,4}$/.test(str) || str.includes('/') || str.includes('\\');
  }

  /**
   * Get file extension from path
   */
  private getFileExtension(filePath: string): string {
    const match = filePath.match(/\.([^.]+)$/);
    return match ? `.${match[1].toLowerCase()}` : '';
  }

  /**
   * Quick analysis for simple decisions
   */
  async quickAnalyze(args: string[]): Promise<boolean> {
    try {
      const analysis = await this.analyze(args);
      return analysis.canEnhance && !analysis.fallbackToOriginal;
    } catch {
      return false;
    }
  }

  /**
   * Get analysis summary for logging
   */
  getAnalysisSummary(analysis: RequestAnalysis): string {
    const capabilities = analysis.requiredCapabilities.join(', ');
    return `${analysis.enhancementType} (${capabilities}) - confidence: ${analysis.confidence.toFixed(2)}`;
  }
}