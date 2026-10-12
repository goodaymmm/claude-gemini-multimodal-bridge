/**
 * MAX_RETRIES and RETRY_DELAY at the places that retry.
 *
 * tests/cache-env.test.mjs holds the parsing rules for retryPolicyFromEnv();
 * this file checks that every retry loop actually obeys them. Until 1.3.0 the
 * variables were documented and read nowhere, and ErrorHandler.retry turned an
 * explicit 0 into its default of 3 (`maxAttempts || maxRetries || 3`).
 *
 * MAX_RETRIES counts retries after the first attempt, as the README says: a
 * failing call runs MAX_RETRIES + 1 times, and MAX_RETRIES=0 runs it once.
 * RETRY_DELAY=0 throughout keeps these tests fast.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { after, afterEach, beforeEach, describe, it } from 'node:test';

import { AIStudioLayer } from '../dist/layers/AIStudioLayer.js';
import { ClaudeCodeLayer } from '../dist/layers/ClaudeCodeLayer.js';
import { MultimodalProcess } from '../dist/tools/multimodalProcess.js';
import { ErrorHandler, retry } from '../dist/utils/errorHandler.js';

const isWindows = process.platform === 'win32';

/** Set MAX_RETRIES / RETRY_DELAY for one test and put the old values back after it. */
const ENV_NAMES = ['MAX_RETRIES', 'RETRY_DELAY'];
let savedEnv = {};
beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_NAMES.map(name => [name, process.env[name]]));
  for (const name of ENV_NAMES) { delete process.env[name]; }
});
afterEach(() => {
  for (const name of ENV_NAMES) {
    if (savedEnv[name] === undefined) { delete process.env[name]; } else { process.env[name] = savedEnv[name]; }
  }
});

function setEnv(values) {
  Object.assign(process.env, values);
}

/** Await a promise that must reject; return how many times `counter()` reports the operation ran. */
async function attemptsOf(promise, counter) {
  await assert.rejects(promise);
  return counter();
}

describe('ErrorHandler.retry maps retries, not total runs', () => {
  function failing() {
    let calls = 0;
    const op = async () => { calls += 1; throw new Error('transient failure'); };
    return { op, calls: () => calls };
  }

  it('runs once with maxRetries 0 instead of falling back to the default', async () => {
    const { op, calls } = failing();
    await assert.rejects(retry(op, { maxRetries: 0, delay: 0 }), { code: 'MAX_RETRIES_EXCEEDED' });
    assert.equal(calls(), 1);
  });

  it('treats the maxAttempts alias the same way, 0 included', async () => {
    const zero = failing();
    assert.equal(await attemptsOf(retry(zero.op, { maxAttempts: 0, delay: 0 }), zero.calls), 1);
    const two = failing();
    assert.equal(await attemptsOf(retry(two.op, { maxAttempts: 2, delay: 0 }), two.calls), 3);
  });

  it('runs maxRetries + 1 times and keeps the default of 3 retries when unset', async () => {
    const two = failing();
    assert.equal(await attemptsOf(retry(two.op, { maxRetries: 2, delay: 0 }), two.calls), 3);
    const unset = failing();
    assert.equal(await attemptsOf(ErrorHandler.retry(unset.op, { delay: 0 }), unset.calls), 4);
  });
});

describe('AIStudioLayer retries', () => {
  /** A layer whose sub-server call always fails, counting the calls. */
  function failingLayer() {
    const layer = new AIStudioLayer();
    let calls = 0;
    layer.executeMCPCommand = async () => { calls += 1; throw new Error('sub-server failed'); };
    return { layer, calls: () => calls };
  }

  it('makes one attempt with MAX_RETRIES=0', async () => {
    setEnv({ MAX_RETRIES: '0', RETRY_DELAY: '0' });
    const { layer, calls } = failingLayer();
    assert.equal(await attemptsOf(layer.analyzeImage('/nowhere/image.png', 'detailed'), calls), 1);
  });

  it('makes three attempts with MAX_RETRIES=2', async () => {
    setEnv({ MAX_RETRIES: '2', RETRY_DELAY: '0' });
    const { layer, calls } = failingLayer();
    assert.equal(await attemptsOf(layer.analyzeImage('/nowhere/image.png', 'ocr'), calls), 3);
  });

  it('keeps its default of 2 retries when MAX_RETRIES is out of range', async () => {
    setEnv({ MAX_RETRIES: '11', RETRY_DELAY: '0' });
    const { layer, calls } = failingLayer();
    assert.equal(await attemptsOf(layer.analyzeImage('/nowhere/image.png', 'detailed'), calls), 3);
  });

  it('applies the policy to processMultimodal as well', async () => {
    setEnv({ MAX_RETRIES: '1', RETRY_DELAY: '0' });
    const { layer, calls } = failingLayer();
    // No files: validation and preparation have nothing to reject, so every
    // attempt reaches the (failing) sub-server call.
    assert.equal(await attemptsOf(layer.processMultimodal([], 'describe nothing'), calls), 2);
  });

  it('reads the environment per call, not once per instance', async () => {
    const { layer, calls } = failingLayer();
    setEnv({ MAX_RETRIES: '0', RETRY_DELAY: '0' });
    await assert.rejects(layer.analyzeImage('/nowhere/image.png', 'detailed'));
    setEnv({ MAX_RETRIES: '1' });
    await assert.rejects(layer.analyzeImage('/nowhere/image.png', 'detailed'));
    assert.equal(calls(), 1 + 2);
  });
});

