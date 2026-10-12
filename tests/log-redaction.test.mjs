/**
 * What reaches the log, and what a workflow step is handed, when input looks
 * like something it is not. Four findings from the security review:
 *
 * 1. Step references. Any string starting with `@` was read as `@step[.path]`:
 *    `@scope/pkg` or `@here is the text` became a `_stepMissing` marker in place
 *    of the text, and the whole string went to a warn log. Now a reference is
 *    `@` + a declared step id + an optional dotted path, and an unresolvable one
 *    is logged by step id and path only.
 * 2. (synthesis prompts carrying document paths -- see workflow-steps.test.mjs)
 * 3. URL redaction matched `scheme://` only. `data:` and `mailto:` URLs, bare
 *    `host.tld/path?token=...` and `/path?key=...` tails went to the log whole.
 * 4. Retry warnings logged the failure message whole -- up to 500 characters
 *    of a child process's output. So did safeExecute's error line, with the
 *    stack, and AI Studio logged the first 500 characters of every task --
 *    prompt and document paths included -- at info level.
 *
 * Log lines are captured from the logger's own winston instance, in process.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import Transport from 'winston-transport';

import { LayerManager } from '../dist/core/LayerManager.js';
import { AIStudioLayer } from '../dist/layers/AIStudioLayer.js';
import { firstLineForLog, hostsOf, redactUrls, urlsIn } from '../dist/core/types.js';
import { retry, safeExecute } from '../dist/utils/errorHandler.js';
import { logger } from '../dist/utils/logger.js';

// --- log capture -------------------------------------------------------------------

/** Every entry logged while `fn` runs, as serialised JSON lines (message and metadata). */
let captured = [];
class Capture extends Transport {
  log(info, callback) {
    captured.push({ level: info.level, line: JSON.stringify(info) });
    callback();
  }
}
const capture = new Capture();
let savedLevel;

before(() => {
  savedLevel = logger.getLevel();
  // warn and above is what the findings are about; also keeps stderr quiet.
  logger.setLevel('warn');
  logger.logger.add(capture);
});
after(() => {
  logger.logger.remove(capture);
  logger.setLevel(savedLevel);
});

async function logsOf(fn) {
  captured = [];
  const result = await fn();
  // winston hands entries to transports synchronously, but give it a tick.
  await new Promise(resolve => setImmediate(resolve));
  return { result, logs: captured.slice() };
}

// --- 1. step references --------------------------------------------------------------

/** A manager whose layers are stubs; `fail` names steps (by prompt) that fail. */
function managerWithStubs(fail = new Set()) {
  const manager = new LayerManager();
  const calls = [];
  for (const [name, field] of [
    ['aistudio', 'aiStudioLayer'],
    ['claude', 'claudeLayer'],
    ['antigravity', 'antigravityLayer'],
  ]) {
    const stub = {
      initialize: async () => {},
      isAvailable: async () => true,
      execute: async task => {
        calls.push({ layer: name, action: task.action, task });
        if (fail.has(task.prompt)) {
          return { success: false, error: 'upstream step failed', metadata: { layer: name, duration: 1 } };
        }
        return { success: true, data: { items: ['one', 'two'], text: `did:${task.prompt}` }, metadata: { layer: name, duration: 1 } };
      },
    };
    manager[field] = stub;
    manager[`${field}Promise`] = Promise.resolve(stub);
    manager.layerInitialized[name] = true;
  }
  manager.stubCalls = calls;
  return manager;
}

