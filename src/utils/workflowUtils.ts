/**
 * Workflow utility functions for common operations across all workflow types
 */

import { ResourceEstimate } from '../core/types.js';

/**
 * Complexity multipliers for resource estimation
 */
export const COMPLEXITY_MULTIPLIERS = {
  low: { tokens: 1, score: 1, duration: 1, cost: 1 },
  medium: { tokens: 1.5, score: 1.3, duration: 2, cost: 1.5 },
  high: { tokens: 2.5, score: 2, duration: 4, cost: 2.5 },
} as const;

/**
 * Duration multipliers by complexity
 */
export const DURATION_FACTORS = {
  low: 1,
  medium: 1.5,
  high: 2.5,
} as const;

/**
 * Cost multipliers by complexity
 */
export const COST_FACTORS = {
  low: 1,
  medium: 1.5,
  high: 2.5,
} as const;

export type ComplexityLevel = 'low' | 'medium' | 'high';

/**
 * Convert a numeric complexity score to a complexity level
 * Standard thresholds: >=6 = high, >=3 = medium, else = low
 */
export function scoreToComplexity(score: number): ComplexityLevel {
  if (score >= 6) {
    return 'high';
  }
  if (score >= 3) {
    return 'medium';
  }
  return 'low';
}

/**
 * Calculate score contribution based on value and thresholds
 * @example getThresholdScore(7, [[10, 3], [5, 2], [0, 1]]) => 2
 */
export function getThresholdScore(
  value: number,
  thresholds: Array<[number, number]>
): number {
  for (const [threshold, score] of thresholds) {
    if (value > threshold) {
      return score;
    }
  }
  return 0;
}

/**
 * Calculate resource estimate with standard complexity multipliers
 */
export function calculateResourceEstimate(
  baseValues: {
    memory: number;
    cpu: number;
    duration: number;
    cost: number;
  },
  inputMultiplier: number,
  complexity: ComplexityLevel
): ResourceEstimate {
  const multiplier = COMPLEXITY_MULTIPLIERS[complexity];

  return {
    estimated_tokens: baseValues.memory * inputMultiplier * multiplier.tokens,
    complexity_score: baseValues.cpu * multiplier.score,
    estimated_duration: baseValues.duration * inputMultiplier * multiplier.duration,
    recommended_execution_mode: 'adaptive' as const,
    required_capabilities: ['claude', 'antigravity', 'aistudio'] as const,
    estimated_cost: baseValues.cost * inputMultiplier * multiplier.cost,
  };
}

/**
 * Estimate duration based on base time, multiplier, and complexity
 */
export function estimateDuration(
  baseTime: number,
  multiplier: number,
  complexity: ComplexityLevel
): number {
  return baseTime * multiplier * DURATION_FACTORS[complexity];
}

/**
 * Estimate cost based on base cost, multiplier, and complexity
 */
export function estimateCost(
  baseCost: number,
  multiplier: number,
  complexity: ComplexityLevel
): number {
  return baseCost * multiplier * COST_FACTORS[complexity];
}

/**
 * Common file type categories for workflow processing
 */
export const FILE_CATEGORIES = {
  document: ['pdf', 'doc', 'docx', 'txt', 'md', 'rtf', 'odt'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'tiff'],
  audio: ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a'],
  video: ['mp4', 'webm', 'avi', 'mov', 'mkv'],
  data: ['json', 'xml', 'csv', 'yaml', 'yml'],
  code: ['ts', 'js', 'py', 'java', 'cpp', 'c', 'go', 'rs', 'rb'],
} as const;

/**
 * Get file category from extension
 */
export function getFileCategory(
  extension: string
): keyof typeof FILE_CATEGORIES | 'unknown' {
  const ext = extension.toLowerCase().replace('.', '');
  for (const [category, extensions] of Object.entries(FILE_CATEGORIES)) {
    if ((extensions as readonly string[]).includes(ext)) {
      return category as keyof typeof FILE_CATEGORIES;
    }
  }
  return 'unknown';
}

