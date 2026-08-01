/**
 * What a CLI timeout actually stops.
 *
 * Found when the test suite itself was reviewed: TimeoutManager had no tests,
 * and wrapCLICommand discarded the AbortSignal under a comment saying it passed
 * it on. Every caller of that wrapper is a billed AI Studio operation -- image,
 * audio, document, multimodal -- so a timeout ended the waiting while the
 * request kept running, and a retry on top of it paid twice for output nobody
 * would see.
 *
 * The child here refuses SIGTERM on purpose. A test that sends the signal
 * itself, or that kills a process which would have died anyway, proves nothing
 * about whether the production path ends the work.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { AIStudioLayer } from '../dist/layers/AIStudioLayer.js';
import { safeExecute } from '../dist/utils/errorHandler.js';
import { withCLITimeout } from '../dist/utils/TimeoutManager.js';

// Not `cgmb-agy-*`: the workspace-isolation test scans tmpdir for that prefix.
const scratch = mkdtempSync(join(tmpdir(), 'cgmb-cancel-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const isAlive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Built, not typed: a backslash in this file is a JavaScript escape, so a
// hand-written newline lands as a real one inside the generated source.
const NEWLINE = String.fromCharCode(10);

const settle = (ms = 700) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * A process that ignores SIGTERM and keeps appending to a file.
 *
 * The file is how "did the work stop?" is answered without trusting the exit:
 * anything written after cancellation is work that was still being paid for.
 */
function stubbornChild() {
  const marks = join(scratch, `marks-${Math.random().toString(36).slice(2)}.txt`);
  const script = join(scratch, `stubborn-${Math.random().toString(36).slice(2)}.cjs`);
  // Every literal in the generated file comes from JSON.stringify rather than
  // hand-escaping. Writing '\n' inside a template literal puts a real newline
  // into the generated source, which is a syntax error inside a quoted string --
  // that is what broke the stub in the end-to-end case below, and it broke
  // silently, because a fixture that dies on startup looks exactly like a
  // fixture that was cancelled. Building the literal removes the choice.
  writeFileSync(script, [
    "process.on('SIGTERM', () => {});",
    "const fs = require('fs');",
    `setInterval(() => fs.appendFileSync(${JSON.stringify(marks)}, ${JSON.stringify('tick\n')}), 40);`,
  ].join('\n'), 'utf8');

  const child = spawn(process.execPath, [script], { stdio: 'ignore' });
  return { child, marks, ticks: () => readFileSync(marks, 'utf8').split('\n').filter(Boolean).length };
}