describe('step references', () => {
  const s1 = { id: 's1', layer: 'antigravity', action: 'search', input: { prompt: 's1' } };
  const s2 = input => ({
    id: 's2',
    layer: 'claude',
    action: 'synthesize_response',
    input: { prompt: 's2', ...input },
    dependsOn: ['s1'],
  });
  const taskOf = (manager, prompt) => manager.stubCalls.find(c => c.task.prompt === prompt)?.task;

  for (const mode of ['sequential', 'parallel']) {
    it(`leaves text that only starts with @ as it is (${mode})`, async () => {
      const manager = managerWithStubs();
      const input = {
        pkg: '@scope/pkg',
        note: '@here is text',
        bare: '@',
        dotted: '@.x',
        email: '@alice@example.com',
        nested: { list: ['@scope/pkg', '@here is text', { deep: '@s1.output.text' }] },
      };

      const { result, logs } = await logsOf(() =>
        manager.executeWorkflow({ steps: [s1, s2(input)] }, {}, { executionMode: mode })
      );

      assert.equal(result.success, true, JSON.stringify(result.results));
      const task = taskOf(manager, 's2');
      assert.equal(task.pkg, '@scope/pkg');
      assert.equal(task.note, '@here is text');
      assert.equal(task.bare, '@');
      assert.equal(task.dotted, '@.x');
      assert.equal(task.email, '@alice@example.com');
      assert.deepEqual(task.nested.list, ['@scope/pkg', '@here is text', { deep: 'did:s1' }]);
      assert.deepEqual(logs.filter(l => /reference/i.test(l.line)), [], 'nothing about references is logged');
    });

    it(`resolves @s1.output and leaves an undeclared @s9 as text (${mode})`, async () => {
      const manager = managerWithStubs();

      const { result, logs } = await logsOf(() => manager.executeWorkflow(
        { steps: [s1, s2({ analysis: '@s1.output', items: '@s1.output.items', other: '@s9', otherPath: '@s9.output' })] },
        {},
        { executionMode: mode }
      ));

      assert.equal(result.success, true, JSON.stringify(result.results));
      const task = taskOf(manager, 's2');
      assert.deepEqual(task.analysis, { items: ['one', 'two'], text: 'did:s1' });
      assert.deepEqual(task.items, ['one', 'two']);
      assert.equal(task.other, '@s9', 'a step this workflow does not declare is not a reference');
      assert.equal(task.otherPath, '@s9.output');
      assert.deepEqual(logs.filter(l => /reference/i.test(l.line)), []);
    });
  }

  // Sequential does not publish a failed step's output (the reference is
  // "missing"); parallel publishes the failure (the reference is "failed").
  for (const [mode, marker] of [['sequential', '_stepMissing'], ['parallel', '_stepFailed']]) {
    it(`logs a reference to a failed step by id and path only (${mode})`, async () => {
      const manager = managerWithStubs(new Set(['s1']));
      const input = {
        context: 'SENTINEL-CONTEXT keep me out of the log',
        ref: '@s1.output.items',
        inputs: { note: '@here is SENTINEL-NOTE', pkg: '@scope/SENTINEL-PKG' },
      };

      const { logs } = await logsOf(() =>
        manager.executeWorkflow({ steps: [s1, s2(input)] }, {}, { executionMode: mode })
      );

      const task = taskOf(manager, 's2');
      assert.equal(task.ref[marker], true, JSON.stringify(task.ref));
      assert.equal(task.ref._stepId, 's1');
      assert.equal(task.inputs.note, '@here is SENTINEL-NOTE');

      const refLogs = logs.filter(l => /step reference/i.test(l.line));
      assert.equal(refLogs.length, 1, JSON.stringify(logs));
      const [{ level, line }] = refLogs;
      assert.equal(level, 'warn');
      const entry = JSON.parse(line);
      assert.equal(entry.stepId, 's1');
      assert.equal(entry.path, 'output.items');
      assert.ok(!line.includes('@'), `the reference string itself is not logged: ${line}`);
      for (const l of logs) {
        assert.doesNotMatch(l.line, /SENTINEL|@here|@scope/, 'no other part of the input reaches the log');
      }
    });
  }
});

// --- 3. URL redaction ------------------------------------------------------------------

