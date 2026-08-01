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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { after, describe, it } from 'node:test';

import { AIStudioLayer, shutdownAIStudio } from '../dist/layers/AIStudioLayer.js';
import {
  PGREP_SOURCE,
  PROC_SOURCE,
  isUntrustedBinaryLocation,
  listDescendants,
  resetPgrepResolution,
  resolveSystemPgrep,
  resolveSystemTaskkill,
  resolveTrustedCommand,
  terminateProcessTree,
} from '../dist/utils/processUtils.js';
import { runShutdown } from '../dist/utils/shutdown.js';
import { safeExecute } from '../dist/utils/errorHandler.js';
import { withCLITimeout } from '../dist/utils/TimeoutManager.js';

// Not `cgmb-agy-*`: the workspace-isolation test scans tmpdir for that prefix.
const scratch = mkdtempSync(join(tmpdir(), 'cgmb-cancel-'));

after(async () => {
  // The persistent MCP server is reused across requests and nothing used to
  // end one, so its stdio pipes kept this process alive: every case here
  // passed and the file then hung until the runner gave up. The same pipes
  // kept `cgmb` from exiting after any request that used that path.
  await shutdownAIStudio();
  rmSync(scratch, { recursive: true, force: true });
});

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

describe('ending a child ends what it started', () => {
  // terminateProcessTree is what every cancellation path calls. Its POSIX
  // branch signals the negative pid, which only reaches a process group -- and
  // a child gets a group of its own only when spawned detached. Without that,
  // measured, the call fails with ESRCH and the fallback kills the one process
  // we hold, leaving the helpers that `claude` and `agy` start behind.
  //
  // Windows has no groups; taskkill /T is the equivalent and is exercised here
  // as well, since the tree is the same shape either way.

  for (const [shape, spawnOptions] of [
    ['its own process group', process.platform === 'win32' ? {} : { detached: true }],
    ['no group of its own, walked instead', {}],
  ]) {
  it(`kills a grandchild with ${shape}`, async () => {
    const id = Math.random().toString(36).slice(2);
    const marks = join(scratch, `grandchild-marks-${id}.txt`);
    const pidFile = join(scratch, `grandchild-pid-${id}.txt`);

    // The parent spawns a grandchild that ignores SIGTERM and keeps writing,
    // then does nothing itself. Killing the parent alone leaves the writer.
    const grandchild = join(scratch, `grandchild-${id}.cjs`);
    writeFileSync(grandchild, [
      "process.on('SIGTERM', () => {});",
      "const fs = require('fs');",
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      `setInterval(() => fs.appendFileSync(${JSON.stringify(marks)}, 'tick'), 40);`,
    ].join(NEWLINE), 'utf8');

    const parent = join(scratch, `grandparent-${id}.cjs`);
    writeFileSync(parent, [
      "const { spawn } = require('child_process');",
      `spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: 'ignore' });`,
      "setInterval(() => {}, 1000);",
    ].join(NEWLINE), 'utf8');

    // Both mechanisms are exercised: `detached` is how the layers spawn, and
    // gives the child a group the kernel can end atomically; without it there
    // is no group and the walk is what has to find the grandchild. Testing only
    // the detached shape would have proved the easy case, and only the
    // undetached shape would have left the production path unexercised.
    const child = spawn(process.execPath, [parent], { stdio: 'ignore', ...spawnOptions });

    for (let waited = 0; waited < 8000 && !existsSync(pidFile); waited += 100) {
      await settle(100);
    }
    const grandPid = Number(readFileSync(pidFile, 'utf8'));
    assert.ok(grandPid > 0, 'the grandchild must have started to prove anything');

    await settle(300);
    const ticks = () => {
      try {
        return readFileSync(marks, 'utf8').split('tick').length - 1;
      } catch {
        return 0;
      }
    };
    assert.ok(ticks() > 0, 'and it must be doing work worth ending');

    terminateProcessTree(child);
    await settle();

    assert.equal(isAlive(grandPid), false, 'the grandchild outlived the tree it belonged to');
    const atKill = ticks();
    await settle();
    assert.equal(ticks(), atKill, 'and it must not have done anything more');
  });
  }
});

