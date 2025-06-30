import { logger } from './logger.js';

export interface OptimizationOptions {
  maxTokens?: number;
  preserveContext?: boolean;
  removeRedundancy?: boolean;
  extractKeywords?: boolean;
  useTemplates?: boolean;
}

export interface OptimizationResult {
  originalPrompt: string;
  optimizedPrompt: string;
  reducedTokens: number;
  reductionPercentage: number;
  optimizationMethods: string[];
}

export class PromptOptimizer {
  private readonly DEFAULT_MAX_TOKENS = 8000;
  private readonly KEYWORD_EXTRACTION_PATTERNS = [
    /について|に関して|について教えて|を説明/g,
    /最新の|最近の|2024|2025|トレンド|動向/g,
    /具体的には|詳しく|詳細に|例えば/g,
    /分析|解析|検討|評価|調査/g,
    /方法|戦略|手法|アプローチ|施策/g,
  ];

  private readonly SEARCH_TEMPLATES = {
    trend_analysis: {
      keywords: ['トレンド', '動向', '最新', '2024', '2025'],
      template: '{topic}の最新トレンドと{year}年の動向分析'
    },
    strategy_advice: {
      keywords: ['戦略', '方法', 'アプローチ', '手法'],
      template: '{topic}の効果的な戦略と実装方法'
    },
    market_research: {
      keywords: ['市場', 'マーケット', '予測', '分析'],
      template: '{topic}の市場分析と予測'
    },
    technical_guide: {
      keywords: ['実装', '技術', '開発', 'プログラミング'],
      template: '{topic}の技術実装ガイド'
    }
  };

  /**
   * プロンプトを最適化してWebSearch用に短縮
   */
  async optimizeForWebSearch(
    prompt: string, 
    options: OptimizationOptions = {}
  ): Promise<OptimizationResult> {
    const startTime = Date.now();
    const originalPrompt = prompt;
    const optimizationMethods: string[] = [];
    
    let optimizedPrompt = prompt;
    const maxTokens = options.maxTokens || this.DEFAULT_MAX_TOKENS;

    try {
      // 1. テンプレートマッチング
      if (options.useTemplates !== false) {
        const templateResult = this.applySearchTemplate(optimizedPrompt);
        if (templateResult.matched) {
          optimizedPrompt = templateResult.optimized;
          optimizationMethods.push('template_matching');
        }
      }

      // 2. キーワード抽出
      if (options.extractKeywords !== false) {
        optimizedPrompt = this.extractKeywords(optimizedPrompt);
        optimizationMethods.push('keyword_extraction');
      }

      // 3. 冗長性除去
      if (options.removeRedundancy !== false) {
        optimizedPrompt = this.removeRedundancy(optimizedPrompt);
        optimizationMethods.push('redundancy_removal');
      }

      // 4. 構造化短縮
      optimizedPrompt = this.structuredShortening(optimizedPrompt, maxTokens);
      optimizationMethods.push('structured_shortening');

      // 5. 文脈保持短縮
      if (options.preserveContext !== false) {
        optimizedPrompt = this.preserveContextShortening(optimizedPrompt);
        optimizationMethods.push('context_preservation');
      }

      const originalTokens = this.estimateTokens(originalPrompt);
      const optimizedTokens = this.estimateTokens(optimizedPrompt);
      const reducedTokens = originalTokens - optimizedTokens;
      const reductionPercentage = (reducedTokens / originalTokens) * 100;

      const result: OptimizationResult = {
        originalPrompt,
        optimizedPrompt,
        reducedTokens,
        reductionPercentage,
        optimizationMethods
      };

      logger.info('Prompt optimization completed', {
        originalTokens,
        optimizedTokens,
        reductionPercentage: reductionPercentage.toFixed(1),
        duration: Date.now() - startTime,
        methods: optimizationMethods
      });

      return result;

    } catch (error) {
      logger.error('Prompt optimization failed', { error });
      return {
        originalPrompt,
        optimizedPrompt: originalPrompt,
        reducedTokens: 0,
        reductionPercentage: 0,
        optimizationMethods: ['optimization_failed']
      };
    }
  }