describe('redactUrls', () => {
  it('keeps scheme and host of a scheme:// URL, as before', () => {
    assert.equal(redactUrls('see https://example.com/secret?token=abc now'), 'see https://example.com/… now');
    assert.equal(redactUrls('HTTP://Example.COM:8080/a?b=c'), 'http://example.com:8080/…');
    assert.equal(redactUrls('ftp://user:pw@files.example.org/x'), 'ftp://files.example.org/…');
  });

  it('reduces a data: URL to data:…', () => {
    assert.equal(redactUrls('inline data:image/png;base64,iVBORw0KGgo=?token=abc end'), 'inline data:… end');
    assert.equal(redactUrls('data:text/plain,secret'), 'data:…');
  });

  it('keeps only scheme and host of other scheme: URLs', () => {
    assert.equal(redactUrls('to mailto:alice@example.com?subject=hi&token=abc'), 'to mailto:…@example.com');
    assert.equal(redactUrls('call tel:+15551234567'), 'call tel:…');
    assert.equal(redactUrls('urn:uuid:6e8bc430-9c3a-11d9-9669-0800200c9a66'), 'urn:…');
    assert.equal(redactUrls('open javascript:alert(document.cookie)'), 'open javascript:…');
  });

  it('cuts a bare host.tld/path to its host', () => {
    assert.equal(
      redactUrls('fetching storage.googleapis.com/bucket/object.pdf?X-Goog-Signature=abc123 failed'),
      'fetching storage.googleapis.com/… failed'
    );
    assert.equal(redactUrls('example.com/x?token=abc'), 'example.com/…');
    assert.equal(redactUrls('api.example.co.uk:8443/v1/files?key=AIzaSECRET'), 'api.example.co.uk:8443/…');
  });

  it('drops the ?… or #… tail of any other path-like token', () => {
    assert.equal(redactUrls('GET /v1beta/files?key=AIzaSECRET 403'), 'GET /v1beta/files?… 403');
    assert.equal(redactUrls('see ./callback#access_token=abc'), 'see ./callback#…');
    assert.equal(redactUrls('upload/abc?uploadType=resumable&upload_id=XYZ'), 'upload/abc?…');
  });

  it('leaves ordinary log text alone', () => {
    for (const text of [
      '/home/x/a.pdf',
      'Reading /home/user/docs/report.final.pdf (2 pages)',
      'C:\\x\\y',
      'C:\\Users\\me\\Documents\\report.pdf',
      'C:/Users/me/report.pdf',
      '\\\\server\\share\\file.txt',
      'started at 12:30',
      '12:30:45',
      'ratio 1:2',
      'Error: ENOENT: no such file or directory, open \'/tmp/x.pdf\'',
      'TypeError: Cannot read properties of undefined (reading \'path\')',
      '    at LayerManager.run (/home/x/dist/core/LayerManager.js:123:45)',
      '    at node:internal/process/task_queues:95:5',
      'src/core/types.ts:1043:7',
      'listening on localhost:3000',
      '/srv/www/example.com/index.html',
      'version 1.3.0 of @anthropic-ai/claude-code',
      'what? and who/what',
      'issue #12 is fixed',
      '{"prompt":"hello","files":["/a/b.pdf"],"count":2}',
      'no urls here',
    ]) {
      assert.equal(redactUrls(text), text, text);
    }
  });

  it('is idempotent on its own output', () => {
    const once = redactUrls('a https://x.com/p?q b mailto:u@y.org c data:,z d e.com/f?g h /i?j');
    assert.equal(redactUrls(once), once);
  });

  it('urlsIn and hostsOf still describe scheme:// URLs as before', () => {
    const text = 'a https://one.example.com/x?token=1 b http://two.example.org c mailto:z@three.example.net';
    assert.deepEqual(urlsIn(text), ['https://one.example.com/x?token=1', 'http://two.example.org']);
    assert.deepEqual(hostsOf(urlsIn(text)), ['one.example.com', 'two.example.org']);
  });

  it('firstLineForLog applies every form, before the cut', () => {
    assert.equal(firstLineForLog('upload to example.com/u?sig=abc failed\nsecond'), 'upload to example.com/… failed');
    assert.doesNotMatch(firstLineForLog(`${'y'.repeat(190)} /files?key=AIzaSECRET`), /AIzaSECRET/);
  });
});

// --- 4. retry warnings -----------------------------------------------------------------