describe('a cancelled request is cancelled inside the server too', () => {
  // Dropping the caller's end of a shared process is only half of it. The
  // server went on holding the abandoned request -- and its Google call -- so
  // a run of cancellations accumulated work nobody could see, inside a process
  // that outlives them all.
  //
  // What this proves is that the server is told. It cannot prove the charge
  // stops: Google documents abortSignal as client-side only and bills work
  // already started. Telling the server is what stops the accumulation.

  /** A stand-in that records every cancellation notification and never answers. */
  function recordsCancellations(seen) {
    const script = join(scratch, `records-${Math.random().toString(36).slice(2)}.cjs`);
    writeFileSync(script, [
      "const fs = require('fs');",
      "let buf = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', chunk => {",
      "  buf += chunk;",
      "  const lines = buf.split(/\\r?\\n/);",
      "  buf = lines.pop() || '';",
      "  for (const line of lines) {",
      "    if (!line.trim()) { continue; }",
      "    const msg = JSON.parse(line);",
      `    fs.appendFileSync(${JSON.stringify(seen)}, (msg.method || 'call:' + msg.id) + ' ');`,
      "  }",
      "});",
      "process.stdin.resume();",
    ].join(NEWLINE), 'utf8');
    return script;
  }

  const recordedIn = seen => {
    try {
      return readFileSync(seen, 'utf8').trim().split(/\s+/).filter(Boolean);
    } catch {
      return [];
    }
  };

  it('tells the server when its own budget runs out, not only when the caller aborts', async () => {
    // A timeout is a terminal result for this caller, and the paths above it
    // retry -- so leaving the server working on the abandoned request meant the
    // retry ran alongside it. The notification used to be sent only from the
    // abort handler.
    const seen = join(scratch, `timeout-cancel-${Math.random().toString(36).slice(2)}.txt`);
    const layer = new AIStudioLayer();
    layer.resolveMCPServerPath = () => recordsCancellations(seen);
    layer.calculateOptimizedTimeout = () => 1500;

    await assert.rejects(
      () => layer.executeMCPCommandOptimized('analyze_documents', { marker: 'slow' }),
      /timeout/
    );
    await settle(400);

    assert.ok(
      recordedIn(seen).includes('notifications/cancelled'),
      `the server was never told: ${recordedIn(seen).join(',')}`
    );

    await shutdownAIStudio();
  });

  it('does not send a request for a caller who gave up while the process was starting', async () => {
    // The pre-check runs before awaiting the process and the listener is
    // attached after, so a signal firing in between was seen by neither -- and
    // the request went out on behalf of someone who had already left.
    const seen = join(scratch, `race-${Math.random().toString(36).slice(2)}.txt`);
    const layer = new AIStudioLayer();
    const controller = new AbortController();

    layer.resolveMCPServerPath = () => {
      // Aborting here happens between the pre-check and the listener: this is
      // the window, made deterministic.
      controller.abort();
      return recordsCancellations(seen);
    };

    await assert.rejects(
      () => layer.executeMCPCommandOptimized('analyze_documents', { marker: 'gone' }, controller.signal),
      /cancelled/
    );
    await settle(400);

    assert.deepEqual(
      recordedIn(seen).filter(entry => entry.startsWith('call:')), [],
      'a request must not be sent for a caller who has already given up'
    );

    await shutdownAIStudio();
  });

  it('tells the server which request to abandon', async () => {
    const seen = join(scratch, `cancelled-${Math.random().toString(36).slice(2)}.txt`);
    const script = join(scratch, `records-cancel-${Math.random().toString(36).slice(2)}.cjs`);

    writeFileSync(script, [
      "const fs = require('fs');",
      "let buf = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', chunk => {",
      "  buf += chunk;",
      "  const lines = buf.split(/\\r?\\n/);",
      "  buf = lines.pop() || '';",
      "  for (const line of lines) {",
      "    if (!line.trim()) { continue; }",
      "    const msg = JSON.parse(line);",
      "    if (msg.method === 'notifications/cancelled') {",
      `      fs.appendFileSync(${JSON.stringify(seen)}, String(msg.params.requestId) + ' ');`,
      "    }",
      "  }",
      "});",
      "process.stdin.resume();",
    ].join(NEWLINE), 'utf8');

    const layer = new AIStudioLayer();
    layer.resolveMCPServerPath = () => script;

    const controller = new AbortController();
    const inFlight = layer.executeMCPCommandOptimized('analyze_documents', { marker: 'x' }, controller.signal);
    inFlight.catch(() => {});

    await settle(400);
    controller.abort();
    await assert.rejects(() => inFlight, /cancelled/);
    await settle(400);

    const recorded = readFileSync(seen, 'utf8').trim().split(/\s+/).filter(Boolean);
    assert.equal(recorded.length, 1, `the server must be told exactly once, got: ${recorded.join(',')}`);
    assert.match(recorded[0], /^[0-9]+$/, 'and told which request, by id');

    await shutdownAIStudio();
  });
});

