import { logger } from './logger.js';
import crypto from 'crypto';

export interface CacheEntry {
  key: string;
  query: string;
  result: any;
  timestamp: number;
  expiresAt: number;
  metadata: {
    promptHash: string;
    searchEngine: string;
    resultCount: number;
    processingTime: number;
  };
}

export interface CacheStats {
  totalEntries: number;
  hitCount: number;
  missCount: number;
  hitRate: number;
  storageSize: number;
  expiredEntries: number;
}

export interface CacheOptions {
  ttl?: number; // Time to live in milliseconds
  maxEntries?: number;
  enableMetrics?: boolean;
  similarityThreshold?: number; // For fuzzy matching
}

export class SearchCache {
  private cache = new Map<string, CacheEntry>();
  private stats: CacheStats = {
    totalEntries: 0,
    hitCount: 0,
    missCount: 0,
    hitRate: 0,
    storageSize: 0,
    expiredEntries: 0
  };

  private readonly defaultTTL = 30 * 60 * 1000; // 30 minutes
  private readonly maxEntries = 1000;
  private readonly similarityThreshold = 0.8;
  private readonly enableMetrics = true;

  constructor(private options: CacheOptions = {}) {}

  /**
   * 検索結果をキャッシュから取得
   */
  async get(query: string, searchEngine: string = 'gemini'): Promise<any | null> {
    const key = this.generateCacheKey(query, searchEngine);
    const entry = this.cache.get(key);

    if (!entry) {
      this.stats.missCount++;
      this.updateHitRate();
      logger.debug('Cache miss', { query: query.substring(0, 50), searchEngine });
      return null;
    }

    // 有効期限チェック
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.stats.expiredEntries++;
      this.stats.missCount++;
      this.updateHitRate();
      logger.debug('Cache expired', { 
        query: query.substring(0, 50), 
        searchEngine,
        expiredAt: new Date(entry.expiresAt).toISOString()
      });
      return null;
    }

    // 類似クエリの検索（オプション）
    if (!entry && this.options.similarityThreshold) {
      const similarEntry = this.findSimilarEntry(query, searchEngine);
      if (similarEntry) {
        this.stats.hitCount++;
        this.updateHitRate();
        logger.debug('Cache hit (similar)', { 
          originalQuery: query.substring(0, 50),
          similarQuery: similarEntry.query.substring(0, 50),
          searchEngine 
        });
        return similarEntry.result;
      }
    }

    this.stats.hitCount++;
    this.updateHitRate();
    logger.debug('Cache hit', { 
      query: query.substring(0, 50), 
      searchEngine,
      age: Date.now() - entry.timestamp 
    });