describe('a timeout reaches the work', () => {
  it('hands the command an AbortSignal that fires on timeout', async () => {
    let received;
    let abortedDuringRun = false;

    await assert.rejects(() => withCLITimeout(async (signal) => {
      received = signal;
      signal.addEventListener('abort', () => { abortedDuringRun = true; }, { once: true });
      await new Promise(resolve => setTimeout(resolve, 30000));
    }, 'never-finishes', 800));

    assert.ok(received instanceof AbortSignal, 'the command used to be called with nothing');
    assert.equal(received.aborted, true);
    assert.equal(abortedDuringRun, true, 'and it must fire while the command is still waiting');
  });

  it('leaves no process behind, even one that refuses SIGTERM', async () => {
    const { child } = stubbornChild();
    await settle(200);
    assert.equal(isAlive(child.pid), true, 'the fixture must be running to prove anything');

    await assert.rejects(() => withCLITimeout(async (signal) => {
      signal.addEventListener('abort', () => AIStudioLayer.terminateChild(child), { once: true });
      await new Promise(resolve => setTimeout(resolve, 30000));
    }, 'stubborn', 800));

    await settle();
    assert.equal(isAlive(child.pid), false, 'a timeout that leaves the process running is not a timeout');
  });

  it('stops the work, not just the waiting', async () => {
    // The billing question, asked directly: does anything happen after the
    // caller has been told the operation timed out?
    const { child, ticks } = stubbornChild();
    await settle(300);

    await assert.rejects(() => withCLITimeout(async (signal) => {
      signal.addEventListener('abort', () => AIStudioLayer.terminateChild(child), { once: true });
      await new Promise(resolve => setTimeout(resolve, 30000));
    }, 'billed-work', 800));

    const atTimeout = ticks();
    await settle();

    assert.ok(atTimeout > 0, 'the fixture must have been doing work');
    assert.equal(ticks(), atTimeout, 'nothing may be done after the caller was told it failed');
  });

  it('fires when the inner layer fails first, not only on its own timer', async () => {
    // The measured hole in the previous fix. abort() lived inside the outer
    // timer, so it only ran for the case that is not the common one: a document
    // or multimodal run has an inner budget near 105s against a CLI timeout of
    // 240 or 300, so the inner layer rejects first. Measured before this fix,
    // the signal stayed unaborted and the listeners never ran, leaving the MCP
    // child billing until its own ceiling.
    let abortedBeforeCallerSaw = false;

    await assert.rejects(() => withCLITimeout(async (signal) => {
      signal.addEventListener('abort', () => { abortedBeforeCallerSaw = true; }, { once: true });
      // Far inside the outer budget: this is the inner timeout, not ours.
      await new Promise((_, reject) => setTimeout(() => reject(new Error('inner timeout')), 300));
    }, 'inner-fails-first', 30000), /inner timeout/);

    assert.equal(
      abortedBeforeCallerSaw, true,
      'the caller has been told it failed, so nothing may still be running for it'
    );
  });

  it('returns the result untouched when the command finishes in time', async () => {
    // Cancellation must not have cost the normal path anything.
    let aborted = false;
    const result = await withCLITimeout(async (signal) => {
      signal.addEventListener('abort', () => { aborted = true; }, { once: true });
      return 'finished';
    }, 'quick', 5000);

    assert.equal(result, 'finished');
    assert.equal(aborted, false, 'finished work has nothing to cancel');
  });
});

describe('the layer can be told to stop', () => {
  it('reports how many processes it ended', () => {
    // A caller -- or a test -- has to be able to tell cancelling work from
    // cancelling nothing.
    const layer = new AIStudioLayer();

    assert.equal(layer.abortActiveOperations('nothing running'), 0);
  });

  it('ends the children it is holding', async () => {
    const layer = new AIStudioLayer();
    const first = stubbornChild();
    const second = stubbornChild();
    await settle(200);

    // The set the production spawn path adds to.
    layer.activeChildren.add(first.child);
    layer.activeChildren.add(second.child);

    assert.equal(layer.abortActiveOperations('test'), 2);
    await settle();

    assert.equal(isAlive(first.child.pid), false);
    assert.equal(isAlive(second.child.pid), false);
    assert.equal(layer.activeChildren.size, 0, 'and it must not keep pointing at dead processes');
  });
});

