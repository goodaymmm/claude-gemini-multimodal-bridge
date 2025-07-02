import { logger } from '../utils/logger.js';

/**
 * IntelligentRouter - Determines optimal routing strategies for CGMB tasks
 * Based on Gemini's architectural recommendations for intelligent orchestration
 */
export class IntelligentRouter {
  /**
   * Heuristics-based approach for determining if search should be disabled
   * This is the lightweight, fast option for confident cases
   */
  public static shouldDisableSearch(prompt: string): boolean {
    const lowerCasePrompt = prompt.toLowerCase().trim();
    
    // High-confidence cases where search should be disabled
    const nonSearchPatterns = [
      // Document manipulation tasks
      /^(summarize|要約|まとめ).*(this|これ|この)/,
      /^(translate|翻訳|訳).*(following|以下|次の)/,
      /^(format|整形|フォーマット).*(document|文書|ドキュメント)/,
      /^(explain|説明|解説).*(code|コード|プログラム)/,
      
      // Analysis of provided content
      /^(analyze|分析|解析).*(attached|添付|provided|提供)/,
      /^(review|レビュー|確認).*(document|文書|file|ファイル)/,
      /^(check|チェック|確認).*(grammar|文法|syntax|構文)/,
      
      // Simple conversational responses
      /^(hello|hi|こんにちは|はじめまして)/,
      /^(thanks|thank you|ありがとう|感謝)/,
      /^(help|ヘルプ|助け|手伝)/,
      
      // Mathematical or computational tasks
      /^(calculate|計算|compute|算出)/,
      /^(solve|解く|解決).*(equation|方程式|problem|問題)/
    ];
    
    // Check if prompt matches any high-confidence non-search pattern
    const shouldDisable = nonSearchPatterns.some(pattern => pattern.test(lowerCasePrompt));
    
    if (shouldDisable) {
      logger.debug('IntelligentRouter: High confidence - disabling search', {
        prompt: prompt.substring(0, 50) + '...',
        reason: 'Matched non-search pattern'
      });
    }
    
    return shouldDisable;
  }

  /**
   * Enhanced heuristic detection for prompts that likely need current information
   * This helps identify cases where search should definitely be enabled
   */
  public static shouldEnableSearch(prompt: string): boolean {
    const lowerCasePrompt = prompt.toLowerCase();
    
    // Temporal indicators (current/recent information)
    const temporalKeywords = [
      // English temporal keywords
      'latest', 'current', 'recent', 'today', 'yesterday', 'this week', 'this month', 
      'this year', 'now', 'currently', 'breaking', 'update', 'news', 'trend',
      
      // Japanese temporal keywords  
      '最新', '現在', '今', '今日', '昨日', '今週', '今月', '今年', '最近', 
      'トレンド', 'ニュース', '更新', '動向', '状況',
      
      // Chinese temporal keywords
      '最新', '当前', '现在', '今天', '昨天', '本周', '本月', '今年', '最近', '趋势'
    ];
    
    // Year patterns (2020-2030)
    const yearPattern = /20[2-3][0-9]/;
    
    // Question words that often indicate information seeking
    const questionWords = ['what', 'who', 'when', 'where', 'how', 'why', '何', 'いつ', 'どこ', 'なぜ', 'どう'];
    
    // Check for temporal indicators
    const hasTemporalKeywords = temporalKeywords.some(keyword => lowerCasePrompt.includes(keyword));
    const hasYearMention = yearPattern.test(prompt);
    const hasQuestionWords = questionWords.some(word => lowerCasePrompt.includes(word));
    
    // Web-specific indicators
    const webIndicators = ['stock price', 'weather', 'stock market', '株価', '天気', '市場', '价格', '天气'];
    const hasWebIndicators = webIndicators.some(indicator => lowerCasePrompt.includes(indicator));
    
    const shouldEnable = hasTemporalKeywords || hasYearMention || hasWebIndicators || 
                        (hasQuestionWords && prompt.length > 20);
    
    if (shouldEnable) {
      logger.debug('IntelligentRouter: High confidence - enabling search', {
        prompt: prompt.substring(0, 50) + '...',
        reasons: {
          hasTemporalKeywords,
          hasYearMention,
          hasWebIndicators,
          hasQuestionWords: hasQuestionWords && prompt.length > 20
        }
      });
    }
    
    return shouldEnable;
  }

  /**
   * Main routing decision method
   * Returns the recommended useSearch value based on intelligent analysis
   */
  public static determineSearchStrategy(prompt: string): boolean | null {
    // First check for high-confidence disable cases
    if (this.shouldDisableSearch(prompt)) {
      return false;
    }
    
    // Then check for high-confidence enable cases
    if (this.shouldEnableSearch(prompt)) {
      return true;
    }
    
    // For ambiguous cases, return null to indicate "use default"
    // This allows the system to default to useSearch: true (Gemini's recommendation)
    logger.debug('IntelligentRouter: Ambiguous case - using default search strategy', {
      prompt: prompt.substring(0, 50) + '...'
    });
    
    return null; // Let the system use its default (true)
  }

  /**
   * Get routing statistics for monitoring and optimization
   */
  public static getRoutingStats(): {
    totalAnalyzed: number;
    searchEnabled: number;
    searchDisabled: number;
    ambiguous: number;
  } {
    // This would be enhanced with actual tracking in a production system
    return {
      totalAnalyzed: 0,
      searchEnabled: 0,
      searchDisabled: 0,
      ambiguous: 0
    };
  }

  /**
   * Validate prompt for routing analysis
   */
  private static validatePrompt(prompt: string): boolean {
    return typeof prompt === 'string' && prompt.trim().length > 0;
  }

  /**
   * Enhanced routing for specific task types
   * This method can be used when task metadata is available
   */
  public static routeByTaskType(taskType: string, prompt: string): boolean {
    switch (taskType) {
      case 'document_analysis':
      case 'code_review':
      case 'translation':
      case 'summarization':
        return false; // These typically work with provided content
        
      case 'research':
      case 'fact_checking':
      case 'current_events':
      case 'market_analysis':
        return true; // These typically need current information
        
      case 'text_processing':
      default:
        // Fall back to prompt analysis
        const result = this.determineSearchStrategy(prompt);
        return result !== null ? result : true; // Default to true as per Gemini's recommendation
    }
  }
}

/**
 * Future enhancement: LLM-based router
 * This would use a lightweight model for more sophisticated routing decisions
 */
export class LLMBasedRouter {
  // This is a placeholder for future implementation
  // Would use Gemini Flash or Claude Haiku for meta-prompt classification
  
  public async shouldUseSearch(prompt: string): Promise<boolean> {
    // Future implementation would use:
    // const metaPrompt = `Does the following user prompt require real-time information 
    // from the web to be answered accurately? Answer only with "yes" or "no". 
    // User Prompt: "${prompt}"`;
    
    // For now, fall back to heuristic approach
    const result = IntelligentRouter.determineSearchStrategy(prompt);
    return result !== null ? result : true;
  }
}