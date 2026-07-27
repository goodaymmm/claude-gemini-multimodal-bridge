/**
 * MCP tool surface.
 *
 * The five tools CGMBServer registers are what every caller actually touches,
 * and they had no coverage at all: the migration tests only reached the layers
 * underneath. Everything here is hermetic -- each case is chosen to finish
 * before a layer is invoked, so no API key and no network are needed.
 *
 * Handlers are `private` in TypeScript only; the compiled output in dist/
 * exposes them, which is the same access the existing LayerManager tests use.
 */

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { CGMBServer } from '../dist/core/CGMBServer.js';
import { LayerManager } from '../dist/core/LayerManager.js';
import { AntigravityCLILayer } from '../dist/layers/AntigravityCLILayer.js';
import { LayerTypeSchema, TargetLayerSchema, normalizeLayerName, taskFileRefs } from '../dist/core/types.js';

/**
 * A server whose layers are stubs.
 *
 * Stubbing is the default here, not an opt-in, because it is easy to write a
 * case that looks like it will be rejected up front and is not: `documents: []`
 * satisfies the schema, so it routes, and running this file under WSL showed it
 * launching the real Claude CLI. That makes the suite slow, dependent on a
 * working install, and weaker than it reads -- "did not succeed" can then be
 * satisfied by an unrelated failure.
 *
 * The recorded calls hang off the returned server so a test can assert that
 * nothing was invoked at all.
 */
function makeServer() {
  const server = new CGMBServer();
  const calls = [];
  const manager = server.layerManager;

  for (const [name, field] of [
    ['aistudio', 'aiStudioLayer'],
    ['claude', 'claudeLayer'],
    ['antigravity', 'antigravityLayer'],
  ]) {
    const stub = {
      initialize: async () => {},
      isAvailable: async () => true,
      execute: async task => {
        calls.push({ layer: name, task });
        return { success: true, data: `stub:${name}`, metadata: { layer: name, duration: 0 } };
      },
    };
    manager[field] = stub;
    manager[`${field}Promise`] = Promise.resolve(stub);
    manager.layerInitialized[name] = true;
  }

  server.stubCalls = calls;
  return server;
}

