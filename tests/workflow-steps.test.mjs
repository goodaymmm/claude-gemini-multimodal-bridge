/**
 * User-defined workflows (cgmb_workflow_orchestration): how steps are checked
 * against each other, and what a later step is handed from an earlier one.
 *
 * Two defects, both of which reported success:
 *
 *   - A `dependsOn` naming no step was ignored in sequential mode -- the step
 *     ran as if it had no dependency -- while parallel and hybrid refused the
 *     same definition with a generic error. Now every mode refuses it up front,
 *     naming the step and the id, before any layer is called.
 *   - synthesize_response read only request/prompt/input/inputs, so an input
 *     such as `analysis: '@s1.output'` never reached Claude, and an object in
 *     `inputs` arrived as "[object Object]".
 *
 * The first half drives LayerManager with stub layers; the second drives the
 * real `cgmb serve` over stdio with a `claude` stand-in that records the whole
 * prompt it was given on stdin.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { LayerManager } from '../dist/core/LayerManager.js';
import { AGY_ANSWER, createCliStubs, readCalls, startRoutingGemini } from './fixtures/routing-stubs.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'dist', 'cli.js');

/** A manager whose three layers are stubs that record each task they get. */
function managerWithStubs() {
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
        return { success: true, data: `did:${task.action}`, metadata: { layer: name, duration: 1 } };
      },
    };
    manager[field] = stub;
    manager[`${field}Promise`] = Promise.resolve(stub);
    manager.layerInitialized[name] = true;
  }

  manager.stubCalls = calls;
  return manager;
}

const step = (id, dependsOn, extra = {}) => ({
  id,
  layer: 'antigravity',
  action: 'search',
  input: { prompt: id },
  ...(dependsOn ? { dependsOn } : {}),
  ...extra,
});

// adaptive picks sequential, parallel or hybrid from the input; all three are
// also reached directly where they can be.
const MODES = [
  ['sequential', {}],
  ['parallel', {}],
  ['adaptive', {}],
  ['adaptive', { prompt: 'generate a summary poster' }], // medium complexity -> hybrid
];

describe('workflow dependsOn is checked before any step runs', () => {
  const invalid = [
    {
      name: 'an unknown id',
      steps: [step('s1'), step('s2', ['nope'])],
      message: /step "s2" depends on "nope", which is not a step in this workflow \(steps: "s1", "s2"\)/,
      code: 'INVALID_WORKFLOW_DEPENDENCY',
    },
    {
      name: 'a step depending on itself',
      steps: [step('s1'), step('s2', ['s2'])],
      message: /step "s2" lists itself in dependsOn/,
      code: 'INVALID_WORKFLOW_DEPENDENCY',
    },
    {
      name: 'a cycle',
      steps: [step('first'), step('a', ['b']), step('b', ['a'])],
      message: /cycle: "a" -> "b" -> "a"/,
      code: 'CIRCULAR_DEPENDENCY',
    },
    {
      name: 'a longer cycle',
      steps: [step('x', ['z']), step('y', ['x']), step('z', ['y'])],
      message: /cycle: "x" -> "z" -> "y" -> "x"/,
      code: 'CIRCULAR_DEPENDENCY',
    },
    {
      name: 'a duplicated id',
      steps: [step('s1'), step('s1')],
      message: /more than one step has the id "s1"/,
      code: 'INVALID_WORKFLOW_DEPENDENCY',
    },
  ];

  for (const { name, steps, message, code } of invalid) {
    for (const [mode, input] of MODES) {
      const label = input.prompt ? 'adaptive (hybrid)' : mode;
      it(`refuses ${name} under ${label}, without calling a layer`, async () => {
        const manager = managerWithStubs();

        await assert.rejects(
          manager.executeWorkflow({ steps }, input, { executionMode: mode }),
          error => {
            assert.match(error.message, message);
            assert.equal(error.code, code);
            return true;
          }
        );
        assert.deepEqual(manager.stubCalls, [], 'no step may run once the plan is known to be invalid');
      });
    }
  }

  it('still runs a valid chain in dependency order, whatever order it is declared in', async () => {
    for (const [mode, input] of MODES) {
      const manager = managerWithStubs();
      const steps = [step('c', ['b']), step('a'), step('b', ['a'])];

      const result = await manager.executeWorkflow({ steps }, input, { executionMode: mode });

      assert.equal(result.success, true, `${mode}: ${JSON.stringify(result.results)}`);
      assert.deepEqual(manager.stubCalls.map(c => c.task.prompt), ['a', 'b', 'c'], mode);
    }
  });
});