describe('replacing the shared process on its TTL', () => {
  // The process is replaced every ten minutes. The old one is killed and the
  // field reassigned without waiting, so the old process's exit arrives after
  // the replacement is already in place -- and the handlers read the field
  // rather than the process they belong to. The result was that a healthy new
  // server was deleted from the live set and the field set to undefined, so the
  // next request spawned a third one and the second was orphaned. The old
  // router also failed every waiting request, including those already sent to
  // the replacement.

  function answeringServer() {
    const script = join(scratch, `answering-${Math.random().toString(36).slice(2)}.cjs`);
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
      "    const answer = { jsonrpc: '2.0', id: req.id,",
      "      result: { content: [{ type: 'text', text: 'answered-' + req.params.arguments.marker }] } };",
      "    process.stdout.write(JSON.stringify(answer) + '\\n');",
      "  }",
      "});",
      "process.stdin.resume();",
    ].join(NEWLINE), 'utf8');
    return script;
  }

  it('does not let the replaced process disown its replacement', async () => {
    const layer = new AIStudioLayer();
    layer.resolveMCPServerPath = () => answeringServer();

    const first = await layer.executeMCPCommandOptimized('analyze_documents', { marker: 'one' });
    const original = layer.persistentMCPProcess;
    assert.ok(original?.pid, 'the first request must have started a server');

    // Age it past its TTL, which is what the ten-minute boundary does.
    layer.mcpProcessStartTime = 0;

    const second = await layer.executeMCPCommandOptimized('analyze_documents', { marker: 'two' });
    const replacement = layer.persistentMCPProcess;

    const textOf = r => (r?.content ?? []).map(c => c.text ?? '').join('');
    assert.equal(textOf(first), 'answered-one');
    assert.equal(textOf(second), 'answered-two');
    assert.ok(replacement?.pid, 'the replacement must exist');
    assert.notEqual(replacement.pid, original.pid, 'and it must be a different process');

    // The old process's exit lands here, after the field has been reassigned.
    await settle();

    assert.equal(
      layer.persistentMCPProcess, replacement,
      'the dying process disowned its replacement'
    );

    // And the replacement must still work rather than needing a third spawn.
    const third = await layer.executeMCPCommandOptimized('analyze_documents', { marker: 'three' });
    assert.equal(textOf(third), 'answered-three');
    assert.equal(layer.persistentMCPProcess.pid, replacement.pid, 'no third process may be needed');

    await shutdownAIStudio();
  });
});

describe('shutdown reaches what a running server started', () => {
  // The awaited shutdown at the end of the CLI runs when parseAsync returns --
  // and for `serve` that is the moment the server has *started*, before any
  // persistent child exists, so it always cleaned up nothing. The signal
  // handlers then called process.exit() without awaiting anything, so a
  // long-running server that had spawned an MCP child left it behind with
  // whatever it had in flight.

  it('ends a persistent child created after the process started', async () => {
    const script = join(scratch, `late-${Math.random().toString(36).slice(2)}.cjs`);
    writeFileSync(script, "process.stdin.resume();", 'utf8'); // outlives its caller

    const layer = new AIStudioLayer();
    layer.resolveMCPServerPath = () => script;

    // Started the way a long-running server starts one: mid-life, well after
    // any startup-time cleanup would have run.
    const inFlight = layer.executeMCPCommandOptimized('analyze_documents', { marker: 'late' });
    inFlight.catch(() => {});

    let child;
    for (let waited = 0; waited < 15000 && !child; waited += 100) {
      await settle(100);
      child = layer.persistentMCPProcess;
    }

    assert.ok(child?.pid, 'the server must have started one to prove anything');
    assert.equal(isAlive(child.pid), true, 'and it must be running when shutdown is asked for');

    await runShutdown();
    await settle();

    assert.equal(isAlive(child.pid), false, 'a running server left its child behind on shutdown');
  });

  it('can be asked twice without doing it twice', async () => {
    // A SIGINT arriving while a command is finishing must not race the same
    // cleanup from two directions.
    const first = runShutdown();
    const second = runShutdown();

    assert.equal(first, second, 'concurrent callers must share one run');
    await first;
  });
});

