/**
 * The Claude Code layer.
 *
 * It had no direct tests at all: the migration suite reached it only through
 * stubs injected into LayerManager, so nothing exercised how it actually spawns
 * the CLI, reads its output, or decides a run failed. That is the half where
 * the migration's worst defect lived -- `shell: true` silently discarding the
 * prompt on Windows, producing a confident answer to a question the CLI never
 * received.
 *
 * A stub `claude` on PATH stands in for the real one. It lives in tmpdir, not
 * in the repository: findClaudeCodePath resolves through resolveTrustedCommand,
 * which refuses candidates inside the working directory, so an in-repo stub
 * would be ignored and these tests would pass without testing anything.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { after, describe, it } from 'node:test';

import { ClaudeCodeLayer } from '../dist/layers/ClaudeCodeLayer.js';

const isWindows = process.platform === 'win32';

// Not `cgmb-agy-*`: the workspace-isolation test scans tmpdir for that prefix.
const scratch = mkdtempSync(join(tmpdir(), 'cgmb-claude-'));

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/**
 * Write a stub `claude` into its own directory and return that directory.
 *
 * The shim calls process.execPath by absolute path: these tests put the stub
 * directory at the front of PATH, and a shim that resolved `node` through PATH
 * would be at the mercy of that.
 */