describe('a later step is handed the earlier step result as it is', () => {
  it('resolves references inside nested inputs, keeping objects as objects', async () => {
    const manager = managerWithStubs();
    const steps = [
      step('s1'),
      {
        id: 's2',
        layer: 'claude',
        action: 'synthesize_response',
        input: {
          prompt: 'Combine',
          analysis: '@s1',
          inputs: { search: '@s1.output', both: ['@s1.output', 'literal'], missing: '@ghost.output' },
        },
        dependsOn: ['s1'],
      },
    ];

    const result = await manager.executeWorkflow({ steps }, {}, { executionMode: 'sequential' });

    assert.equal(result.success, true, JSON.stringify(result.results));
    const { task } = manager.stubCalls.find(c => c.action === 'synthesize_response');
    assert.deepEqual(task.analysis, { output: 'did:search' }, 'a bare @step is its published object, not a string');
    assert.equal(task.inputs.search, 'did:search');
    assert.deepEqual(task.inputs.both, ['did:search', 'literal']);
    assert.equal(task.inputs.missing._stepMissing, true, 'an unknown reference is marked, as at the top level');
  });
});

// The stand-ins are POSIX shell shims; see routing-matrix.test.mjs.
const SKIP = process.platform === 'win32' && 'workflow stubs are POSIX shims';