describe('a grandchild that leaves the group is still ended', {
  skip: process.platform === 'win32' && 'setsid is POSIX; Windows uses taskkill /T',
}, () => {
  // A successful group signal says only that something in that group received
  // it. A child that calls setsid has left for a group of its own -- the signal
  // still succeeds and the escapee never hears it. Treating that success as
  // "the tree is gone" skipped the walk, which is the only thing that could
  // have found it.

  it('finds one that called setsid and left', async () => {
    const id = Math.random().toString(36).slice(2);
    const marks = join(scratch, `escapee-marks-${id}.txt`);
    const pidFile = join(scratch, `escapee-pid-${id}.txt`);

    const escapee = join(scratch, `escapee-${id}.cjs`);
    writeFileSync(escapee, [
      "process.on('SIGTERM', () => {});",
      "const fs = require('fs');",
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      `setInterval(() => fs.appendFileSync(${JSON.stringify(marks)}, 'tick'), 40);`,
    ].join(NEWLINE), 'utf8');

    // detached inside the child: a session of its own, out of the parent's
    // process group entirely.
    const parent = join(scratch, `escapee-parent-${id}.cjs`);
    writeFileSync(parent, [
      "const { spawn } = require('child_process');",
      `spawn(process.execPath, [${JSON.stringify(escapee)}], { stdio: 'ignore', detached: true });`,
      "setInterval(() => {}, 1000);",
    ].join(NEWLINE), 'utf8');

    const child = spawn(process.execPath, [parent], { stdio: 'ignore', detached: true });

    for (let waited = 0; waited < 8000 && !existsSync(pidFile); waited += 100) {
      await settle(100);
    }
    const escapeePid = Number(readFileSync(pidFile, 'utf8'));
    assert.ok(escapeePid > 0, 'the escapee must have started to prove anything');
    await settle(300);

    terminateProcessTree(child);
    await settle();

    assert.equal(
      isAlive(escapeePid), false,
      'a descendant in a group of its own outlived the tree it belonged to'
    );

    try { process.kill(escapeePid, 'SIGKILL'); } catch { /* already gone */ }
  });
});

describe('enumeration without an external tool', {
  // Not just "not Windows": /proc is a Linux thing, and macOS is a supported
  // platform without one. Skipping only Windows would have made the /proc case
  // fail there for a reason that is not a defect -- and neither the Windows nor
  // the WSL run would ever have shown it.
  skip: process.platform !== 'linux' && `/proc enumeration is Linux-only (this is ${process.platform})`,
}, () => {
  // The pgrep candidate list is five absolute paths, which is not every Linux:
  // a distribution shipping it elsewhere would have had no walk at all, and
  // with it no defence against a descendant that left the process group. So on
  // Linux the walk does not use pgrep -- /proc answers the same question with
  // no external process, and therefore no command to resolve.
  //
  // Each source is exercised *alone*. An earlier version of this emptied PATH
  // and expected that to disable pgrep; it does not, because the resolver does
  // not read PATH -- so the case passed with /proc removed entirely, proving
  // nothing. The source is a parameter now, which is the only way to show that
  // one of them works on its own.

  /** A process with a child and a grandchild, for something to enumerate. */
  async function familyOfThree() {
    const id = Math.random().toString(36).slice(2);
    const ready = join(scratch, `family-${id}.txt`);

    const leaf = join(scratch, `family-leaf-${id}.cjs`);
    writeFileSync(leaf, [
      "const fs = require('fs');",
      `fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));`,
      "setInterval(() => {}, 1000);",
    ].join(NEWLINE), 'utf8');

    const mid = join(scratch, `family-mid-${id}.cjs`);
    writeFileSync(mid, [
      "const { spawn } = require('child_process');",
      `spawn(process.execPath, [${JSON.stringify(leaf)}], { stdio: 'ignore' });`,
      "setInterval(() => {}, 1000);",
    ].join(NEWLINE), 'utf8');

    const root = spawn(process.execPath, [mid], { stdio: 'ignore' });
    for (let waited = 0; waited < 8000 && !existsSync(ready); waited += 100) {
      await settle(100);
    }
    const leafPid = Number(readFileSync(ready, 'utf8'));
    return { root, leafPid };
  }

  it('finds the whole family through /proc alone', async () => {
    const { root, leafPid } = await familyOfThree();
    try {
      assert.ok(leafPid > 0, 'the family must exist to be enumerated');
      const found = listDescendants(root.pid, [PROC_SOURCE]);
      assert.ok(found.includes(leafPid), `/proc missed the grandchild: ${found.join(',')}`);
    } finally {
      terminateProcessTree(root);
    }
  });

  it('reports nothing, rather than guessing, when no source can answer', () => {
    const nothingWorks = listDescendants(process.pid, [() => undefined]);
    assert.deepEqual(nothingWorks, [], 'an unusable source must not invent descendants');
  });
});