function makeStubDir(name, body) {
  const dir = join(scratch, name);
  const script = join(dir, 'stub.mjs');

  mkdirSync(dir, { recursive: true });
  writeFileSync(script, body, 'utf8');

  if (isWindows) {
    writeFileSync(join(dir, 'claude.cmd'), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`, 'utf8');
  } else {
    writeFileSync(join(dir, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  }

  return dir;
}

/** Run `fn` with the stub directory at the front of PATH. */
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

/** A stub that echoes whatever body you give it and exits 0. */
const ECHO_STUB = `
  const chunks = [];
  process.stdin.on('data', c => chunks.push(c));
  process.stdin.on('end', () => {
    const prompt = Buffer.concat(chunks).toString('utf8');
    if (process.argv.includes('--version')) { console.log('1.0.0-stub'); process.exit(0); }
    if (process.argv.includes('auth')) { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
    console.log('STUB_SAW:' + prompt.trim());
    process.exit(0);
  });
`;

describe('claude layer: task routing decisions', () => {
  // canHandle decides whether this layer is offered a task at all, and it is
  // pure -- no process, no credentials.

  it('accepts the task shapes it serves and refuses an empty one', () => {
    const layer = new ClaudeCodeLayer();

    assert.equal(layer.canHandle({ type: 'reasoning', prompt: 'why?' }), true);
    assert.equal(layer.canHandle({ type: 'workflow' }), true);
    assert.equal(layer.canHandle({ action: 'synthesize_response' }), true);
    assert.equal(layer.canHandle({ action: 'complex_reasoning' }), true);
    assert.equal(layer.canHandle({ prompt: 'anything' }), true);

    assert.equal(layer.canHandle({}), false, 'a task with nothing to act on is not handleable');
    assert.equal(layer.canHandle(null), false);
    assert.equal(layer.canHandle('string'), false);
  });

  it('reports capabilities and scales its estimate with depth', () => {
    const layer = new ClaudeCodeLayer();

    const capabilities = layer.getCapabilities();
    assert.ok(Array.isArray(capabilities) && capabilities.length > 0);
    assert.ok(capabilities.every(c => typeof c === 'string'));

    const shallow = layer.getEstimatedDuration({ prompt: 'x', depth: 'shallow' });
    const deep = layer.getEstimatedDuration({ prompt: 'x', depth: 'deep' });
    assert.ok(Number.isFinite(shallow) && shallow > 0);
    assert.ok(deep >= shallow, 'a deeper task must not be estimated as faster');
  });
});

describe('claude layer: running the CLI', () => {
  it('delivers the prompt on stdin and returns what the CLI printed', async () => {
    // The regression this pins: with `shell: true` on Windows the prompt was
    // joined into a cmd.exe command line and split on whitespace, so the CLI
    // received nothing and answered something unrelated -- as a success.
    const dir = makeStubDir('echo', ECHO_STUB);

    const result = await withStub(dir, async () => {
      const layer = new ClaudeCodeLayer();
      return layer.execute({ type: 'text_processing', prompt: 'Reply with exactly: MARKER_7f3a' });
    });

    assert.equal(result.success, true);
    assert.equal(result.metadata.layer, 'claude');
    assert.match(
      String(result.data), /MARKER_7f3a/,
      'the prompt must reach the CLI intact, including the spaces'
    );
  });

  it('treats an empty answer with exit 0 as a failure', async () => {
    // Claude Code before the migration fix could exit 0 having printed nothing.
    // Reporting that as a successful empty answer is how a broken install
    // looked healthy.
    const dir = makeStubDir('silent', `
      const chunks = [];
      process.stdin.on('data', c => chunks.push(c));
      process.stdin.on('end', () => {
        if (process.argv.includes('--version')) { console.log('1.0.0-stub'); process.exit(0); }
        if (process.argv.includes('auth')) { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
        process.exit(0);   // exit 0, no output
      });
    `);

    await assert.rejects(
      () => withStub(dir, async () => new ClaudeCodeLayer().execute({ prompt: 'anything' })),
      'an empty answer must not be reported as a successful one'
    );
  });

  it('fails when the CLI exits non-zero, and keeps its stderr', async () => {
    const dir = makeStubDir('failing', `
      const chunks = [];
      process.stdin.on('data', c => chunks.push(c));
      process.stdin.on('end', () => {
        if (process.argv.includes('--version')) { console.log('1.0.0-stub'); process.exit(0); }
        if (process.argv.includes('auth')) { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
        process.stderr.write('STUB_REFUSED: quota exceeded');
        process.exit(1);
      });
    `);

    await assert.rejects(
      () => withStub(dir, async () => new ClaudeCodeLayer().execute({ prompt: 'anything' })),
      error => /STUB_REFUSED|exited with code 1/.test(error.message),
      'the reason the CLI gave must survive'
    );
  });

  it('does not let shell metacharacters in a prompt run anything', async () => {
    // The prompt is caller-controlled and arrives from MCP input. Whatever the
    // platform, it must reach the CLI as text -- never as a command line.
    //
    // Two things are asked. First, that the stub saw the payload *exactly*: the
    // previous version deleted everything from STUB_SAW: to the end of output
    // with a greedy dot-all replace before looking for INJECTED, so anything an
    // injected command printed after the stub was erased along with it. Second,
    // that nothing on disk changed -- a payload that spawns a shell would leave
    // the sentinel behind, and no amount of output filtering can hide a file.
    const dir = makeStubDir('metachars', ECHO_STUB);
    const sentinel = join(scratch, `injected-${Math.random().toString(36).slice(2)}.txt`);
    // The raw path, not JSON.stringify: that escapes backslashes, and
    // C:\Users\... is not a path cmd.exe can redirect to -- the injection
    // would fail for the wrong reason and the case would pass without proving
    // anything. Found by mutation: with the prompt deliberately put back on the
    // command line through a shell, the escaped version still passed.
    // Both shapes, because they defeat different placements. A payload that
    // lands inside an existing quoted argument needs the leading quote to close
    // it; one that is joined raw onto a command line needs no quote at all --
    // and a leading quote there would *open* a string and neutralise the rest,
    // which is how an earlier version of this payload managed to look safe.
    const posix = `; touch '${sentinel}' ; $(touch '${sentinel}')`;
    const windowsRaw = `& echo pwned > "${sentinel}" &`;
    const windowsQuoted = `" & echo pwned > "${sentinel}" & rem "`;
    const payload =
      `benign-text ${posix} ${windowsRaw} ${windowsQuoted} \`touch '${sentinel}'\``;

    const result = await withStub(dir, async () => {
      const layer = new ClaudeCodeLayer();
      return layer.execute({ prompt: payload });
    });

    assert.equal(result.success, true);
    assert.equal(
      String(result.data).trim(), `STUB_SAW:${payload}`,
      'the prompt must arrive as one argument-free string, byte for byte'
    );
    assert.equal(
      existsSync(sentinel), false,
      'a shell ran the payload: the sentinel it was told to create exists'
    );
  });
});

describe('a workflow step that carries structure, not prose', () => {
  // Steps addressed to this layer often have no sentence in them. The analysis
  // workflow's analyze_requirements step arrives as {documents, analysisType,
  // outputRequirements} and its synthesize_analysis step as {analysisResults,
  // requirements} -- none of which is prompt, request or input. Both fell
  // through to the literal "Please help with this task." Measured against a
  // live run before this: Claude answered "no specific task has been described
  // in this conversation", twice, and both answers were folded into the
  // workflow result as though they were work.

  it('describes the step instead of asking for help with nothing', async () => {
    const dir = makeStubDir('structured-step', ECHO_STUB);

    const result = await withStub(dir, async () => {
      const layer = new ClaudeCodeLayer();
      return layer.execute({
        action: 'analyze_requirements',
        documents: ['/tmp/report.pdf'],
        analysisType: 'summary',
        outputRequirements: 'one paragraph',
      });
    });

    const sent = String(result.data);
    assert.equal(result.success, true);
    assert.ok(!sent.includes('Please help with this task.'), 'the placeholder must be gone');
    assert.ok(sent.includes('analyze_requirements'), 'the step must say what it is');
    assert.ok(sent.includes('/tmp/report.pdf'), 'and carry its input');
    assert.ok(sent.includes('one paragraph'), 'including the requirements');
  });

  it('still says something useful when a step really has no input', async () => {
    const dir = makeStubDir('empty-step', ECHO_STUB);

    const result = await withStub(dir, async () => {
      const layer = new ClaudeCodeLayer();
      return layer.execute({ action: 'validate_conversion' });
    });

    assert.ok(String(result.data).includes('validate_conversion'), 'name the step even with nothing to add');
  });

  it('leaves a step that does carry prose alone', async () => {
    const dir = makeStubDir('prose-step', ECHO_STUB);

    const result = await withStub(dir, async () => {
      const layer = new ClaudeCodeLayer();
      return layer.execute({ action: 'plan_extraction', prompt: 'Extract the tables.' });
    });

    assert.equal(String(result.data).trim(), 'STUB_SAW:Extract the tables.', 'a prompt must pass through untouched');
  });
});

describe('how long a step is given', () => {
  // The estimate is 5 seconds for anything that is not a workflow or complex
  // reasoning, plus a 30-second buffer -- so an ordinary step got 35 seconds to
  // run an interactive `claude` that answers a real question. It came back
  // inside that only while it was answering a placeholder; the moment the step
  // was given something to think about, the analysis workflow's first step
  // timed out at exactly 35000ms.

  it('gives a general step the same budget as any other claude call', () => {
    // Measured: one analyze_requirements step took 85 seconds to do the work
    // properly. 35 seconds could only ever have been enough for a placeholder.
    const layer = new ClaudeCodeLayer();

    assert.equal(
      layer.getTaskTimeout({ action: 'analyze_requirements', documents: ['a.pdf'] }),
      layer.DEFAULT_TIMEOUT,
      'a step is not a different kind of call from any other claude invocation'
    );
  });

  it('honours a timeout the caller set', () => {
    const layer = new ClaudeCodeLayer();

    assert.equal(layer.getTaskTimeout({ prompt: 'x', timeout: 5000 }), 5000, 'an explicit budget wins');
  });

  it('sizes the estimate from the prompt that will be sent', () => {
    // A step whose text is assembled from its fields has no task.prompt, so
    // reading only that scored it as the shortest possible request.
    const layer = new ClaudeCodeLayer();
    const long = 'x'.repeat(1500);

    assert.ok(
      layer.getEstimatedDuration({ action: 'plan_extraction' }, long)
      > layer.getEstimatedDuration({ action: 'plan_extraction' }, 'short'),
      'a long prompt must raise the estimate even when it is not on the task'
    );
  });
});

describe('what the claude child does not inherit', () => {
  // CGMB is commonly registered as an MCP server inside Claude Code, so the
  // process that shells out to `claude` is itself running under a Claude Code
  // session. Everything in that session's environment was passed straight
  // down: the child presented itself as part of a conversation it is not in,
  // and it held CGMB's Google API keys, which it has no use for.

  const parentEnv = {
    PATH: '/usr/bin',
    HOME: '/home/someone',
    CLAUDECODE: '1',
    CLAUDE_CODE_SESSION_ID: 'parent-session-1234',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CODE_SSE_PORT: '54321',
    ANTHROPIC_MODEL: 'claude-something-remapped',
    CLAUDE_CODE_SUBAGENT_MODEL: 'claude-something-else',
    AI_STUDIO_API_KEY: 'a-google-key',
    GOOGLE_AI_STUDIO_API_KEY: 'another-google-key',
    GEMINI_API_KEY: 'a-third-google-key',
    ANTHROPIC_API_KEY: 'how the user authenticates',
  };

  it('drops the parent session identity', () => {
    const env = ClaudeCodeLayer.childEnvFrom(parentEnv);

    for (const name of [
      'CLAUDECODE',
      'CLAUDE_CODE_SESSION_ID',
      'CLAUDE_CODE_ENTRYPOINT',
      'CLAUDE_CODE_SSE_PORT',
    ]) {
      assert.equal(env[name], undefined, `${name} must not reach the child`);
    }
  });

  it('drops the model overrides', () => {
    const env = ClaudeCodeLayer.childEnvFrom(parentEnv);

    assert.equal(env.ANTHROPIC_MODEL, undefined);
    assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, undefined);
  });

  it('drops CGMB credentials the child has no use for', () => {
    const env = ClaudeCodeLayer.childEnvFrom(parentEnv);

    assert.equal(env.AI_STUDIO_API_KEY, undefined);
    assert.equal(env.GOOGLE_AI_STUDIO_API_KEY, undefined);
    assert.equal(env.GEMINI_API_KEY, undefined);
  });

  it('keeps what the child needs to run and to authenticate', () => {
    // Stripping is not the goal; not carrying the session over is. A child with
    // no PATH cannot find its own tools, and a user who authenticates with an
    // Anthropic key must keep working.
    const env = ClaudeCodeLayer.childEnvFrom(parentEnv);

    assert.equal(env.PATH, '/usr/bin');
    assert.equal(env.HOME, '/home/someone');
    assert.equal(env.ANTHROPIC_API_KEY, 'how the user authenticates');
  });

  it('does not modify the environment it was given', () => {
    const source = { ...parentEnv };
    ClaudeCodeLayer.childEnvFrom(source);

    assert.deepEqual(source, parentEnv, 'process.env must survive building a child environment');
  });
});

describe('a synthesis step is given something to synthesise', () => {
  // A workflow's last step is almost always synthesize_response, and it arrives
  // carrying its text as `prompt` -- LayerManager spreads the step input into
  // the task. buildSynthesisPrompt read only `request`, so what reached Claude
  // was two sentences of instructions with no content between them, and
  // whatever came back was reported as the workflow's answer.

  it('carries the step prompt through to the command', async () => {
    const dir = makeStubDir('synthesis-prompt', ECHO_STUB);
    const text = 'Tokyo is sunny today, per the search step.';

    const result = await withStub(dir, async () => {
      const layer = new ClaudeCodeLayer();
      return layer.execute({ action: 'synthesize_response', prompt: text });
    });

    assert.equal(result.success, true);
    assert.ok(
      String(result.data).includes(text),
      'the synthesis prompt reached Claude with the step content missing'
    );
  });

  it('carries the upstream answers a step depends on', async () => {
    // `inputs` is how resolved @step.output references are handed over. An
    // object there used to stringify as [object Object].
    const dir = makeStubDir('synthesis-inputs', ECHO_STUB);

    const result = await withStub(dir, async () => {
      const layer = new ClaudeCodeLayer();
      return layer.execute({
        action: 'synthesize_response',
        prompt: 'Summarise the findings.',
        inputs: { search: { output: 'the weather is fine' } },
      });
    });

    assert.equal(result.success, true);
    assert.match(String(result.data), /the weather is fine/, 'an upstream answer must survive');
    assert.doesNotMatch(String(result.data), /\[object Object\]/, 'structured output must be serialised');
  });

  it('still prefers an explicit request when both are present', async () => {
    const dir = makeStubDir('synthesis-request', ECHO_STUB);

    const result = await withStub(dir, async () => {
      const layer = new ClaudeCodeLayer();
      return layer.execute({
        action: 'synthesize_response',
        request: 'the explicit request',
        prompt: 'the fallback prompt',
      });
    });

    assert.match(String(result.data), /the explicit request/);
    assert.doesNotMatch(String(result.data), /the fallback prompt/, 'the fallback must not double up');
  });
});

describe('the configured path reaches the auth probe on both init paths', () => {
  // Codex review, P2. initialize() was fixed to hand the resolved executable to
  // verifyClaudeCodeAuth, but initializeLightweight was not -- and that is the
  // path execute() takes for an ordinary prompt (no workflow, no depth, not
  // complex_reasoning). So on a machine whose only install is the one
  // CLAUDE_CODE_PATH names, the common case still probed the bare name, decided
  // Claude was not installed, and cached that verdict for twelve hours.
  //
  // Hermetic: claudePath is set first so findClaudeCodePath never spawns, and
  // authVerifier is replaced by a recorder. lastAuthCheck starts at 0, so the
  // auth branch always runs.

  function layerWithSpy() {
    const layer = new ClaudeCodeLayer();
    const seen = [];
    layer.claudePath = '/opt/custom/claude';
    layer.authVerifier = {
      verifyClaudeCodeAuth: async codePath => {
        seen.push(codePath);
        return { success: true, status: { isAuthenticated: true }, requiresAction: false };
      },
    };
    return { layer, seen };
  }

  it('passes the resolved path from lightweight initialization', async () => {
    const { layer, seen } = layerWithSpy();

    await layer.initializeLightweight();

    assert.deepEqual(seen, ['/opt/custom/claude'], 'the probe must not be given the bare name');
  });

  it('does not re-probe once the check is recent', async () => {
    // Guards the ordering: the path must be passed on the call that actually
    // happens, not on a later one that the TTL skips.
    const { layer, seen } = layerWithSpy();

    await layer.initializeLightweight();
    layer.isLightweightInitialized = false;
    await layer.initializeLightweight();

    assert.equal(seen.length, 1, 'the 24h auth cache must still hold');
  });
});