describe('ClaudeCodeLayer retries', () => {
  // Not `cgmb-agy-*`: the workspace-isolation test scans tmpdir for that prefix.
  // In tmpdir, not the repository: resolveTrustedCommand refuses candidates
  // inside the working directory (see tests/claude-layer.test.mjs).
  const scratch = mkdtempSync(join(tmpdir(), 'cgmb-retry-'));
  after(() => rmSync(scratch, { recursive: true, force: true }));

  /**
   * A stub `claude` that answers the version and auth probes, fails every real
   * request, and appends one line to a counter file per request.
   */
  function failingClaude(name) {
    const dir = join(scratch, name);
    const script = join(dir, 'stub.mjs');
    const counter = join(dir, 'calls.log');
    mkdirSync(dir, { recursive: true });
    writeFileSync(counter, '', 'utf8');
    writeFileSync(script, `
      import { appendFileSync } from 'node:fs';
      const chunks = [];
      process.stdin.on('data', c => chunks.push(c));
      process.stdin.on('end', () => {
        if (process.argv.includes('--version')) { console.log('1.0.0-stub'); process.exit(0); }
        if (process.argv.includes('auth')) { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
        appendFileSync(${JSON.stringify(counter)}, 'call\\n');
        process.stderr.write('STUB_FAIL: upstream unavailable');
        process.exit(1);
      });
    `, 'utf8');
    if (isWindows) {
      writeFileSync(join(dir, 'claude.cmd'), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`, 'utf8');
    } else {
      writeFileSync(join(dir, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
    }
    const calls = () => readFileSync(counter, 'utf8').split('\n').filter(Boolean).length;
    return { dir, calls };
  }

  async function withStub(dir, fn) {
    const savedPath = process.env.PATH;
    const savedPathCased = process.env.Path;
    process.env.PATH = `${dir}${delimiter}${savedPath ?? ''}`;
    try {
      return await fn();
    } finally {
      if (savedPath === undefined) { delete process.env.PATH; } else { process.env.PATH = savedPath; }
      if (savedPathCased !== undefined) { process.env.Path = savedPathCased; }
    }
  }

  /** synthesize_response is one of the layer's retried paths. */
  async function synthesizeAttempts(name) {
    const { dir, calls } = failingClaude(name);
    await withStub(dir, () => assert.rejects(
      new ClaudeCodeLayer().execute({ action: 'synthesize_response', prompt: 'combine these' }),
      error => /STUB_FAIL|exited with code 1/.test(error.message),
    ));
    return calls();
  }

  it('makes one attempt with MAX_RETRIES=0', async () => {
    setEnv({ MAX_RETRIES: '0', RETRY_DELAY: '0' });
    assert.equal(await synthesizeAttempts('zero'), 1);
  });

  it('makes three attempts with MAX_RETRIES=2', async () => {
    setEnv({ MAX_RETRIES: '2', RETRY_DELAY: '0' });
    assert.equal(await synthesizeAttempts('two'), 3);
  });

  it('keeps its default of 3 retries when MAX_RETRIES is out of range', async () => {
    setEnv({ MAX_RETRIES: '-1', RETRY_DELAY: '0' });
    assert.equal(await synthesizeAttempts('out-of-range'), 4);
  });
});

describe('multimodal_process workflow retries', () => {
  /** A MultimodalProcess whose layer manager always fails, counting the calls. */
  function failingProcess() {
    const tool = new MultimodalProcess();
    let calls = 0;
    tool.layerManager = { processMultimodal: async () => { calls += 1; throw new Error('layer failed'); } };
    const run = () => tool.executeWorkflow({ prompt: 'p', workflow: 'analysis', files: [] }, []);
    return { run, calls: () => calls };
  }

  it('makes one attempt with MAX_RETRIES=0 and MAX_RETRIES + 1 otherwise', async () => {
    setEnv({ MAX_RETRIES: '0', RETRY_DELAY: '0' });
    const once = failingProcess();
    assert.equal(await attemptsOf(once.run(), once.calls), 1);

    setEnv({ MAX_RETRIES: '2' });
    const thrice = failingProcess();
    assert.equal(await attemptsOf(thrice.run(), thrice.calls), 3);
  });

  it('keeps its default of 3 retries when MAX_RETRIES is malformed', async () => {
    setEnv({ MAX_RETRIES: 'three', RETRY_DELAY: '0' });
    const { run, calls } = failingProcess();
    assert.equal(await attemptsOf(run(), calls), 4);
  });
});