describe('a descendant that keeps forking while it is being torn down', {
  skip: process.platform !== 'linux' && `needs /proc and process groups (this is ${process.platform})`,
}, () => {
  // Enumeration is a snapshot, and a snapshot races anything still able to
  // fork. Stopping the root's group was not enough: a descendant that had moved
  // to a group of its own -- setsid, or its own detached spawn -- kept running
  // throughout the walk, and anything it forked belonged to neither the list
  // nor any group being signalled.

  it('leaves nothing behind, however fast it spawns', async () => {
    const id = Math.random().toString(36).slice(2);
    const dir = join(scratch, `forker-${id}`);
    mkdirSync(dir, { recursive: true });

    // The escapee lives in its own session and spawns a child every 30ms, each
    // recording its pid. Whatever the walk finds, more have appeared since.
    const spawnee = join(dir, 'spawnee.cjs');
    writeFileSync(spawnee, [
      "const fs = require('fs');",
      `fs.appendFileSync(${JSON.stringify(join(dir, 'pids.txt'))}, process.pid + ' ');`,
      "setInterval(() => {}, 1000);",
    ].join(NEWLINE), 'utf8');

    // Fast, but bounded. It has to still be forking while the walk runs --
    // that is the whole point, and slowing it to 120ms stopped the mutation
    // being caught at all -- but an unbounded one ran the machine hot enough to
    // stall the rest of the suite when node:test runs files concurrently, and a
    // failure would have left it running.
    const forker = join(dir, 'forker.cjs');
    writeFileSync(forker, [
      "const { spawn } = require('child_process');",
      "let spawned = 0;",
      `const timer = setInterval(() => {`,
      `  if (spawned >= 60) { clearInterval(timer); return; }`,
      `  spawned += 1;`,
      `  spawn(process.execPath, [${JSON.stringify(spawnee)}], { stdio: 'ignore' });`,
      `}, 25);`,
    ].join(NEWLINE), 'utf8');

    const parent = join(dir, 'parent.cjs');
    writeFileSync(parent, [
      "const { spawn } = require('child_process');",
      `spawn(process.execPath, [${JSON.stringify(forker)}], { stdio: 'ignore', detached: true });`,
      "setInterval(() => {}, 1000);",
    ].join(NEWLINE), 'utf8');

    const root = spawn(process.execPath, [parent], { stdio: 'ignore', detached: true });
    // Terminated while it is still spawning: the point is a fork that lands
    // during the walk, so the walk has to happen mid-run rather than after.
    await settle(400);

    const before = readFileSync(join(dir, 'pids.txt'), 'utf8').trim().split(/\s+/).filter(Boolean);
    assert.ok(before.length >= 3, `the forker must be busy to prove anything: ${before.length}`);

    terminateProcessTree(root);
    await settle();

    const all = readFileSync(join(dir, 'pids.txt'), 'utf8').trim().split(/\s+/).filter(Boolean);
    const survivors = all.map(Number).filter(pid => isAlive(pid));

    // Clean up before asserting, so a failure does not leave a fork bomb behind.
    for (const pid of survivors) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }

    assert.deepEqual(survivors, [], `processes outlived the tree they belonged to: ${survivors.join(',')}`);
  });
});

describe('enumeration through pgrep', {
  skip: process.platform === 'win32' && 'pgrep is POSIX; Windows uses taskkill /T',
}, () => {
  // Kept for every POSIX platform, since it is what macOS actually uses.

  async function familyOfThree() {
    const id = Math.random().toString(36).slice(2);
    const ready = join(scratch, `pgrep-family-${id}.txt`);

    const leaf = join(scratch, `pgrep-leaf-${id}.cjs`);
    writeFileSync(leaf, [
      "const fs = require('fs');",
      `fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));`,
      "setInterval(() => {}, 1000);",
    ].join(NEWLINE), 'utf8');

    const mid = join(scratch, `pgrep-mid-${id}.cjs`);
    writeFileSync(mid, [
      "const { spawn } = require('child_process');",
      `spawn(process.execPath, [${JSON.stringify(leaf)}], { stdio: 'ignore' });`,
      "setInterval(() => {}, 1000);",
    ].join(NEWLINE), 'utf8');

    const root = spawn(process.execPath, [mid], { stdio: 'ignore' });
    for (let waited = 0; waited < 8000 && !existsSync(ready); waited += 100) {
      await settle(100);
    }
    return { root, leafPid: Number(readFileSync(ready, 'utf8')) };
  }

  it('finds the whole family through pgrep alone, where there is one', async () => {
    const { root, leafPid } = await familyOfThree();
    try {
      const found = listDescendants(root.pid, [PGREP_SOURCE]);
      // Not every POSIX system has pgrep at one of the system paths; if it has
      // none, this source legitimately finds nothing and /proc is what carries
      // the walk. Say which happened rather than asserting blindly.
      if (found.length === 0) {
        assert.equal(resolveSystemPgrep(), undefined, 'pgrep exists but found nothing');
      } else {
        assert.ok(found.includes(leafPid), `pgrep missed the grandchild: ${found.join(',')}`);
      }
    } finally {
      terminateProcessTree(root);
    }
  });

});

