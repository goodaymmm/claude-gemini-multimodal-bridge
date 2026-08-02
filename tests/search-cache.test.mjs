/**
 * What the search cache is allowed to treat as the same question.
 *
 * The cache key was built from the query text and the engine name, with the
 * query first put through a "normalisation" pass that folded any year 2024-2029
 * to the string 2024-2025 and collapsed 最新の / 最近の / 新しい to one word.
 * The model was not in the key at all.
 *
 * So "2024年の株価" and "2026年の株価" were the same entry, and a question asked
 * of one model was answered from another's reply. Nothing reports this: the
 * caller gets a successful result to a question it did not ask. A 30-minute TTL
 * bounds how long the wrong answer persists; it does not make it detectable.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SearchCache } from '../dist/utils/SearchCache.js';

/** A cache with metrics off and a long TTL, so nothing expires mid-test. */
function makeCache() {
  return new SearchCache({ ttl: 600000, maxEntries: 100, enableMetrics: false, similarityThreshold: 0.8 });
}

const result = (data) => ({
  success: true,
  data,
  metadata: { layer: 'antigravity', duration: 1 },
});

describe('the cache answers the question that was asked', () => {
  it('does not confuse one year with another', async () => {
    // The normalisation rewrote every year in 2024-2029 to the same token, so
    // these two questions shared an entry. Asking about 2026 returned the 2024
    // answer, as a success.
    const cache = makeCache();

    await cache.set('2024年の株価を教えて', result('2024 prices'), 'antigravity');
    const hit = await cache.get('2026年の株価を教えて', 'antigravity');

    assert.notEqual(
      hit?.data, '2024 prices',
      'a question about a different year must not be answered from this entry'
    );
  });

  it('does not treat "最近" and "最新" as the same question', async () => {
    const cache = makeCache();

    await cache.set('最新のニュースは', result('latest news'), 'antigravity');
    const hit = await cache.get('最近のニュースは', 'antigravity');

    assert.notEqual(hit?.data, 'latest news', 'these are different questions');
  });

  it('does not answer one model from another model reply', async () => {
    // Model is part of what produced the answer. Two models asked the same
    // question give different answers, and the caller chose which one it wanted.
    const cache = makeCache();

    await cache.set('capital of France', result('from flash'), 'antigravity', 'gemini-3.6-flash-low');
    const hit = await cache.get('capital of France', 'antigravity', 'gemini-3.1-pro-high');

    assert.notEqual(hit?.data, 'from flash', 'a different model must not share the entry');
  });

  it('still returns the entry it did store', async () => {
    // The rule has to stay useful: same question, same engine, same model is a
    // hit. A cache that never hits would be safe and pointless.
    const cache = makeCache();

    await cache.set('capital of France', result('Paris'), 'antigravity', 'gemini-3.6-flash-low');
    const hit = await cache.get('capital of France', 'antigravity', 'gemini-3.6-flash-low');

    assert.equal(hit?.data, 'Paris', 'an identical question must still hit');
  });
});