  /**
   * 検索テンプレートの適用
   */
  private applySearchTemplate(prompt: string): { matched: boolean; optimized: string } {
    const lowerPrompt = prompt.toLowerCase();
    
    for (const [templateName, template] of Object.entries(this.SEARCH_TEMPLATES)) {
      const matchedKeywords = template.keywords.filter(keyword => 
        lowerPrompt.includes(keyword.toLowerCase())
      );

      if (matchedKeywords.length >= 2) {
        // トピックを抽出
        const topic = this.extractMainTopic(prompt);
        const year = this.extractYear(prompt) || '2024-2025';
        
        let optimized = template.template
          .replace('{topic}', topic)
          .replace('{year}', year);

        // 追加の重要キーワードを付加
        const additionalKeywords = this.extractAdditionalKeywords(prompt);
        if (additionalKeywords.length > 0) {
          optimized += ` ${additionalKeywords.slice(0, 3).join(' ')}`;
        }

        logger.debug('Template applied', { 
          template: templateName, 
          topic, 
          matchedKeywords 
        });

        return { matched: true, optimized };
      }
    }

    return { matched: false, optimized: prompt };
  }

  /**
   * キーワード抽出
   */
  private extractKeywords(prompt: string): string {
    const keywords = new Set<string>();
    
    // 重要語句のパターンマッチング
    this.KEYWORD_EXTRACTION_PATTERNS.forEach(pattern => {
      const matches = prompt.match(pattern);
      if (matches) {
        matches.forEach(match => keywords.add(match));
      }
    });

    // 名詞句の抽出（簡易版）
    const nounPhrases = prompt.match(/[ァ-ヶー]+[アプリ|システム|サービス|技術|方法|戦略]*/g);
    if (nounPhrases) {
      nounPhrases.slice(0, 5).forEach(phrase => keywords.add(phrase));
    }

    // 英数字キーワード
    const alphanumericKeywords = prompt.match(/[A-Za-z][A-Za-z0-9]*|[0-9]{4}/g);
    if (alphanumericKeywords) {
      alphanumericKeywords.slice(0, 3).forEach(keyword => keywords.add(keyword));
    }

    return Array.from(keywords).join(' ');
  }

