/**
 * The contracts of the wrapper every layer call goes through.
 *
 * errorHandler had no tests at all, which is how its AbortController came to be
 * created, aborted on timeout, and handed to nobody: the operation never saw
 * the signal, so a timeout ended the waiting while the work carried on. That
 * particular hole is covered end to end in timeout-cancellation.test.mjs; this
 * file pins the surrounding behaviour that made it survivable -- what a caller
 * is told, what is retried, and what stops.
 */

import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { describe, it } from 'node:test';

import {
  ErrorHandler,
  handleLayerError,
  recoverFromError,
  retry,
  safeExecute,
} from '../dist/utils/errorHandler.js';
import { CGMBError, LayerError } from '../dist/core/types.js';

const settle = (ms = 300) => new Promise(resolve => setTimeout(resolve, ms));

describe('safeExecute: what the caller is told', () => {
  it('returns the value untouched and cancels nothing on success', async () => {
    let aborted = false;

    const result = await safeExecute(async (signal) => {
      signal.addEventListener('abort', () => { aborted = true; }, { once: true });
      return { ok: 'value' };
    }, { operationName: 'happy-path' });

    assert.deepEqual(result, { ok: 'value' });
    assert.equal(aborted, false, 'finished work has nothing to cancel');
  });

  it('gives the operation a live signal even with no timeout set', async () => {
    // The no-timeout branch used to call operation() with no arguments at all,
    // so an operation written to honour cancellation silently got undefined.
    let received;

    await safeExecute(async (signal) => { received = signal; }, { operationName: 'no-timeout' });

    assert.ok(received instanceof AbortSignal, 'the operation must always get a signal');
    assert.equal(received.aborted, false, 'and a call that succeeded has nothing to cancel');
  });

  it('fires the signal when a call with no timeout fails', async () => {
    // The failure path is the one that matters here: without a timeout there is
    // no timer to abort anything, so if the catch does not, nothing does.
    let aborted = false;

    await assert.rejects(() => safeExecute(async (signal) => {
      signal.addEventListener('abort', () => { aborted = true; }, { once: true });
      throw new Error('inner failure');
    }, { operationName: 'no-timeout-failure' }), /inner failure/);

    assert.equal(aborted, true, 'the caller was told it failed, so nothing may still be running');
  });

  it('reports a timeout as a CGMBError naming the operation', async () => {
    await assert.rejects(
      () => safeExecute(
        () => new Promise(resolve => setTimeout(resolve, 30000)),
        { operationName: 'slow-thing', timeout: 300 }
      ),
      (error) => {
        assert.ok(error instanceof CGMBError, `expected CGMBError, got ${error?.constructor?.name}`);
        assert.equal(error.code, 'TIMEOUT_ERROR');
        assert.match(error.message, /slow-thing/, 'the caller must be told which operation gave up');
        return true;
      }
    );
  });

  it('wraps a plain failure as a LayerError when a layer was named', async () => {
    await assert.rejects(
      () => safeExecute(async () => { throw new Error('upstream said no'); }, {
        operationName: 'layer-call',
        layer: 'aistudio',
      }),
      (error) => {
        assert.ok(error instanceof LayerError, `expected LayerError, got ${error?.constructor?.name}`);
        assert.equal(error.layer, 'aistudio');
        assert.match(error.message, /upstream said no/, 'the original message must survive');
        return true;
      }
    );
  });

  it('passes a CGMBError through rather than wrapping it again', async () => {
    // Double-wrapping buries the code the caller switches on.
    const original = new CGMBError('nope', 'AUTH_ERROR', 'aistudio');

    await assert.rejects(
      () => safeExecute(async () => { throw original; }, { operationName: 'x', layer: 'aistudio' }),
      (error) => {
        assert.equal(error, original, 'the same error object must arrive');
        assert.equal(error.code, 'AUTH_ERROR');
        return true;
      }
    );
  });

  it('inherits a cancellation the caller already has', async () => {
    // Layer calls nest: the outer one giving up has to reach the inner work.
    const outer = new AbortController();
    let innerAborted = false;

    const inFlight = safeExecute(async (signal) => {
      signal.addEventListener('abort', () => { innerAborted = true; }, { once: true });
      await new Promise(resolve => setTimeout(resolve, 5000));
      return 'finished';
    }, { operationName: 'nested', signal: outer.signal, timeout: 30000 });

    inFlight.catch(() => {});
    await settle(100);
    outer.abort();
    await settle(100);

    assert.equal(innerAborted, true, 'an outer cancellation must reach the inner operation');
  });

  it('starts already-cancelled when the caller has given up before the call', async () => {
    const outer = new AbortController();
    outer.abort();
    let seenAtStart;

    await safeExecute(async (signal) => { seenAtStart = signal.aborted; }, {
      operationName: 'already-gone',
      signal: outer.signal,
    });

    assert.equal(seenAtStart, true, 'work must not begin as though nobody had cancelled');
  });

  it('stops listening to a caller signal that outlives the call', async () => {
    // A listener left on a long-lived signal is a leak that grows with every
    // request the caller makes.
    const outer = new AbortController();

    for (let i = 0; i < 20; i += 1) {
      await safeExecute(async () => 'done', { operationName: `n-${i}`, signal: outer.signal });
    }

    // Asked of the signal itself rather than through an optional method that
    // may not exist -- a check that degrades to `undefined === undefined`
    // passes whether or not anything was removed.
    assert.deepEqual(
      getEventListeners(outer.signal, 'abort'), [],
      'each finished call must remove its own listener'
    );
  });
});