/** Pull the JSON payload back out of a CallToolResult. */
function payloadOf(result) {
  assert.ok(Array.isArray(result?.content), 'a CallToolResult must carry content');
  const text = result.content.map(c => c.text ?? '').join('');
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

/**
 * Assert a handler call did not succeed.
 *
 * There are two legitimate failure shapes and both are correct: schema
 * rejection throws a CGMBError out of safeExecute, while a request that parses
 * and then fails downstream comes back as `success: false` with `isError` set.
 * What must never happen is a plain success, so that is what this checks.
 */
async function assertNotSuccessful(call, label) {
  let result;
  try {
    result = await call();
  } catch {
    return; // threw before producing a result -- a valid rejection
  }
  const payload = payloadOf(result);
  assert.notEqual(payload.success, true, `must not succeed: ${label}`);
  if (payload.success === false) {
    assert.equal(result.isError, true, `a failed payload must set isError: ${label}`);
  }
}

describe('server construction', () => {
  it('builds without credentials or network', () => {
    // Registering the tools happens in the constructor. If that ever starts
    // reaching for a key, every MCP consumer breaks at startup rather than at
    // first use, so it is worth pinning.
    assert.doesNotThrow(() => makeServer());
  });
});

describe('argument validation', () => {
  // Each handler parses with a zod schema before touching a layer, so bad
  // input must fail here rather than surfacing as a layer error later.

  it('rejects malformed document analysis arguments', async () => {
    const server = makeServer();

    for (const bad of [
      {},                                                   // missing everything
      { documents: [], analysis_type: 'summary' },          // nothing to analyse
      { documents: ['a.pdf'] },                             // missing analysis_type
      { documents: ['a.pdf'], analysis_type: 'telepathy' }, // not in the enum
      { documents: [''], analysis_type: 'summary' },        // empty path
    ]) {
      await assertNotSuccessful(
        () => server.handleDocumentAnalysis(bad),
        JSON.stringify(bad)
      );
    }
  });

  it('rejects malformed multimodal arguments', async () => {
    const server = makeServer();

    for (const bad of [
      {},
      { files: [{ path: 'a.txt', type: 'text' }], workflow: 'analysis' },      // no prompt
      { prompt: 'hi', workflow: 'analysis', files: 'not-an-array' },
      { prompt: 'hi', workflow: 'analysis', files: [{ path: 'a.txt', type: 'telepathy' }] },
      { prompt: 'hi', files: [] },                                             // no workflow
      { prompt: 'hi', files: [], workflow: 'telepathy' },
    ]) {
      await assertNotSuccessful(
        () => server.handleMultimodalProcess(bad),
        JSON.stringify(bad)
      );
    }
  });

  it('rejects malformed workflow arguments', async () => {
    const server = makeServer();

    for (const bad of [{}, { steps: 'nope' }, { name: 'x' }]) {
      await assertNotSuccessful(
        () => server.handleWorkflowOrchestration(bad),
        JSON.stringify(bad)
      );
    }
  });
});

describe('failure is reported as failure', () => {
  // A past defect derived success from a count of failed steps and reported a
  // failed run as a successful one. toCallToolResult is the single place that
  // decision is now made, so it is the place to hold it.

  it('sets isError when the result says it failed', () => {
    const server = makeServer();

    const failed = server.toCallToolResult({ success: false, error: 'boom' });
    assert.equal(failed.isError, true, 'a failed result must set isError');
    assert.match(payloadOf(failed).error, /boom/, 'the reason must survive');

    const ok = server.toCallToolResult({ success: true, data: 'fine' });
    assert.notEqual(ok.isError, true, 'a successful result must not set isError');
  });

  it('does not mark a result with no success field as an error', () => {
    // Handlers that return raw text (the fast path) have no success field.
    // Treating that as failure would make every fast-path call look broken.
    const server = makeServer();
    assert.notEqual(server.toCallToolResult({ data: 'text' }).isError, true);
  });
});

describe('deprecated gemini layer name', () => {
  // The layer was renamed to antigravity, but requests written against the old
  // name must keep working -- that is the whole point of the alias.

  it('accepts gemini and antigravity, and rejects anything else', () => {
    for (const name of ['antigravity', 'gemini', 'claude', 'aistudio']) {
      assert.equal(LayerTypeSchema.safeParse(name).success, true, `${name} must parse`);
    }
    for (const name of ['adaptive', 'antigravity', 'gemini', 'aistudio']) {
      assert.equal(TargetLayerSchema.safeParse(name).success, true, `${name} must parse`);
    }

    for (const name of ['geminicli', 'agy', 'openai', '']) {
      assert.equal(
        LayerTypeSchema.safeParse(name).success, false,
        `${name} must not parse as a layer`
      );
    }
  });

  it('normalizes only the deprecated name', () => {
    assert.equal(normalizeLayerName('gemini'), 'antigravity');
    assert.equal(normalizeLayerName('antigravity'), 'antigravity');
    assert.equal(normalizeLayerName('claude'), 'claude');
    assert.equal(normalizeLayerName('aistudio'), 'aistudio');
  });
});

describe('credential files are refused through the MCP path too', () => {
  // assertNoCredentialFiles guards the AI Studio egress inside LayerManager.
  // Reaching it from a handler proves the guard is not bypassed by the MCP
  // entry point, which is where untrusted arguments actually arrive.
  //
  // makeServer() stubs the layers, so "no layer was invoked" is assertable.

  it('refuses a credential-named document before any layer runs', async () => {
    const server = makeServer();
    const calls = server.stubCalls;

    await assertNotSuccessful(
      () => server.handleDocumentAnalysis({
        documents: [join(process.cwd(), '.env')],
        analysis_type: 'summary',
      }),
      'a .env must never be analysed'
    );

    assert.deepEqual(calls, [], 'no layer may be invoked for a credential file');
  });

  it('refuses a credential-named file in a multimodal request', async () => {
    const server = makeServer();
    const calls = server.stubCalls;

    await assertNotSuccessful(
      () => server.handleMultimodalProcess({
        prompt: 'Summarise this',
        workflow: 'analysis',
        files: [{ path: join(process.cwd(), 'id_rsa'), type: 'text' }],
      }),
      'a private key must never be sent'
    );

    assert.deepEqual(calls, [], 'no layer may be invoked for a private key');
  });
});

describe('files and documents name the same thing', () => {
  // The codebase carries file references under two keys: `files` for multimodal
  // work, `documents` for document analysis. Every guard and router read only
  // `files`, so a document-analysis task looked like plain text: it routed to
  // layers that cannot read files, walked through the search layer's file
  // guard, and the routing capability filter never fired. taskFileRefs is the
  // single place both keys are read; these tests hold the callers to it.

  const DOC = '/tmp/report.pdf';

  it('collects both keys and normalises bare paths', () => {
    assert.deepEqual(
      taskFileRefs({ documents: [DOC] }),
      [{ path: DOC, type: 'document' }],
      'a bare path string becomes a document reference'
    );

    assert.deepEqual(
      taskFileRefs({ files: [{ path: DOC, type: 'pdf' }] }),
      [{ path: DOC, type: 'pdf' }],
      'an existing type is preserved'
    );

    assert.equal(taskFileRefs({ files: [{ path: DOC }], documents: [DOC] }).length, 2);
    assert.deepEqual(taskFileRefs({ prompt: 'hi' }), []);
    assert.deepEqual(taskFileRefs(undefined), []);
    assert.deepEqual(taskFileRefs({ documents: [''] }), [], 'empty paths are dropped');
  });

  it('makes routing see a documents-only task as carrying files', () => {
    const manager = new LayerManager();

    assert.equal(
      manager.analyzeTask({ documents: [DOC], prompt: 'Summarise' }).hasFiles, true,
      'documents must count as files for routing'
    );

    // Which in turn makes the capability filter fire: nothing but AI Studio can
    // read them, so a failed AI Studio leaves no usable fallback.
    assert.deepEqual(
      manager.getFallbackOrder('aistudio', { documents: [DOC], prompt: 'Summarise' }),
      [],
      'a documents-carrying task must not fall back to a layer that cannot read files'
    );
  });

  it('makes the search layer refuse a documents-only task', async () => {
    const layer = new AntigravityCLILayer();

    await assert.rejects(
      () => layer.execute({ type: 'multimodal', prompt: 'Summarise', documents: [DOC] }),
      /cannot process files/i,
      'reading only task.files let this straight past the guard'
    );
  });

  it('routes document analysis to AI Studio with the paths and instructions intact', async () => {
    const server = makeServer();

    await server.handleDocumentAnalysis({
      documents: [DOC],
      analysis_type: 'summary',
      output_requirements: 'One sentence.',
    });

    const aistudio = server.stubCalls.find(c => c.layer === 'aistudio');
    assert.ok(aistudio, 'the AI Studio layer must be reached');
    assert.equal(aistudio.task.action, 'process_documents');
    assert.deepEqual(aistudio.task.documents, [DOC], 'the paths must survive routing');

    // Without this the request reached the model with nothing to ask, and the
    // answer came back "the document was not provided" -- as a success.
    assert.ok(
      typeof aistudio.task.instructions === 'string' && aistudio.task.instructions.trim() !== '',
      'instructions must not be empty'
    );

    // And no step may be handed to a layer that cannot read the documents.
    assert.deepEqual(
      server.stubCalls.filter(c => c.layer === 'antigravity'), [],
      'the search layer must not receive the document step'
    );
  });
});

describe('layer requirements', () => {
  it('describes every routable target, and says the search layer takes no files', async () => {
    const server = makeServer();
    const payload = payloadOf(await server.handleGetLayerRequirements());

    // The tool exists so a caller can route correctly without reading the
    // source, so it must cover everything TargetLayerSchema accepts. Claude is
    // deliberately absent: it is not a routable target, only a fallback.
    for (const layer of ['gemini', 'aistudio', 'adaptive']) {
      assert.ok(payload[layer], `requirements must cover ${layer}`);
    }
    assert.equal(
      TargetLayerSchema.safeParse('claude').success, false,
      'claude is not a routable target, which is why it has no entry'
    );

    // The search layer refuses files outright. Advertising otherwise would
    // send callers straight into that refusal.
    const searchText = JSON.stringify(payload.gemini).toLowerCase();
    assert.match(
      searchText, /no file|text only|text-only/,
      'the search layer must be documented as text-only'
    );
  });
});