/**
 * Supported format mappings for validation
 */
export const SUPPORTED_FORMATS = {
  document: {
    input: ['pdf', 'doc', 'docx', 'txt', 'md', 'rtf', 'html'],
    output: ['pdf', 'docx', 'md', 'txt', 'html'],
  },
  image: {
    input: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'],
    output: ['png', 'jpg', 'webp', 'gif'],
  },
  audio: {
    input: ['mp3', 'wav', 'ogg', 'flac', 'aac'],
    output: ['mp3', 'wav', 'ogg'],
  },
  data: {
    input: ['json', 'xml', 'csv', 'yaml'],
    output: ['json', 'xml', 'csv', 'yaml'],
  },
} as const;

/**
 * Validate conversion between formats
 */
export function validateConversionFormat(
  type: keyof typeof SUPPORTED_FORMATS,
  sourceFormat: string,
  targetFormat: string
): { valid: boolean; error?: string } {
  const formats = SUPPORTED_FORMATS[type];
  const sourceExt = sourceFormat.toLowerCase().replace('.', '');
  const targetExt = targetFormat.toLowerCase().replace('.', '');

  const inputFormats = formats.input as readonly string[];
  const outputFormats = formats.output as readonly string[];

  if (!inputFormats.includes(sourceExt)) {
    return {
      valid: false,
      error: `Unsupported source format for ${type}: ${sourceFormat}`,
    };
  }

  if (!outputFormats.includes(targetExt)) {
    return {
      valid: false,
      error: `Unsupported target format for ${type}: ${targetFormat}`,
    };
  }

  return { valid: true };
}

// ===================================
// Reading an answer out of a workflow result
// ===================================

/**
 * The displayable text carried by one layer or workflow-step result.
 *
 * Layers and MCP servers have returned four different shapes over time -- a
 * string in `data`, an MCP content array under `data.content`, the same array
 * directly on `content`, and a bare string `content` -- and every consumer grew
 * its own copy of the probe. CGMBServer had two copies in a single method.
 * Returns null when nothing usable is present.
 */
export function extractResultText(value: unknown): string | null {
  const result = value as {
    data?: unknown;
    content?: unknown;
  } | null | undefined;

  if (!result || typeof result !== 'object') {
    return null;
  }

  // 1. A string straight off `data`.
  if (typeof result.data === 'string' && result.data.trim()) {
    return result.data;
  }

  // 2. An MCP content array nested under `data`.
  const nested = (result.data as { content?: unknown } | null | undefined)?.content;
  const fromNested = textFromContent(nested);
  if (fromNested !== null) {
    return fromNested;
  }

  // 3 & 4. `content` directly, as an array, a string, or something else.
  return textFromContent(result.content);
}

/** The text inside an MCP-style content value, or null. */
function textFromContent(content: unknown): string | null {
  if (content === undefined || content === null) {
    return null;
  }

  if (Array.isArray(content)) {
    const text = (content[0] as { text?: unknown } | undefined)?.text;
    // Checked, not assumed. The previous probes assigned this straight through,
    // so a numeric or object `text` became the response body.
    return typeof text === 'string' && text.trim() ? text : null;
  }

  if (typeof content === 'string') {
    return content.trim() ? content : null;
  }

  return JSON.stringify(content);
}

/**
 * The answer to show for a set of layer or step results.
 *
 * Walks from the end and skips failed results. Taking `[0]` -- which is what
 * every copy of this did -- returns whatever ran first: in a named workflow
 * that is the preprocess step, or a failed step, presented as the final answer.
 * The last result that succeeded and carries text is the one the caller asked
 * for.
 */
export function pickFinalResultText(results: readonly unknown[]): string | null {
  for (let index = results.length - 1; index >= 0; index--) {
    const result = results[index] as { success?: unknown } | null | undefined;

    if (result?.success === false) {
      continue;
    }

    const text = extractResultText(result);
    if (text !== null) {
      return text;
    }
  }

  return null;
}
