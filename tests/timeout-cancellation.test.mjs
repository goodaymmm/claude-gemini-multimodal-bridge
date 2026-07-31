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
  writeFileSync(script, [
    "process.on('SIGTERM', () => {});",
    `const fs = require('fs');`,
    `setInterval(() => fs.appendFileSync(${JSON.stringify(marks)}, 'tick\\n'), 40);`,
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
      `fs.appendFileSync(${JSON.stringify(starts)}, process.pid + '\n');`,
      "process.stdin.resume();",
      `setInterval(() => fs.appendFileSync(${JSON.stringify(marks)}, 'work\n'), 40);`,
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
      assert.ok(spawned?.pid, 'the production path must have spawned something to cancel');
      await settle(300); // let it do some billable work before we give up on it

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