describe('the production spawn path, end to end', () => {
  // Everything above drives the wrapper. This drives what the wrapper is for:
  // executeMCPCommand spawning a server, the layer registering it, and the
  // cancellation reaching that process. The earlier cases wired terminateChild
  // straight onto the listener, which is why they could pass while the real
  // route stayed broken -- the same shape of gap the review keeps finding.
  //
  // resolveMCPServerPath is monkey-patched rather than given a test-only
  // parameter or environment variable: the production surface should not grow a
  // seam that exists only for tests.

  /** A stand-in MCP server: ignores SIGTERM, records that it started, keeps working. */
  function stubServer() {
    const id = Math.random().toString(36).slice(2);
    const marks = join(scratch, `mcp-marks-${id}.txt`);
    const starts = join(scratch, `mcp-starts-${id}.txt`);
    const script = join(scratch, `mcp-stub-${id}.cjs`);

    writeFileSync(script, [
      "process.on('SIGTERM', () => {});",
      "const fs = require('fs');",
      `fs.appendFileSync(${JSON.stringify(starts)}, process.pid + ${JSON.stringify('\n')});`,
      "process.stdin.resume();",
      `setInterval(() => fs.appendFileSync(${JSON.stringify(marks)}, ${JSON.stringify('work\n')}), 40);`,
    ].join('\n'), 'utf8');

    const count = file => {
      try {
        return readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
      } catch {
        return 0;
      }
    };

    return { script, ticks: () => count(marks), starts: () => count(starts) };
  }

  it('ends the spawned server when the inner layer fails first', async () => {
    const stub = stubServer();
    const layer = new AIStudioLayer();
    layer.resolveMCPServerPath = () => stub.script;

    let spawned;

    await assert.rejects(() => withCLITimeout(async (signal) => {
      signal.addEventListener('abort', () => layer.abortActiveOperations('inner failure'), { once: true });

      // The real path: this spawns the server and registers the child.
      const inFlight = layer.executeMCPCommand('generate_image', { prompt: 'anything' });
      inFlight.catch(() => {}); // it will end when we kill the server

      // Wait for the spawn rather than guessing at it: the layer resolves the
      // path and starts the process asynchronously, and a fixed sleep that is
      // slightly too short would make this case pass for the wrong reason.
      for (let waited = 0; waited < 8000 && layer.activeChildren.size === 0; waited += 100) {
        await settle(100);
      }
      spawned = [...layer.activeChildren][0];
      await settle(300); // let it do some billable work before we give up on it

      // Everything this case concludes rests on the stub having actually run,
      // so that is asserted rather than assumed. Without these the final
      // "dead, and no further work" held just as well for a process that died
      // on startup -- which is what happened: the generated script had a syntax
      // error and the case passed anyway, even with cancellation removed.
      assert.equal(stub.starts(), 1, 'the stand-in server must have started exactly once');
      assert.ok(stub.ticks() > 0, 'and it must have been doing work to be worth cancelling');
      assert.ok(spawned?.pid, 'the production path must have spawned something to cancel');
      assert.equal(isAlive(spawned.pid), true, 'it must still be running when we give up on it');
      assert.ok(
        layer.activeChildren.has(spawned),
        'and the production path -- not the test -- must be what registered it'
      );

      // The inner budget expiring long before the CLI one, as it does for
      // document and multimodal work.
      throw new Error('inner timeout');
    }, 'production-path', 30000), /inner timeout/);

    const atFailure = stub.ticks();
    const startsAtFailure = stub.starts();
    await settle();

    assert.equal(isAlive(spawned.pid), false, 'the server was still billing when the caller gave up');
    assert.equal(stub.ticks(), atFailure, 'no work may happen after the caller was told it failed');
    assert.equal(stub.starts(), startsAtFailure, 'and nothing may be respawned in its place');
  });
});

