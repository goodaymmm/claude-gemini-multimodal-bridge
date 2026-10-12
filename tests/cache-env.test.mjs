/**
 * The cache and retry environment variables the README documents.
 *
 * CACHE_TTL: the README's example is `CACHE_TTL=3600`, an hour. The Antigravity
 * layer handed the number to SearchCache as milliseconds, so following the
 * README gave a 3.6 second cache.
 *
 * ENABLE_CACHING: passed in as `enableMetrics`, which SearchCache never read.
 * ENABLE_CACHING=false left the cache answering requests.
 *
 * MAX_RETRIES / RETRY_DELAY: documented as tunable, read nowhere. They are now
 * parsed by retryPolicyFromEnv(); this file holds the parsing rules.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CACHE_TTL_LEGACY_MS_THRESHOLD,
  retryPolicyFromEnv,
  searchCacheSettingsFromEnv,
} from '../dist/utils/envLoader.js';
import { SearchCache } from '../dist/utils/SearchCache.js';
import { AntigravityCLILayer } from '../dist/layers/AntigravityCLILayer.js';

const result = { content: 'answer', timestamp: 0 };

describe('CACHE_TTL is in seconds', () => {
  it('reads the README example as an hour', () => {
    assert.equal(searchCacheSettingsFromEnv({ CACHE_TTL: '3600' }).ttlMs, 3_600_000);
  });

  it('reads 1 as one second', () => {
    // routing-matrix sets CACHE_TTL=1 to keep the cache out of its way.
    assert.equal(searchCacheSettingsFromEnv({ CACHE_TTL: '1' }).ttlMs, 1000);
  });

  it('accepts a fractional number of seconds', () => {
    assert.equal(searchCacheSettingsFromEnv({ CACHE_TTL: '0.5' }).ttlMs, 500);
  });

  it('defaults to 30 minutes', () => {
    assert.equal(searchCacheSettingsFromEnv({}).ttlMs, 1_800_000);
    assert.equal(searchCacheSettingsFromEnv({ CACHE_TTL: '' }).ttlMs, 1_800_000);
  });

  it('keeps the default for a value that is not a positive number', () => {
    // 0 would make every entry expire as it is written.
    for (const value of ['0', '-5', 'abc', '1h']) {
      assert.equal(searchCacheSettingsFromEnv({ CACHE_TTL: value }).ttlMs, 1_800_000, value);
    }
  });

  it('still reads a large legacy value as milliseconds', () => {
    // The old default, 1800000, was milliseconds; read as seconds it would be
    // three weeks.
    assert.equal(CACHE_TTL_LEGACY_MS_THRESHOLD, 100_000);
    assert.equal(searchCacheSettingsFromEnv({ CACHE_TTL: '1800000' }).ttlMs, 1_800_000);
    assert.equal(searchCacheSettingsFromEnv({ CACHE_TTL: '100000' }).ttlMs, 100_000);
    assert.equal(searchCacheSettingsFromEnv({ CACHE_TTL: '99999' }).ttlMs, 99_999_000);
  });
});

describe('ENABLE_CACHING', () => {
  it('is on unless switched off', () => {
    for (const value of [undefined, '', 'true', '1', 'yes', 'TRUE']) {
      assert.equal(searchCacheSettingsFromEnv({ ENABLE_CACHING: value }).enabled, true, String(value));
    }
  });

  it('is off for false, 0, no and off, in any case', () => {
    for (const value of ['false', 'FALSE', ' False ', '0', 'no', 'off']) {
      assert.equal(searchCacheSettingsFromEnv({ ENABLE_CACHING: value }).enabled, false, value);
    }
  });

  it('a disabled cache stores nothing and answers nothing', async () => {
    const cache = new SearchCache({ enabled: false, ttl: 600000 });
    await cache.set('what is new', result, 'antigravity', 1, 'm');

    assert.equal(await cache.get('what is new', 'antigravity', 'm'), null);
    assert.equal(cache.getStats().totalEntries, 0);
  });

  it('an enabled cache still answers', async () => {
    const cache = new SearchCache({ enabled: true, ttl: 600000 });
    await cache.set('what is new', result, 'antigravity', 1, 'm');

    assert.deepEqual(await cache.get('what is new', 'antigravity', 'm'), result);
  });

  it('reaches the Antigravity layer', async () => {
    // The layer is where the variables used to be misread, so check it there.
    const saved = { ENABLE_CACHING: process.env.ENABLE_CACHING, CACHE_TTL: process.env.CACHE_TTL };
    try {
      process.env.ENABLE_CACHING = 'false';
      process.env.CACHE_TTL = '3600';
      const off = new AntigravityCLILayer();
      assert.equal(off.searchCache.options.enabled, false);
      assert.equal(off.searchCache.options.ttl, 3_600_000);

      delete process.env.ENABLE_CACHING;
      const on = new AntigravityCLILayer();
      assert.equal(on.searchCache.options.enabled, true);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});

describe('MAX_CACHE_ENTRIES', () => {
  it('takes a positive integer and otherwise keeps 1000', () => {
    assert.equal(searchCacheSettingsFromEnv({ MAX_CACHE_ENTRIES: '50' }).maxEntries, 50);
    for (const value of [undefined, '', '0', '-1', '2.5', 'many']) {
      assert.equal(searchCacheSettingsFromEnv({ MAX_CACHE_ENTRIES: value }).maxEntries, 1000, String(value));
    }
  });
});

describe('MAX_RETRIES and RETRY_DELAY', () => {
  const defaults = { maxRetries: 2, delay: 3000 };

  it('keep the layer defaults when unset', () => {
    assert.deepEqual(retryPolicyFromEnv(defaults, {}), defaults);
  });

  it('override them when set', () => {
    assert.deepEqual(
      retryPolicyFromEnv(defaults, { MAX_RETRIES: '5', RETRY_DELAY: '250' }),
      { maxRetries: 5, delay: 250 }
    );
  });

  it('allow 0, meaning no retries and no wait', () => {
    assert.deepEqual(
      retryPolicyFromEnv(defaults, { MAX_RETRIES: '0', RETRY_DELAY: '0' }),
      { maxRetries: 0, delay: 0 }
    );
  });

  it('ignore malformed or out-of-range values', () => {
    for (const env of [
      { MAX_RETRIES: '-1' }, { MAX_RETRIES: '11' }, { MAX_RETRIES: 'three' }, { MAX_RETRIES: '2.5' },
      { RETRY_DELAY: '-1' }, { RETRY_DELAY: '60001' }, { RETRY_DELAY: '1s' },
    ]) {
      assert.deepEqual(retryPolicyFromEnv(defaults, env), defaults, JSON.stringify(env));
    }
  });

  it('accept the upper bounds', () => {
    assert.deepEqual(
      retryPolicyFromEnv(defaults, { MAX_RETRIES: '10', RETRY_DELAY: '60000' }),
      { maxRetries: 10, delay: 60000 }
    );
  });
});
