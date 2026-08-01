/**
 * The search cache, which had no tests at all.
 *
 * Found when the test suite itself was reviewed. normalizeQuery rewrote every
 * year from 2024 to 2029 into one token, so "AI news 2024" and "AI news 2026"
 * hashed to the same key and the later search silently returned the earlier
 * answer. A year is the part of a search that says which facts are wanted, and
 * this layer exists to fetch current information.
 *
 * The key also left out the model, so changing ANTIGRAVITY_MODEL returned the
 * previous model's results for the same words.
 *
 * Both are reached through the public get/set, not by reaching into the key
 * builder -- the defect was in what callers observe, so that is what is checked.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SearchCache } from '../dist/utils/SearchCache.js';

const MODEL = 'gemini-3.6-flash-low';

/** A cache with fuzzy matching off, so a case means what it says. */
function cache(options = {}) {
  return new SearchCache({ ttl: 60000, maxEntries: 100, ...options });
}

describe('a year is part of the question', () => {
  it('does not answer a 2026 search from a 2024 one', async () => {
    const store = cache();
    await store.set('AI news 2024', { content: 'answer about 2024' }, 'antigravity', 0, MODEL);

    assert.equal(
      await store.get('AI news 2026', 'antigravity', MODEL), null,
      'these are different questions and only one of them has been asked'
    );
  });

  it('still answers the same year from cache', async () => {
    const store = cache();
    await store.set('AI news 2024', { content: 'answer about 2024' }, 'antigravity', 0, MODEL);

    assert.deepEqual(
      await store.get('AI news 2024', 'antigravity', MODEL), { content: 'answer about 2024' },
      'the cache must still be a cache'
    );
  });

  it('keeps every year in the range apart', async () => {
    // 2024 through 2029 were one token; each pair below collided.
    const store = cache();
    for (const year of [2024, 2025, 2026, 2027, 2028, 2029]) {
      await store.set(`release notes ${year}`, { content: String(year) }, 'antigravity', 0, MODEL);
    }

    for (const year of [2024, 2025, 2026, 2027, 2028, 2029]) {
      const hit = await store.get(`release notes ${year}`, 'antigravity', MODEL);
      assert.equal(hit?.content, String(year), `${year} came back as ${hit?.content}`);
    }
  });
});

describe('the model is part of the answer', () => {
  it('does not serve one model from another', async () => {
    const store = cache();
    await store.set('what changed today', { content: 'from flash' }, 'antigravity', 0, 'gemini-3.6-flash-low');

    assert.equal(
      await store.get('what changed today', 'antigravity', 'gemini-3-pro-preview'), null,
      'the response would carry the wrong model with nothing to show for it'
    );
  });

  it('serves the same model from cache', async () => {
    const store = cache();
    await store.set('what changed today', { content: 'from flash' }, 'antigravity', 0, MODEL);

    assert.deepEqual(await store.get('what changed today', 'antigravity', MODEL), { content: 'from flash' });
  });

  it('keeps the search engine apart as before', async () => {
    const store = cache();
    await store.set('same words', { content: 'antigravity' }, 'antigravity', 0, MODEL);

    assert.equal(await store.get('same words', 'aistudio', MODEL), null);
  });
});

describe('the parts of the contract nothing was checking', () => {
  it('lets an entry expire', async () => {
    const store = cache({ ttl: 40 });
    await store.set('short lived', { content: 'x' }, 'antigravity', 0, MODEL);

    assert.notEqual(await store.get('short lived', 'antigravity', MODEL), null, 'fresh');
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(await store.get('short lived', 'antigravity', MODEL), null, 'expired');
  });

  it('stays within its entry limit', async () => {
    const store = cache({ maxEntries: 10 });

    for (let i = 0; i < 40; i++) {
      await store.set(`query number ${i}`, { content: String(i) }, 'antigravity', 0, MODEL);
    }

    assert.ok(
      store.getStats().totalEntries <= 10,
      `the cap is the point of the cap, got ${store.getStats().totalEntries}`
    );
  });

  it('counts a miss as a miss', async () => {
    const store = cache();
    await store.get('never stored', 'antigravity', MODEL);

    const stats = store.getStats();
    assert.equal(stats.missCount, 1);
    assert.equal(stats.hitCount, 0);
  });
});

describe('a time range is part of the question too', () => {
  // Second review finding on the same file. 最近の and 最新の were folded into
  // one token by the phrasing normalisation: measured, "最近の台風を一覧にして"
  // and "最新の台風を一覧にして" shared a key, so a question about a span was
  // answered from one about whatever is newest. Same class as the year, and the
  // phrasing rewrites are where it hid.

  it('keeps 最近の and 最新の apart', async () => {
    const store = cache();
    await store.set('最近の台風を一覧にして', { content: 'a span of storms' }, 'antigravity', 0, MODEL);

    assert.equal(
      await store.get('最新の台風を一覧にして', 'antigravity', MODEL), null,
      'one asks about a period, the other about the newest thing'
    );
  });

  it('keeps 新しい apart from both', async () => {
    const store = cache();
    await store.set('新しい仕様を教えて', { content: 'new spec' }, 'antigravity', 0, MODEL);

    assert.equal(await store.get('最新の仕様を教えて', 'antigravity', MODEL), null);
  });

  it('still folds the phrasings that are only phrasings', async () => {
    // Deliberately kept: these change how the question is asked, not what is
    // being asked. Pinned so the line between the two stays where it was put.
    const store = cache();
    await store.set('AIについて教えて', { content: 'about AI' }, 'antigravity', 0, MODEL);

    assert.deepEqual(
      await store.get('AIを説明して', 'antigravity', MODEL), { content: 'about AI' },
      'wording may be normalised'
    );
  });
});