describe('nothing keeps running after a terminal result', () => {
  // The lifecycle question, asked of the path that bills: once the caller has
  // its answer -- success or failure -- no child, timer or retry belonging to
  // that call may still be doing anything.
  //
  // safeExecute is where every layer call goes through, and its AbortController
  // used to reach nothing at all: it was created, aborted on timeout, and the
  // operation was never given the signal. So a timeout or an inner failure
  // ended the waiting while the MCP server carried on generating, and the retry
  // stacked on top of it paid for a second one.

  // execute() is the production entry point and it authenticates first, so
  // without a key it refuses before spawning anything and these cases would
  // measure the refusal. The value is a well-formed shape and nothing else: the
  // stand-in below never looks at it, and no request leaves the machine.
  const realKey = process.env.AI_STUDIO_API_KEY;
  process.env.AI_STUDIO_API_KEY = 'AIzaSyTESTKEYNOTREALNOTUSED0000000000';
  after(() => {
    if (realKey === undefined) {
      delete process.env.AI_STUDIO_API_KEY;
    } else {
      process.env.AI_STUDIO_API_KEY = realKey;
    }
  });

  /** A stand-in MCP server: ignores SIGTERM, records that it started, keeps working. */
  function stubServer() {
    const id = Math.random().toString(36).slice(2);
    const marks = join(scratch, `life-marks-${id}.txt`);
    const starts = join(scratch, `life-starts-${id}.txt`);
    const script = join(scratch, `life-stub-${id}.cjs`);

    writeFileSync(script, [
      "process.on('SIGTERM', () => {});",
      "const fs = require('fs');",
      `fs.appendFileSync(${JSON.stringify(starts)}, process.pid + ${JSON.stringify('\n')});`,
      "process.stdin.resume();",
      `setInterval(() => fs.appendFileSync(${JSON.stringify(marks)}, ${JSON.stringify('work\n')}), 40);`,
    ].join('\n'), 'utf8');

    const count = file => {
      try {
        return readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
      } catch {
        return 0;
      }
    };

    return { script, ticks: () => count(marks), starts: () => count(starts) };
  }

  /**
   * Start a layer command through the production route and wait for its child.
   *
   * The child is identified by difference against what was already running:
   * one layer instance can have several in flight, and taking the first entry
   * of the set handed back someone else's process.
   */
  async function spawnThrough(layer, signal) {
    const before = new Set(layer.activeChildren);
    const inFlight = layer.execute({ action: 'generate_image', prompt: 'anything' }, signal);
    inFlight.catch(() => {}); // it ends when the child is killed

    const fresh = () => [...layer.activeChildren].find(child => !before.has(child));
    for (let waited = 0; waited < 15000 && !fresh(); waited += 100) {
      await settle(100);
    }
    return fresh();
  }

  it('ends the layer child when the operation around it fails', async () => {
    const stub = stubServer();
    const layer = new AIStudioLayer();
    layer.resolveMCPServerPath = () => stub.script;

    let spawned;

    await assert.rejects(() => safeExecute(async (signal) => {
      spawned = await spawnThrough(layer, signal);
      await settle(300); // let it bill for a while before we give up on it

      // Preconditions, so this cannot conclude anything about a stand-in that
      // died on startup -- which is exactly how an earlier version of this
      // shape passed with cancellation removed.
      assert.equal(stub.starts(), 1, 'the stand-in must have started exactly once');
      assert.ok(stub.ticks() > 0, 'and it must be doing work worth cancelling');
      assert.ok(spawned?.pid, 'the production path must have spawned something');
      assert.equal(isAlive(spawned.pid), true, 'it must still be running when we give up');

      // An inner failure, which is the common case: the layer's own budget or
      // the API rejecting, long before any outer timeout.
      throw new Error('inner failure');
    }, { operationName: 'lifecycle-inner-failure', timeout: 60000 }), /inner failure/);

    const atFailure = stub.ticks();
    await settle();

    assert.equal(isAlive(spawned.pid), false, 'the server was still billing after the caller gave up');
    assert.equal(stub.ticks(), atFailure, 'no work may happen after a terminal result');
    assert.equal(stub.starts(), 1, 'and nothing may be respawned in its place');
  });

  it('ends the layer child when the operation around it times out', async () => {
    const stub = stubServer();
    const layer = new AIStudioLayer();
    layer.resolveMCPServerPath = () => stub.script;

    let spawned;

    await assert.rejects(() => safeExecute(async (signal) => {
      spawned = await spawnThrough(layer, signal);
      assert.ok(spawned?.pid, 'the production path must have spawned something');
      await new Promise(resolve => setTimeout(resolve, 30000)); // outlive the budget
    }, { operationName: 'lifecycle-timeout', timeout: 2000 }), /timed out/);

    const atTimeout = stub.ticks();
    await settle();

    assert.equal(isAlive(spawned.pid), false, 'a timeout that leaves the work running is not a timeout');
    assert.equal(stub.ticks(), atTimeout, 'no work may happen after the caller was told it timed out');
  });

  it('does not cancel a caller that is still waiting on a sibling call', async () => {
    // One layer instance serves concurrent requests. Cancellation is per-call:
    // one caller giving up must not take another caller's child with it, which
    // is why the signal travels in async context rather than on the instance.
    const doomed = stubServer();
    const survivor = stubServer();
    const layer = new AIStudioLayer();

    layer.resolveMCPServerPath = () => survivor.script;
    let keeper;
    const keptAlive = safeExecute(async (signal) => {
      keeper = await spawnThrough(layer, signal);
      await new Promise(resolve => setTimeout(resolve, 4000));
      return 'still here';
    }, { operationName: 'lifecycle-sibling', timeout: 60000 });

    for (let waited = 0; waited < 15000 && !keeper; waited += 100) {
      await settle(100);
    }
    assert.ok(keeper?.pid, 'the surviving call must have a child');

    layer.resolveMCPServerPath = () => doomed.script;
    let victim;
    await assert.rejects(() => safeExecute(async (signal) => {
      victim = await spawnThrough(layer, signal);
      assert.ok(victim?.pid && victim.pid !== keeper.pid, 'the two calls must have separate children');
      throw new Error('inner failure');
    }, { operationName: 'lifecycle-victim', timeout: 60000 }), /inner failure/);

    await settle();

    assert.equal(isAlive(victim.pid), false, 'the cancelled call must have ended its own child');
    assert.equal(isAlive(keeper.pid), true, "and must not have ended anyone else's");

    assert.equal(await keptAlive, 'still here');
    layer.abortActiveOperations('test cleanup');
  });
});