describe('the process group carries it when the walk cannot', {
  skip: process.platform === 'win32' && 'POSIX process groups; Windows uses taskkill /T',
}, () => {
  // The two mechanisms cover for each other, which means neither is proven by
  // a case the other can satisfy -- disabling the group path changed nothing
  // while the walk was available. So the walk is taken away: with no pgrep to
  // resolve, only the group can reach a grandchild, which is exactly the
  // situation on a POSIX system without procps.

  it('ends a detached grandchild with no pgrep available', async () => {
    const id = Math.random().toString(36).slice(2);
    const marks = join(scratch, `grouponly-marks-${id}.txt`);
    const pidFile = join(scratch, `grouponly-pid-${id}.txt`);

    const grandchild = join(scratch, `grouponly-gc-${id}.cjs`);
    writeFileSync(grandchild, [
      "process.on('SIGTERM', () => {});",
      "const fs = require('fs');",
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      `setInterval(() => fs.appendFileSync(${JSON.stringify(marks)}, 'tick'), 40);`,
    ].join(NEWLINE), 'utf8');

    const parent = join(scratch, `grouponly-parent-${id}.cjs`);
    writeFileSync(parent, [
      "const { spawn } = require('child_process');",
      `spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: 'ignore' });`,
      "setInterval(() => {}, 1000);",
    ].join(NEWLINE), 'utf8');

    const child = spawn(process.execPath, [parent], { stdio: 'ignore', detached: true });

    for (let waited = 0; waited < 8000 && !existsSync(pidFile); waited += 100) {
      await settle(100);
    }
    const grandPid = Number(readFileSync(pidFile, 'utf8'));
    assert.ok(grandPid > 0, 'the grandchild must have started to prove anything');
    await settle(300);

    try {
      // The walk is disabled by handing terminateProcessTree a source that
      // cannot answer -- not by emptying PATH, which the resolver never reads.
      // With PATH the case passed against a build with the group kill removed,
      // because the walk quietly did the work and nothing was proven.
      terminateProcessTree(child, [() => undefined]);
      await settle();

      assert.equal(isAlive(grandPid), false, 'the group must have carried it without any walk');
    } finally {
      try { process.kill(grandPid, 'SIGKILL'); } catch { /* already gone */ }
    }
  });
});

describe('where a trusted command may come from', () => {
  // resolveTrustedCommand is what finds claude and agy. Its rule was "not
  // inside the current working directory", which npm and npx walk straight
  // around: both put every *ancestor* node_modules/.bin on PATH, and from a
  // subdirectory of a project those are outside cwd. A shim committed to a
  // repository was therefore trusted and executed with this process's
  // environment -- the same hole that was closed for pgrep, still open for the
  // two binaries that actually get run.

  const SEP = String.fromCharCode(92);
  const onWindows = process.platform === 'win32';

  // Paths have to match the platform. A Windows path handed to resolve() on
  // POSIX is treated as relative, so it lands under the working directory and
  // is rejected for the wrong reason -- which is how the "ordinary install
  // location" case came to assert that C:\Program Files was untrusted on
  // Linux. The same shape of mistake as a /proc case that skipped only Windows.
  const rejected = onWindows
    ? [
      `C:${SEP}repo${SEP}node_modules${SEP}.bin${SEP}claude.cmd`,
      `C:${SEP}a${SEP}b${SEP}node_modules${SEP}x${SEP}y${SEP}claude.cmd`,
      `C:${SEP}repo${SEP}node_modules${SEP}.bin${SEP}pgrep.cmd`,
    ]
    : [
      '/repo/node_modules/.bin/agy',
      '/home/u/project/node_modules/.bin/pgrep',
      '/a/b/node_modules/x/y/claude',
    ];

  const accepted = onWindows
    ? [
      `C:${SEP}Program Files${SEP}nodejs${SEP}claude.cmd`,
      `C:${SEP}Windows${SEP}System32${SEP}taskkill.exe`,
    ]
    : [
      '/usr/local/bin/agy',
      '/usr/bin/pgrep',
    ];

  it('refuses anything under a node_modules, wherever it is', () => {
    for (const candidate of rejected) {
      assert.equal(
        isUntrustedBinaryLocation(candidate), true,
        `a binary under node_modules must never be trusted: ${candidate}`
      );
    }
  });

  it('still accepts an ordinary installed location', () => {
    // The rule has to stay usable: rejecting everything would be safe and
    // useless, and these are where the real binaries live.
    for (const candidate of accepted) {
      assert.equal(
        isUntrustedBinaryLocation(candidate), false,
        `an ordinary install location must remain usable: ${candidate}`
      );
    }
  });
});