describe('retry: what is worth trying again', () => {
  it('returns the first success without further attempts', async () => {
    let attempts = 0;

    const result = await retry(async () => {
      attempts += 1;
      return 'first time';
    }, { maxRetries: 3, delay: 1 });

    assert.equal(result, 'first time');
    assert.equal(attempts, 1, 'a success must not be retried');
  });

  it('retries a transient failure and reports the attempt that worked', async () => {
    let attempts = 0;

    const result = await retry(async () => {
      attempts += 1;
      if (attempts < 3) { throw new Error('temporarily unavailable'); }
      return 'recovered';
    }, { maxRetries: 3, delay: 1, backoffMultiplier: 1 });

    assert.equal(result, 'recovered');
    assert.equal(attempts, 3);
  });

  it('gives up after the stated number of retries, not one more', async () => {
    let attempts = 0;

    await assert.rejects(
      () => retry(async () => {
        attempts += 1;
        throw new Error('still unavailable');
      }, { maxRetries: 2, delay: 1, backoffMultiplier: 1 }),
      (error) => {
        assert.equal(error.code, 'MAX_RETRIES_EXCEEDED');
        assert.match(error.message, /still unavailable/, 'the last real cause must survive');
        return true;
      }
    );

    assert.equal(attempts, 3, 'maxRetries 2 means the first attempt plus two more');
  });

  it('does not retry an error that retrying cannot fix', async () => {
    // Retrying an auth or validation failure spends the user's quota to be told
    // the same thing three more times.
    for (const code of ['AUTH_ERROR', 'PERMISSION_ERROR', 'VALIDATION_ERROR', 'NOT_FOUND_ERROR']) {
      let attempts = 0;

      await assert.rejects(
        () => retry(async () => {
          attempts += 1;
          throw new CGMBError('refused', code);
        }, { maxRetries: 3, delay: 1 }),
        (error) => {
          assert.equal(error.code, code, 'the original refusal must reach the caller unchanged');
          return true;
        }
      );

      assert.equal(attempts, 1, `${code} must not be retried`);
    }
  });

  it('accepts maxAttempts as the name for the same thing', async () => {
    let attempts = 0;

    await assert.rejects(() => retry(async () => {
      attempts += 1;
      throw new Error('no');
    }, { maxAttempts: 1, delay: 1, backoffMultiplier: 1 }));

    assert.equal(attempts, 2, 'the alias must not silently fall back to the default of 3');
  });
});

describe('circuit breaker: when to stop asking', () => {
  it('opens after the threshold and fails fast without calling through', async () => {
    let calls = 0;
    const breaker = ErrorHandler.createCircuitBreaker(async () => {
      calls += 1;
      throw new Error('service down');
    }, { failureThreshold: 2, timeout: 1000, resetTimeout: 60000 });

    await assert.rejects(() => breaker(), /service down/);
    await assert.rejects(() => breaker(), /service down/);
    assert.equal(calls, 2);

    await assert.rejects(() => breaker(), (error) => {
      assert.equal(error.code, 'CIRCUIT_BREAKER_OPEN');
      return true;
    });
    assert.equal(calls, 2, 'an open circuit must not reach the service at all');
  });

  it('lets a call through once the reset window has passed, and closes on success', async () => {
    let calls = 0;
    let failing = true;
    const breaker = ErrorHandler.createCircuitBreaker(async () => {
      calls += 1;
      if (failing) { throw new Error('service down'); }
      return 'back';
    }, { failureThreshold: 1, timeout: 1000, resetTimeout: 200 });

    await assert.rejects(() => breaker(), /service down/);
    await assert.rejects(() => breaker(), (error) => error.code === 'CIRCUIT_BREAKER_OPEN');

    await settle(250);
    failing = false;

    assert.equal(await breaker(), 'back', 'the half-open probe must be allowed through');
    assert.equal(await breaker(), 'back', 'and success must close the circuit again');
    assert.equal(calls, 3);
  });
});

describe('error classification', () => {
  it('names the failure from what it says', () => {
    const cases = [
      ['request timeout after 30s', 'TIMEOUT_ERROR'],
      ['rate limit exceeded', 'RATE_LIMIT_ERROR'],
      ['authentication failed', 'AUTH_ERROR'],
      ['file not found', 'NOT_FOUND_ERROR'],
      ['permission denied', 'PERMISSION_ERROR'],
      ['something else entirely', 'UNKNOWN_ERROR'],
    ];

    for (const [message, expected] of cases) {
      const result = handleLayerError(new Error(message), 'antigravity');
      assert.ok(result instanceof LayerError);
      assert.equal(result.layer, 'antigravity');
      assert.equal(result.details.code, expected, `"${message}" must classify as ${expected}`);
    }
  });

  it('leaves an already-classified LayerError alone', () => {
    const original = new LayerError('known', 'claude', { code: 'AUTH_ERROR' });

    assert.equal(handleLayerError(original, 'aistudio'), original, 'reclassifying loses the layer');
  });
});

describe('recovery strategies', () => {
  it('uses the first strategy that works and stops there', async () => {
    const tried = [];

    const result = await recoverFromError(new Error('primary failed'), [
      async () => { tried.push('a'); throw new Error('a failed'); },
      async () => { tried.push('b'); return 'from b'; },
      async () => { tried.push('c'); return 'from c'; },
    ]);

    assert.equal(result, 'from b');
    assert.deepEqual(tried, ['a', 'b'], 'no strategy may run after one has succeeded');
  });

  it('reports that everything failed, keeping the original cause', async () => {
    const original = new Error('primary failed');

    await assert.rejects(
      () => recoverFromError(original, [
        async () => { throw new Error('a failed'); },
        async () => { throw new Error('b failed'); },
      ]),
      (error) => {
        assert.equal(error.code, 'RECOVERY_FAILED');
        assert.equal(error.details.originalError, original, 'the failure being recovered from must survive');
        return true;
      }
    );
  });
});
