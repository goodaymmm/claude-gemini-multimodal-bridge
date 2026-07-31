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

  it('returns the result untouched when the command finishes in time', async () => {
    // Cancellation must not have cost the normal path anything.
    const result = await withCLITimeout(async () => 'finished', 'quick', 5000);

    assert.equal(result, 'finished');
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