  /**
   * 冗長性除去
   */
  private removeRedundancy(prompt: string): string {
    return prompt
      // 重複表現の削除
      .replace(/について(?:詳しく)?(?:教えて|説明して)ください[。]?/g, 'について')
      .replace(/具体的には以下の点について[：:]/g, '')
      .replace(/(?:1\.|2\.|3\.|4\.|5\.)\s*/g, '')
      // 冗長な修飾語の削除
      .replace(/(?:非常に|とても|かなり|極めて)\s*/g, '')
      .replace(/(?:詳細に|詳しく|具体的に)\s*/g, '')
      // 重複文字の正規化
      .replace(/[。、]{2,}/g, '、')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  /**
   * 構造化短縮
   */
  private structuredShortening(prompt: string, maxTokens: number): string {
    const estimatedTokens = this.estimateTokens(prompt);
    
    if (estimatedTokens <= maxTokens) {
      return prompt;
    }

    // 文を分割
    const sentences = prompt.split(/[。！？]/).filter(s => s.trim());
    
    // 重要度に基づいてソート
    const sentenceImportance = sentences.map(sentence => ({
      sentence: sentence.trim(),
      importance: this.calculateSentenceImportance(sentence)
    })).sort((a, b) => b.importance - a.importance);

    // トークン制限内に収まるように選択
    let selectedSentences: string[] = [];
    let currentTokens = 0;

    for (const { sentence } of sentenceImportance) {
      const sentenceTokens = this.estimateTokens(sentence);
      if (currentTokens + sentenceTokens <= maxTokens) {
        selectedSentences.push(sentence);
        currentTokens += sentenceTokens;
      }
    }

    return selectedSentences.join('。') + '。';
  }

  /**
   * 文脈保持短縮
   */
  private preserveContextShortening(prompt: string): string {
    // 主要な文脈キーワードを保持
    const contextKeywords = [
      'Android', 'アプリ', 'マネタイズ', '広告', 'IAP', 'サブスクリプション',
      '2024', '2025', 'トレンド', '動向', '戦略', '方法'
    ];

    // 文脈キーワードを含む部分を優先的に保持
    const sentences = prompt.split(/[。！？]/).filter(s => s.trim());
    const prioritizedSentences = sentences.filter(sentence => 
      contextKeywords.some(keyword => sentence.includes(keyword))
    );

    if (prioritizedSentences.length > 0) {
      return prioritizedSentences.join('。') + '。';
    }

    return prompt;
  }

  /**
   * 文の重要度計算
   */
  private calculateSentenceImportance(sentence: string): number {
    let importance = 0;

    // キーワード重要度
    const importantKeywords = ['最新', 'トレンド', '2024', '2025', '戦略', '方法', '分析'];
    importantKeywords.forEach(keyword => {
      if (sentence.includes(keyword)) importance += 2;
    });

    // 質問形式の重要度
    if (sentence.includes('？') || sentence.includes('ですか')) importance += 1;

    // 具体的要求の重要度
    if (sentence.includes('具体的') || sentence.includes('詳しく')) importance += 1;

    // 文の長さによる重要度（適度な長さを重視）
    const length = sentence.length;
    if (length >= 20 && length <= 100) importance += 1;

    return importance;
  }

  /**
   * メイントピック抽出
   */
  private extractMainTopic(prompt: string): string {
    // よく出現する主要トピックのパターン
    const topicPatterns = [
      /Android[アプリ]*/,
      /マネタイズ[戦略]*/,
      /[アプリ内]?課金/,
      /サブスクリプション/,
      /広告収入/,
      /[Aa][Pp][Pp]/
    ];

    for (const pattern of topicPatterns) {
      const match = prompt.match(pattern);
      if (match) {
        return match[0];
      }
    }

    // フォールバック: 最初の名詞句
    const nounMatch = prompt.match(/[ァ-ヶー]+/);
    return nounMatch ? nounMatch[0] : 'トピック';
  }

  /**
   * 年度抽出
   */
  private extractYear(prompt: string): string | null {
    const yearMatch = prompt.match(/20[0-9]{2}[-年]?20[0-9]{2}|20[0-9]{2}/);
    return yearMatch ? yearMatch[0] : null;
  }

  /**
   * 追加キーワード抽出
   */
  private extractAdditionalKeywords(prompt: string): string[] {
    const keywords = [];
    
    // 技術用語
    const techTerms = prompt.match(/[A-Z]{2,}|API|SDK|UI|UX/g);
    if (techTerms) keywords.push(...techTerms.slice(0, 2));

    // カタカナ用語
    const katakanaTerms = prompt.match(/[ァ-ヶー]{3,}/g);
    if (katakanaTerms) keywords.push(...katakanaTerms.slice(0, 3));

    return keywords;
  }

  /**
   * トークン数の概算
   */
  private estimateTokens(text: string): number {
    // 日本語テキストのトークン数概算
    // ひらがな・カタカナ: 1文字 ≈ 1トークン
    // 漢字: 1文字 ≈ 1-2トークン
    // 英数字: 4文字 ≈ 1トークン
    
    const hiragana = (text.match(/[ひ-ゞ]/g) || []).length;
    const katakana = (text.match(/[ァ-ヶー]/g) || []).length;
    const kanji = (text.match(/[一-龯]/g) || []).length;
    const alphanumeric = (text.match(/[a-zA-Z0-9]/g) || []).length;
    
    return hiragana + katakana + (kanji * 1.5) + Math.ceil(alphanumeric / 4);
  }
}