describe('cgmb_workflow_orchestration, end to end', { skip: SKIP }, () => {
  let base, server, stubs, gemini, promptLog;

  /** A `claude` stand-in that logs every real call's full stdin. */
  function writeRecordingClaude(dir) {
    promptLog = join(dir, 'claude-prompts.jsonl');
    writeFileSync(promptLog, '');
    const script = join(dir, 'claude-recorder.mjs');
    writeFileSync(script, `
import { appendFileSync } from 'node:fs';
const argv = process.argv.slice(2);
if (argv.includes('--version')) { console.log('9.9.9 (Claude Code stub)'); process.exit(0); }
if (argv.includes('--help')) { console.log('Usage: claude [options]'); process.exit(0); }
if (argv[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
const chunks = [];
process.stdin.on('data', c => chunks.push(c));
process.stdin.on('end', () => {
  appendFileSync(${JSON.stringify(promptLog)}, JSON.stringify({ prompt: Buffer.concat(chunks).toString('utf8') }) + '\\n');
  console.log('synthesised by the claude stand-in');
  process.exit(0);
});
`);
    const shim = join(dir, 'claude');
    writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
    return shim;
  }

  const claudePrompts = () => readFileSync(promptLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).prompt);

  async function startServer(env, cwd) {
    const pending = new Map();
    let nextId = 1;
    let stderr = '';
    let buffer = '';
    const child = spawn(process.execPath, [CLI, 'serve'], { cwd, env });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        pending.get(message.id)?.(message);
        pending.delete(message.id);
      }
    });

    const rpc = (method, params, ms = 60000) => new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out; server stderr tail:\n${stderr.slice(-2000)}`));
      }, ms);
      pending.set(id, message => { clearTimeout(timer); resolve(message); });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });

    const init = await rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'workflow-steps', version: '1' },
    });
    assert.ok(init.result, `initialize failed: ${JSON.stringify(init.error)}`);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

    return {
      async call(args) {
        const response = await rpc('tools/call', { name: 'cgmb_workflow_orchestration', arguments: args });
        return {
          isError: response.result?.isError === true || response.error !== undefined,
          text: response.result?.content?.map(part => part.text ?? '').join('\n') ?? JSON.stringify(response.error),
        };
      },
      async stop() {
        child.stdin.end();
        const killer = setTimeout(() => child.kill('SIGKILL'), 5000);
        if (child.exitCode === null) { await new Promise(resolve => child.once('exit', resolve)); }
        clearTimeout(killer);
      },
    };
  }

  /** Real calls (not probes) any stand-in received since `mark`. */
  const callsSince = mark => [
    ...readCalls(stubs.logPath).slice(mark.log).filter(e => e.kind === 'call'),
    ...claudePrompts().slice(mark.claude),
  ];
  const mark = () => ({ log: readCalls(stubs.logPath).length, claude: claudePrompts().length });

  before(async () => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'cgmb-workflow-')));
    const work = join(base, 'work');
    const stubDir = join(base, 'stubs');
    const childTmp = join(base, 'tmp');
    for (const dir of [work, stubDir, childTmp]) { mkdirSync(dir); }

    // Outside `work`: trusted-binary resolution refuses binaries in the cwd.
    stubs = createCliStubs(stubDir);
    gemini = await startRoutingGemini(stubs.logPath);

    const env = {
      ...process.env,
      AI_STUDIO_API_KEY: 'AIzaFakeKeyForTestsOnly000000000',
      GOOGLE_GEMINI_BASE_URL: gemini.baseUrl,
      ANTIGRAVITY_CLI_PATH: stubs.agyPath,
      CLAUDE_CODE_PATH: writeRecordingClaude(stubDir),
      ENABLE_CACHING: 'false',
      CACHE_TTL: '1',
      HOME: base,
      USERPROFILE: base,
      TMPDIR: childTmp,
      TMP: childTmp,
      TEMP: childTmp,
    };
    for (const key of [
      'NODE_TEST_CONTEXT', 'LOG_LEVEL', 'LOG_FILE', 'CGMB_CLI_MODE', 'CGMB_DEBUG', 'CGMB_PDF_MODE',
      'GEMINI_API_KEY', 'GOOGLE_AI_STUDIO_API_KEY', 'GEMINI_CLI_PATH', 'ANTIGRAVITY_MODEL',
      'CGMB_ENV_PATH', 'CGMB_ALLOWED_ROOTS', 'CLAUDE_STUB_SIGNED_OUT',
    ]) {
      delete env[key];
    }

    server = await startServer(env, work);
  });

  after(async () => {
    await server?.stop();
    await gemini?.close();
    if (base) { rmSync(base, { recursive: true, force: true }); }
  });

  it('refuses an unknown dependsOn naming the step and the id, before any layer is called', async () => {
    const before = mark();
    const r = await server.call({
      execution_mode: 'sequential',
      input_data: {},
      workflow_definition: {
        steps: [
          { id: 's1', layer: 'antigravity', action: 'search', input: { prompt: 'latest TypeScript release' } },
          { id: 's2', layer: 'claude', action: 'synthesize_response', input: { prompt: 'Combine' }, dependsOn: ['s0'] },
        ],
      },
    });

    assert.equal(r.isError, true, r.text);
    assert.match(r.text, /step "s2" depends on "s0", which is not a step in this workflow/);
    assert.deepEqual(callsSince(before), [], 'nothing may be paid for once the plan is known to be invalid');
  });

  it('hands every input of a synthesis step to Claude: step results as text, objects as JSON', async () => {
    const before = mark();
    const big = { rows: Array.from({ length: 2000 }, (_, i) => ({ index: i, label: `row ${i}` })) };

    const r = await server.call({
      execution_mode: 'sequential',
      input_data: {},
      workflow_definition: {
        steps: [
          { id: 's1', layer: 'antigravity', action: 'search', input: { prompt: 'latest TypeScript release' } },
          {
            id: 's2',
            layer: 'claude',
            action: 'synthesize_response',
            input: {
              prompt: 'Combine the findings',
              analysis: '@s1.output',
              whole_step: '@s1',
              criteria: { audience: 'engineers', points: ['speed', 'safety'] },
              inputs: { search: '@s1.output', meta: { region: 'EU' } },
              table: big,
            },
            dependsOn: ['s1'],
          },
        ],
      },
    });

    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /synthesised by the claude stand-in/);
    assert.equal(readCalls(stubs.logPath).slice(before.log).filter(e => e.kind === 'call' && e.layer === 'antigravity').length, 1);

    const prompts = claudePrompts().slice(before.claude);
    assert.equal(prompts.length, 1, 'one synthesis call');
    const [prompt] = prompts;

    assert.match(prompt, /^Request: Combine the findings$/m);
    assert.doesNotMatch(prompt, /\[object Object\]/);
    assert.doesNotMatch(prompt, /@s1/, 'references must be resolved, not passed on literally');

    // Each input is a labelled section.
    for (const label of ['analysis', 'whole_step', 'criteria', 'search', 'meta', 'table']) {
      assert.match(prompt, new RegExp(`^### \\d+\\. ${label}$`, 'm'), `section for ${label}`);
    }
    // The earlier step's text, verbatim, under its key.
    assert.match(prompt, new RegExp(`### \\d+\\. analysis\\n${AGY_ANSWER}\\n`));
    assert.match(prompt, new RegExp(`### \\d+\\. search\\n${AGY_ANSWER}\\n`));
    // Objects as indented JSON.
    assert.ok(prompt.includes('"audience": "engineers"'), 'an object input appears as JSON');
    assert.ok(prompt.includes('{\n  "region": "EU"\n}'), 'an object inside inputs appears as JSON');
    assert.ok(prompt.includes(`"output": "${AGY_ANSWER}"`), 'a bare @step reference carries the step result');
    // A large one is capped, and says so.
    assert.match(prompt, /\[truncated: \d+ more characters of JSON omitted\]/);
    assert.ok(prompt.length < 30_000, `the prompt is bounded (${prompt.length} characters)`);
  });
});