describe('what the Windows tree kill is allowed to run', {
  skip: process.platform !== 'win32' && 'taskkill is Windows-only',
}, () => {
  it('will not take its executable from a SystemRoot of the wrong shape', () => {
    // The path is built from SystemRoot, which is an ordinary environment
    // variable: a relative path, a UNC share, a device path or an 8.3 short
    // name all point somewhere else, and whatever sits at System32\taskkill.exe
    // under it would run at this process's privileges.
    //
    // The real root must still be accepted. The first version of this check was
    // a regex whose backslash did not survive being written, so it matched only
    // forward slashes -- `C:\Windows` was rejected, taskkill was never used,
    // and Windows lost its tree kill entirely. Three suites failed before
    // anything noticed, which is the only reason it was caught.
    const saved = process.env.SystemRoot;

    // Built from character codes, not typed. A single backslash in a JS string
    // literal is an escape -- 'C:\Windows' is the seven characters C:Windows --
    // and an earlier version of this asserted against exactly that, then failed
    // because no such directory exists.
    const SEP = String.fromCharCode(92);
    const accepted = [saved, `C:${SEP}Windows`, 'D:/Windows'];
    const rejected = [
      `relative${SEP}path`,
      `${SEP}${SEP}server${SEP}share`,        // UNC
      `${SEP}${SEP}?${SEP}C:${SEP}Windows`,   // device path
      'C:',                                   // no directory at all
      `C:${SEP}PROGRA~1`,                     // 8.3 short name
      '',
    ];

    try {
      for (const root of rejected) {
        process.env.SystemRoot = root;
        assert.equal(
          resolveSystemTaskkill(), undefined,
          `a SystemRoot of ${JSON.stringify(root)} must not be used to find taskkill`
        );
      }

      for (const root of accepted) {
        if (root === undefined) { continue; }
        process.env.SystemRoot = root;
        const resolved = resolveSystemTaskkill();
        // Only asserted where that root actually exists on this machine; the
        // point is that a well-formed root is not rejected out of hand.
        if (existsSync(join(root, 'System32', 'taskkill.exe'))) {
          assert.ok(resolved, `a real SystemRoot must be usable: ${root}`);
        }
      }
    } finally {
      if (saved === undefined) {
        delete process.env.SystemRoot;
      } else {
        process.env.SystemRoot = saved;
      }
    }
  });

  it('still finds taskkill when SystemRoot is not set at all', () => {
    // The fallback was written as a plain string literal, and a single
    // backslash in one is an escape -- so the default was the seven characters
    // C:Windows, which fails the shape check, which means no taskkill, which
    // means no tree kill. Exactly the failure that had just been fixed, waiting
    // in the branch nothing exercised. The accepted-shapes case above skips
    // when SystemRoot is undefined, so it did not cover this.
    const saved = process.env.SystemRoot;
    try {
      delete process.env.SystemRoot;
      const resolved = resolveSystemTaskkill();

      assert.ok(resolved, 'a machine with no SystemRoot must still get the default');
      assert.ok(existsSync(resolved), `and it must exist: ${resolved}`);
    } finally {
      if (saved === undefined) {
        delete process.env.SystemRoot;
      } else {
        process.env.SystemRoot = saved;
      }
    }
  });

  it('does not run a taskkill from PATH or the current directory', () => {
    // cmd.exe searches the current directory before PATH, and every call was
    // `execSync('taskkill /pid ...')` -- so a taskkill.cmd in a checkout, or
    // anywhere on PATH, would have run on every timeout, cancellation and
    // shutdown with this process's environment. Resolved from System32 by
    // absolute path now, with no shell involved.
    //
    // Planted on PATH as well as in the current directory: this machine sets
    // NoDefaultCurrentDirectoryInExePath, which masks the cwd half, so a case
    // that only planted there demonstrated nothing here -- and passed with the
    // shell call restored.
    const stolen = join(scratch, `taskkill-stolen-${Math.random().toString(36).slice(2)}.txt`);
    const plantedDir = join(scratch, `taskkill-bin-${Math.random().toString(36).slice(2)}`);
    mkdirSync(plantedDir, { recursive: true });

    const onPath = join(plantedDir, 'taskkill.cmd');
    const inCwd = join(process.cwd(), 'taskkill.cmd');
    const body = `@echo off\r\necho stolen > "${stolen}"\r\n`;
    writeFileSync(onPath, body, 'utf8');
    writeFileSync(inCwd, body, 'utf8');

    const savedPath = process.env.PATH;
    try {
      process.env.PATH = plantedDir + delimiter + savedPath;

      // A pid that cannot exist, so the real taskkill simply fails.
      terminateProcessTree({ pid: 2147480000, kill: () => false });
      assert.equal(existsSync(stolen), false, 'a planted taskkill was executed');
    } finally {
      process.env.PATH = savedPath;
      rmSync(inCwd, { force: true });
    }
  });
});