    return entry.result;
  }

  /**
   * 検索結果をキャッシュに保存
   */
  async set(
    query: string, 
    result: any, 
    searchEngine: string = 'gemini',
    processingTime: number = 0
  ): Promise<void> {
    const key = this.generateCacheKey(query, searchEngine);
    const timestamp = Date.now();
    const ttl = this.options.ttl || this.defaultTTL;
    const expiresAt = timestamp + ttl;

    // キャッシュサイズ制限チェック
    if (this.cache.size >= (this.options.maxEntries || this.maxEntries)) {
      this.evictOldestEntries();
    }

    const entry: CacheEntry = {
      key,
      query,
      result,
      timestamp,
      expiresAt,
      metadata: {
        promptHash: this.hashString(query),
        searchEngine,
        resultCount: this.countResults(result),
        processingTime
      }
    };

    this.cache.set(key, entry);
    this.stats.totalEntries = this.cache.size;
    this.updateStorageSize();

    logger.debug('Cache stored', { 
      query: query.substring(0, 50), 
      searchEngine,
      ttl,
      resultCount: entry.metadata.resultCount
    });
  }

  /**
   * クエリ正規化によるキャッシュキー生成
   */
  private generateCacheKey(query: string, searchEngine: string): string {
    // クエリ正規化
    const normalizedQuery = this.normalizeQuery(query);
    const dataToHash = `${normalizedQuery}:${searchEngine}`;
    return this.hashString(dataToHash);
  }

  /**
   * クエリの正規化
   */
  private normalizeQuery(query: string): string {
    return query
      .toLowerCase()
      .trim()
      // 句読点と記号を正規化
      .replace(/[。、！？]/g, '')
      .replace(/\s+/g, ' ')
      // 年度の正規化
      .replace(/202[4-9]年?/g, '2024-2025')
      // 類似表現の正規化
      .replace(/について教えて|を説明して|について知りたい/g, 'について')
      .replace(/最新の|最近の|新しい/g, '最新')
      .replace(/具体的に|詳しく|詳細に/g, '詳細');
  }

  /**
   * 類似エントリの検索
   */
  private findSimilarEntry(query: string, searchEngine: string): CacheEntry | null {
    const normalizedQuery = this.normalizeQuery(query);
    const threshold = this.options.similarityThreshold || this.similarityThreshold;

    for (const entry of this.cache.values()) {
      if (entry.metadata.searchEngine !== searchEngine) continue;
      if (Date.now() > entry.expiresAt) continue;

      const similarity = this.calculateSimilarity(
        normalizedQuery, 
        this.normalizeQuery(entry.query)
      );

      if (similarity >= threshold) {
        return entry;
      }
    }

    return null;
  }

  /**
   * 文字列類似度計算（Jaccard係数）
   */
  private calculateSimilarity(str1: string, str2: string): number {
    const tokens1 = new Set(str1.split(/\s+/));
    const tokens2 = new Set(str2.split(/\s+/));
    
    const intersection = new Set([...tokens1].filter(x => tokens2.has(x)));
    const union = new Set([...tokens1, ...tokens2]);
    
    return union.size === 0 ? 0 : intersection.size / union.size;
  }

  /**
   * 古いエントリの削除
   */
  private evictOldestEntries(): void {
    const maxEntries = this.options.maxEntries || this.maxEntries;
    const evictCount = Math.floor(maxEntries * 0.2); // 20%を削除

    const sortedEntries = Array.from(this.cache.entries())
      .sort(([, a], [, b]) => a.timestamp - b.timestamp);

    for (let i = 0; i < evictCount && i < sortedEntries.length; i++) {
      const entry = sortedEntries[i];
      if (entry && entry[0]) {
        this.cache.delete(entry[0]);
      }
    }

    logger.debug('Cache eviction completed', { 
      evictedCount: evictCount,
      remainingEntries: this.cache.size 
    });
  }

  /**
   * 期限切れエントリのクリーンアップ
   */
  async cleanup(): Promise<number> {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
        cleanedCount++;
      }
    }

    this.stats.totalEntries = this.cache.size;
    this.stats.expiredEntries += cleanedCount;
    this.updateStorageSize();

    if (cleanedCount > 0) {
      logger.debug('Cache cleanup completed', { 
        cleanedCount,
        remainingEntries: this.cache.size 
      });
    }

    return cleanedCount;
  }

  /**
   * キャッシュクリア
   */
  async clear(): Promise<void> {
    const entryCount = this.cache.size;
    this.cache.clear();
    this.resetStats();
    
    logger.info('Cache cleared', { clearedEntries: entryCount });
  }

  /**
   * キャッシュ統計情報の取得
   */
  getStats(): CacheStats {
    this.updateStorageSize();
    return { ...this.stats };
  }

  /**
   * インメモリキャッシュをファイルにエクスポート
   */
  async exportToFile(filePath: string): Promise<void> {
    try {
      const exportData = {
        timestamp: Date.now(),
        stats: this.stats,
        entries: Array.from(this.cache.entries()).map(([cacheKey, entry]) => ({
          cacheKey,
          ...entry
        }))
      };

      const fs = await import('fs/promises');
      await fs.writeFile(filePath, JSON.stringify(exportData, null, 2));
      
      logger.info('Cache exported successfully', { 
        filePath, 
        entryCount: this.cache.size 
      });
    } catch (error) {
      logger.error('Cache export failed', { error, filePath });
      throw error;
    }
  }

  /**
   * ファイルからキャッシュをインポート
   */
  async importFromFile(filePath: string): Promise<void> {
    try {
      const fs = await import('fs/promises');
      const data = await fs.readFile(filePath, 'utf-8');
      const importData = JSON.parse(data);

      let importedCount = 0;
      const now = Date.now();

      for (const entryData of importData.entries) {
        // 期限切れでないエントリのみインポート
        if (entryData.expiresAt > now) {
          const key = entryData.cacheKey || entryData.key; // Backward compatibility
          this.cache.set(key, {
            key: entryData.key,
            query: entryData.query,
            result: entryData.result,
            timestamp: entryData.timestamp,
            expiresAt: entryData.expiresAt,
            metadata: entryData.metadata
          });
          importedCount++;
        }
      }

      this.stats.totalEntries = this.cache.size;
      this.updateStorageSize();

      logger.info('Cache imported successfully', { 
        filePath, 
        importedCount,
        skippedExpired: importData.entries.length - importedCount
      });
    } catch (error) {
      logger.error('Cache import failed', { error, filePath });
      throw error;
    }
  }

  /**
   * ヘルパーメソッド
   */
  private hashString(str: string): string {
    return crypto.createHash('sha256').update(str).digest('hex').substring(0, 16);
  }

  private countResults(result: any): number {
    if (Array.isArray(result)) return result.length;
    if (result && typeof result === 'object') {
      return Object.keys(result).length;
    }
    return 1;
  }

  private updateHitRate(): void {
    const total = this.stats.hitCount + this.stats.missCount;
    this.stats.hitRate = total > 0 ? (this.stats.hitCount / total) * 100 : 0;
  }

  private updateStorageSize(): void {
    // 概算のメモリ使用量計算
    let size = 0;
    for (const entry of this.cache.values()) {
      size += JSON.stringify(entry).length * 2; // UTF-16なので2倍
    }
    this.stats.storageSize = size;
  }

  private resetStats(): void {
    this.stats = {
      totalEntries: 0,
      hitCount: 0,
      missCount: 0,
      hitRate: 0,
      storageSize: 0,
      expiredEntries: 0
    };
  }
}