describe('retry warnings', () => {
  it('log the first line of the failure, URLs redacted; the thrown error keeps it all', async () => {
    const message = 'MCP command analyze failed: upstream error\nsee https://example.com/x?token=abc for details';
    let calls = 0;
    const op = async () => { calls += 1; throw new Error(message); };

    let thrown;
    const { logs } = await logsOf(async () => {
      thrown = await retry(op, { maxRetries: 2, delay: 0 }).then(() => null, e => e);
    });

    assert.equal(calls, 3);
    const warns = logs.filter(l => l.level === 'warn' && /retrying/.test(l.line));
    assert.equal(warns.length, 2, JSON.stringify(logs));
    for (const { line } of warns) {
      const entry = JSON.parse(line);
      assert.equal(entry.error, 'MCP command analyze failed: upstream error');
      assert.ok(!line.includes('token=abc'), line);
      assert.ok(!line.includes('see '), `only the first line: ${line}`);
    }
    // The caller is told everything.
    assert.ok(thrown?.message.includes('token=abc'), thrown?.message);
    assert.ok(thrown?.message.includes('see https://example.com/x?token=abc'));
  });

  it('redact a URL on the first line too, and cap it at 200 characters', async () => {
    const op = async () => { throw new Error(`fetch https://example.com/x?token=abc failed ${'z'.repeat(400)}`); };

    const { logs } = await logsOf(() => retry(op, { maxRetries: 1, delay: 0 }).catch(() => null));

    const [warn] = logs.filter(l => l.level === 'warn' && /retrying/.test(l.line));
    const entry = JSON.parse(warn.line);
    assert.match(entry.error, /^fetch https:\/\/example\.com\/… failed z+…$/);
    assert.equal(entry.error.length, 201);
    assert.ok(!warn.line.includes('token=abc'));
  });
});

describe('safeExecute failures', () => {
  it('log the first line at error level, and the stack only at debug', async () => {
    const message = 'MCP command analyze failed: upstream error\nsee https://example.com/x?token=abc for details';
    const run = () => safeExecute(async () => { throw new Error(message); }, { operationName: 'probe' })
      .then(() => null, e => e);

    let thrown;
    const { logs } = await logsOf(async () => { thrown = await run(); });

    const errors = logs.filter(l => l.level === 'error' && /Operation failed: probe/.test(l.line));
    assert.equal(errors.length, 1, JSON.stringify(logs));
    const entry = JSON.parse(errors[0].line);
    assert.match(entry.error, /^.*MCP command analyze failed: upstream error$/);
    assert.equal(entry.stack, undefined, 'no stack at error level');
    for (const { line } of logs) {
      assert.ok(!line.includes('token=abc'), line);
      assert.ok(!line.includes('see https'), `only the first line: ${line}`);
    }
    assert.ok(thrown?.message.includes('token=abc'), 'the caller still gets the whole message');

    // At debug, the stack is there -- with its URLs cut to their hosts.
    logger.setLevel('debug');
    try {
      const debug = await logsOf(run);
      const stacks = debug.logs.filter(l => l.level === 'debug' && /failure stack: probe/.test(l.line));
      assert.equal(stacks.length, 1);
      assert.ok(!stacks[0].line.includes('token=abc'), stacks[0].line);
      assert.match(JSON.parse(stacks[0].line).stack, /at /);
    } finally {
      logger.setLevel('warn');
    }
  });
});

describe('AI Studio task log', () => {
  it('describes the task by its shape, not its prompt or paths', async () => {
    const layer = new AIStudioLayer();
    layer.isInitialized = true;
    layer.executeMCPCommand = async () => ({ analysis: 'done' });

    logger.setLevel('info');
    try {
      const { logs } = await logsOf(() => layer.execute({
        action: 'process_documents',
        prompt: 'SENTINEL-PROMPT summarise https://example.com/x?token=abc',
        instructions: 'SENTINEL-INSTRUCTIONS',
        documents: ['/tmp/SENTINEL-doc.pdf'],
      }));

      const lines = logs.filter(l => /Executing AI Studio task/.test(l.line));
      assert.equal(lines.length, 1, JSON.stringify(logs));
      const entry = JSON.parse(lines[0].line);
      assert.deepEqual(entry.argKeys, ['action', 'prompt', 'instructions', 'documents']);
      assert.equal(entry.fileCount, 1);
      assert.equal(entry.promptLength, 'SENTINEL-PROMPT summarise https://example.com/x?token=abc'.length);
      assert.deepEqual(entry.urlHosts, ['example.com']);
      assert.equal(entry.taskStructure, undefined);
      for (const { line } of logs) {
        assert.doesNotMatch(line, /SENTINEL|token=abc/, line);
      }
    } finally {
      logger.setLevel('warn');
    }
  });
});