describe('the shared MCP process answers the caller who asked', () => {
  // executeMCPCommandOptimized reuses one process for several requests -- the
  // route a general text request and a multi-PDF analysis take. Each call used
  // to add its own stdout listener and settle on the first line carrying a
  // result or an error, whatever id it had, so two concurrent requests both
  // took the first answer: one caller was handed the other caller's output and
  // nothing reported a problem. The ids were Date.now(), which two requests in
  // the same millisecond share.

  /**
   * A stand-in MCP server that answers out of order.
   *
   * The second request is answered first, and each answer carries the id it
   * was asked with, so a router that matches ids gets both right and one that
   * takes the first line gets both wrong.
   */
  // The escapes below are doubled on purpose. A single backslash in this
  // file is a JavaScript escape, so it puts a real carriage return inside a
  // regex literal and a real newline inside a quoted string in the file that
  // gets written -- and the stand-in then dies on startup, which looks
  // exactly like a stand-in that was cancelled.
  function reorderingServer() {
    const script = join(scratch, `reorder-${Math.random().toString(36).slice(2)}.cjs`);

    writeFileSync(script, [
      "const held = [];",
      "let buf = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', chunk => {",
      "  buf += chunk;",
      "  const lines = buf.split(/\\r?\\n/);",
      "  buf = lines.pop() || '';",
      "  for (const line of lines) {",
      "    if (!line.trim()) { continue; }",
      "    const req = JSON.parse(line);",
      "    held.push(req);",
      "    if (held.length === 2) {",
      "      for (const r of held.reverse()) {",
      "        const answer = { jsonrpc: '2.0', id: r.id,",
      "          result: { content: [{ type: 'text', text: 'answer-for-' + r.params.arguments.marker }] } };",
      "        process.stdout.write(JSON.stringify(answer) + '\\n');",
      "      }",
      "    }",
      "  }",
      "});",
      "process.stdin.resume();",
    ].join('\n'), 'utf8');

    return script;
  }

  it('gives each concurrent caller its own answer, in whatever order they arrive', async () => {
    const layer = new AIStudioLayer();
    layer.resolveMCPServerPath = () => reorderingServer();

    const first = layer.executeMCPCommandOptimized('analyze_documents', { marker: 'alpha' });
    const second = layer.executeMCPCommandOptimized('analyze_documents', { marker: 'beta' });

    const [a, b] = await Promise.all([first, second]);

    const textOf = r => (r?.content ?? []).map(c => c.text ?? '').join('');
    assert.equal(textOf(a), 'answer-for-alpha', 'the first caller was handed the wrong answer');
    assert.equal(textOf(b), 'answer-for-beta', 'the second caller was handed the wrong answer');
  });

  it('does not reuse an id between two in-flight requests', async () => {
    // Date.now() collides for anything issued inside the same millisecond, and
    // two ids that are equal cannot be routed apart however good the router is.
    const layer = new AIStudioLayer();
    const ids = new Set();

    for (let i = 0; i < 50; i += 1) {
      ids.add(layer.nextOptimizedRequestId());
    }

    assert.equal(ids.size, 50, 'every in-flight request needs an id of its own');
  });

  it('fails the callers still waiting when the shared process dies', async () => {
    // Otherwise they wait out their own timeout -- minutes -- for a process
    // that is already gone.
    const script = join(scratch, `dies-${Math.random().toString(36).slice(2)}.cjs`);
    writeFileSync(script, "process.stdin.resume(); setTimeout(() => process.exit(7), 300);", 'utf8');

    const layer = new AIStudioLayer();
    layer.resolveMCPServerPath = () => script;

    await assert.rejects(
      () => layer.executeMCPCommandOptimized('analyze_documents', { marker: 'orphan' }),
      /exited \(code 7\)/,
      'a caller must be told the process died rather than waiting for its own timeout'
    );
  });

  it('stops waiting when its own call is cancelled, and leaves siblings alone', async () => {
    // The process is shared, so cancelling one request must not kill it: the
    // other caller is very likely mid-answer on the same process.
    //
    // The stand-in here answers only the sibling and never the cancelled one,
    // so the cancellation is what ends that call. An earlier version used the
    // reordering stand-in, which answers both as soon as the second request
    // arrives -- the "cancelled" call had already resolved before abort() was
    // reached, and the case passed without cancelling anything.
    const script = join(scratch, `selective-${Math.random().toString(36).slice(2)}.cjs`);
    writeFileSync(script, [
      "let buf = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', chunk => {",
      "  buf += chunk;",
      "  const lines = buf.split(/\\r?\\n/);",
      "  buf = lines.pop() || '';",
      "  for (const line of lines) {",
      "    if (!line.trim()) { continue; }",
      "    const req = JSON.parse(line);",
      "    if (req.params.arguments.marker !== 'kept') { continue; }",
      "    const answer = { jsonrpc: '2.0', id: req.id,",
      "      result: { content: [{ type: 'text', text: 'answer-for-kept' }] } };",
      "    process.stdout.write(JSON.stringify(answer) + '\\n');",
      "  }",
      "});",
      "process.stdin.resume();",
    ].join(NEWLINE), 'utf8');

    const layer = new AIStudioLayer();
    layer.resolveMCPServerPath = () => script;

    const controller = new AbortController();
    const cancelled = layer.executeMCPCommandOptimized('analyze_documents', { marker: 'doomed' }, controller.signal);
    cancelled.catch(() => {});

    const survivor = layer.executeMCPCommandOptimized('analyze_documents', { marker: 'kept' });

    await settle(300);
    controller.abort();

    await assert.rejects(() => cancelled, /cancelled/);

    const textOf = r => (r?.content ?? []).map(c => c.text ?? '').join('');
    assert.equal(textOf(await survivor), 'answer-for-kept', 'the sibling call must still be answered');
  });

  it('takes its cancellation from execute(), not only from an argument', async () => {
    // The production route. Every other case here hands the signal in
    // directly, which does not exercise the async context that execute() sets
    // up -- and the optimized path read no context at all: `processGeneral`
    // and multi-PDF analysis go through it, so an outer timeout or failure
    // left them waiting on a request nobody wanted.
    const script = join(scratch, `silent-${Math.random().toString(36).slice(2)}.cjs`);
    writeFileSync(script, "process.stdin.resume();", 'utf8'); // never answers

    const layer = new AIStudioLayer();
    layer.resolveMCPServerPath = () => script;

    await assert.rejects(
      () => safeExecute(
        (signal) => layer.execute({ action: 'generate_content', prompt: 'anything' }, signal),
        { operationName: 'optimized-context', timeout: 2000 }
      ),
      (error) => {
        assert.match(String(error.message), /cancelled|timed out/i);
        return true;
      }
    );

    // The request must be gone from the router, not merely unawaited: an entry
    // left behind would take the next response addressed to that id.
    assert.equal(layer.pendingOptimized.size, 0, 'a cancelled request must release its slot');
  });

  it('refuses to start at all for a caller that has already given up', async () => {
    const layer = new AIStudioLayer();
    let spawned = 0;
    layer.resolveMCPServerPath = () => { spawned += 1; return reorderingServer(); };

    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      () => layer.executeMCPCommandOptimized('analyze_documents', { marker: 'never' }, controller.signal),
      /cancelled before it started/
    );
    assert.equal(spawned, 0, 'nothing may be spawned for work nobody is waiting for');
  });
});