describe('what the tree walk is allowed to run', () => {
  // The walk shells out to `pgrep`, and the first version resolved it from
  // PATH. This module exists partly to stop that: npm and npx both put
  // node_modules/.bin at the front of PATH, so a `pgrep` committed to a
  // repository would have been executed during cancellation and shutdown --
  // inheriting this process's whole environment, API keys included.

  it('refuses a pgrep planted in an ancestor of the working directory', () => {
    // The first fix routed pgrep through resolveTrustedCommand, whose rule is
    // "not inside the current working directory". Run from a subdirectory --
    // which is normal -- the repository's own node_modules/.bin becomes an
    // *ancestor*, outside cwd, and was therefore trusted. npm and npx put
    // ancestor .bin directories on PATH, so this is the ordinary case, not an
    // exotic one. pgrep is resolved from a fixed list of system paths now, so
    // no PATH entry of any shape can be chosen.
    const nested = join(scratch, `nested-cwd-${Math.random().toString(36).slice(2)}`);
    const ancestorBin = join(nested, 'node_modules', '.bin');
    mkdirSync(join(nested, 'subdir'), { recursive: true });
    mkdirSync(ancestorBin, { recursive: true });

    const stolen = join(scratch, `ancestor-stolen-${Math.random().toString(36).slice(2)}.txt`);
    const fake = join(ancestorBin, process.platform === 'win32' ? 'pgrep.cmd' : 'pgrep');
    if (process.platform === 'win32') {
      writeFileSync(fake, `@echo off\r\necho stolen > "${stolen}"\r\n`, 'utf8');
    } else {
      writeFileSync(fake, `#!/bin/sh\necho stolen > "${stolen}"\n`, { mode: 0o755 });
    }

    const savedPath = process.env.PATH;
    const savedCwd = process.cwd();
    try {
      process.chdir(join(nested, 'subdir'));
      process.env.PATH = ancestorBin + delimiter + savedPath;
      resetPgrepResolution();

      terminateProcessTree({ pid: 2147480000, kill: () => false });
      assert.equal(existsSync(stolen), false, 'a pgrep on PATH was executed');
    } finally {
      process.chdir(savedCwd);
      process.env.PATH = savedPath;
      resetPgrepResolution();
    }
  });

  it('refuses a pgrep planted in the working tree', () => {
    const planted = join(process.cwd(), 'node_modules', '.bin');
    mkdirSync(planted, { recursive: true });

    const stolen = join(scratch, `stolen-${Math.random().toString(36).slice(2)}.txt`);
    const fake = join(planted, process.platform === 'win32' ? 'pgrep.cmd' : 'pgrep');

    if (process.platform === 'win32') {
      writeFileSync(fake, `@echo off\r\necho stolen > "${stolen}"\r\n`, 'utf8');
    } else {
      writeFileSync(fake, `#!/bin/sh\necho stolen > "${stolen}"\n`, { mode: 0o755 });
    }

    const savedPath = process.env.PATH;
    try {
      process.env.PATH = planted + delimiter + savedPath;
      resetPgrepResolution();

      const resolved = resolveTrustedCommand('pgrep');
      assert.ok(
        resolved === undefined || !resolved.includes('node_modules'),
        `a pgrep inside the tree must never be chosen, got: ${resolved}`
      );

      // And the production path must not have run it.
      terminateProcessTree({ pid: process.pid + 999999, kill: () => false });
      assert.equal(existsSync(stolen), false, 'the planted pgrep was executed');
    } finally {
      process.env.PATH = savedPath;
      resetPgrepResolution();
      rmSync(fake, { force: true });
    }
  });

  it('takes pgrep only from a system directory, whatever PATH says', () => {
    // This used to assert on resolveTrustedCommand, which is no longer how
    // pgrep is found -- so it was describing a path production does not take.
    // What matters now is that PATH cannot influence the answer at all.
    const savedPath = process.env.PATH;
    try {
      process.env.PATH = join(scratch, 'definitely-empty');
      resetPgrepResolution();
      const withoutPath = resolveSystemPgrep();

      process.env.PATH = savedPath;
      resetPgrepResolution();
      const withPath = resolveSystemPgrep();

      assert.equal(withoutPath, withPath, 'PATH must make no difference to where pgrep comes from');
      if (withPath !== undefined) {
        assert.ok(withPath.startsWith('/'), `pgrep must be an absolute system path: ${withPath}`);
        assert.ok(!withPath.includes('node_modules'), 'and never from a project directory');
      }
    } finally {
      process.env.PATH = savedPath;
      resetPgrepResolution();
    }
  });
});
