/**
 * The shared AI Studio MCP process: who gets which answer, and when it ends.
 *
 * One process serves several requests -- the route a general text request and a
 * multi-PDF analysis take -- and it is replaced on a ten-minute TTL. Two things
 * were wrong with that.
 *
 * Answers went to whoever was listening. Each call added its own stdout
 * listener and settled on the first line carrying a result or an error,
 * whatever id it held, so two concurrent requests both took the first answer:
 * one caller was handed the other's output and nothing reported a problem. The
 * ids were Date.now(), which two requests in the same millisecond share.
 *
 * And nothing ever ended the process. Its stdio pipes keep the parent's event
 * loop alive, so `cgmb` had nothing left to do and would not exit.
 *
 * These are written as invariants rather than as a replay of the fix, because
 * the fix that eventually worked also had to deal with TTL generations: the old
 * process's exit arrives after the field has been reassigned, and handlers that
 * read the field rather than the process they belong to disown the healthy
 * replacement.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { AIStudioLayer } from '../dist/layers/AIStudioLayer.js';

const scratch = mkdtempSync(join(tmpdir(), 'cgmb-mcplife-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

// Built from a character code, never typed. A single backslash in a JavaScript
// string literal is an escape, and generated fixtures have been broken by that
// more than once -- a stand-in that dies on startup looks exactly like a
// stand-in that was never asked anything.
const NEWLINE = String.fromCharCode(10);
const ESC_CR = String.fromCharCode(92) + 'r';
const ESC_LF = String.fromCharCode(92) + 'n';

const settle = (ms = 600) => new Promise(resolve => setTimeout(resolve, ms));

const isAlive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const textOf = r => (r?.content ?? []).map(c => c.text ?? '').join('');

/**
 * A stand-in MCP server.
 *
 * `mode` decides what it does with requests:
 *   reorder - hold two, then answer them in reverse order
 *   echo    - answer each immediately, tagged with its marker
 *   silent  - never answer
 *
 * Returns the script path and the file the stand-in writes its own pid to.
 * That pid is the point: on Windows the layer spawns through cmd.exe, so the
 * ChildProcess it holds is the shell, and the shell's pid says nothing about
 * whether the server is still running. Asserting on it passes while an orphaned
 * server keeps running -- which is exactly what was happening.
 */
function standIn(mode) {
  const name = `standin-${mode}-${Math.random().toString(36).slice(2)}`;
  const script = join(scratch, `${name}.cjs`);
  const pidFile = join(scratch, `${name}.pid`);

  const common = [
    `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
    "let buf = '';",
    "const held = [];",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', chunk => {",
    "  buf += chunk;",
    `  const lines = buf.split(/${ESC_CR}?${ESC_LF}/);`,
    "  buf = lines.pop() || '';",
    "  for (const line of lines) {",
    "    if (!line.trim()) { continue; }",
    "    const req = JSON.parse(line);",
    "    handle(req);",
    "  }",
    "});",
    "process.stdin.resume();",
    "const answer = req => ({ jsonrpc: '2.0', id: req.id,",
    "  result: { content: [{ type: 'text', text: 'answer-for-' + req.params.arguments.marker }] } });",
    `const send = obj => process.stdout.write(JSON.stringify(obj) + '${ESC_LF}');`,
  ];

  const handlers = {
    reorder: [
      "function handle(req) {",
      "  held.push(req);",
      "  if (held.length === 2) { for (const r of held.reverse()) { send(answer(r)); } }",
      "}",
    ],
    echo: ["function handle(req) { send(answer(req)); }"],
    silent: ["function handle(req) { /* never answers */ }"],
    // Outlives its stdin. A server that exits when its pipes close cannot tell
    // "shutdown ended it" from "the pipe went away and it noticed", and the
    // second proves nothing about shutdown. The timer also bounds this process
    // so a failing run cannot leave it behind.
    stubborn: [
      "function handle(req) { /* never answers */ }",
      "setTimeout(() => process.exit(0), 60000);",
    ],
  };

  writeFileSync(script, [...common, ...handlers[mode]].join(NEWLINE), 'utf8');
  return { script, pidFile };
}

/** The pid the stand-in reported for itself, once it has started. */
async function servingPid(pidFile, budgetMs = 20000) {
  for (let waited = 0; waited < budgetMs; waited += 100) {
    if (existsSync(pidFile)) {
      const written = readFileSync(pidFile, 'utf8').trim();
      if (written) { return Number(written); }
    }
    await settle(100);
  }
  return null;
}

describe('the shared MCP process answers the caller who asked', () => {
  it('gives each concurrent caller its own answer, in whatever order they arrive', async () => {
    // The stand-in answers the second request first. A router that matches ids
    // gets both right; one that takes the first line gets both wrong.
    const layer = new AIStudioLayer();
    const server = standIn('reorder');
    layer.resolveMCPServerPath = () => server.script;

    const first = layer.executeMCPCommandOptimized('analyze_documents', { marker: 'alpha' });
    const second = layer.executeMCPCommandOptimized('analyze_documents', { marker: 'beta' });
    const [a, b] = await Promise.all([first, second]);

    assert.equal(textOf(a), 'answer-for-alpha', 'the first caller was handed the wrong answer');
    assert.equal(textOf(b), 'answer-for-beta', 'the second caller was handed the wrong answer');

    await layer.shutdown?.();
  });

  it('does not reuse an id between two in-flight requests', async () => {
    // Date.now() collides for anything issued inside the same millisecond, and
    // two equal ids cannot be routed apart however good the router is.
    const layer = new AIStudioLayer();
    const ids = new Set();

    for (let i = 0; i < 50; i += 1) {
      ids.add(layer.nextOptimizedRequestId());
    }

    assert.equal(ids.size, 50, 'every in-flight request needs an id of its own');
  });

  it('does not let a replaced process disown its replacement', async () => {
    // The TTL kills the old process and reassigns the field without waiting, so
    // the old exit lands afterwards. A handler that reads the field rather than
    // the process it belongs to deletes the healthy new server and forces a
    // third spawn -- and a router that fails "all waiting requests" fails the
    // ones already sent to the replacement.
    const layer = new AIStudioLayer();
    layer.resolveMCPServerPath = () => standIn('echo').script;

    const first = await layer.executeMCPCommandOptimized('analyze_documents', { marker: 'one' });
    const original = layer.persistentMCPProcess;
    assert.ok(original?.pid, 'the first request must have started a server');

    layer.mcpProcessStartTime = 0;   // age it past its TTL

    const second = await layer.executeMCPCommandOptimized('analyze_documents', { marker: 'two' });
    const replacement = layer.persistentMCPProcess;

    assert.equal(textOf(first), 'answer-for-one');
    assert.equal(textOf(second), 'answer-for-two');
    assert.notEqual(replacement?.pid, original.pid, 'the TTL must have replaced it');

    await settle();   // the old process's exit lands here

    assert.equal(
      layer.persistentMCPProcess, replacement,
      'the dying process disowned its replacement'
    );

    const third = await layer.executeMCPCommandOptimized('analyze_documents', { marker: 'three' });
    assert.equal(textOf(third), 'answer-for-three');
    assert.equal(layer.persistentMCPProcess.pid, replacement.pid, 'no third process may be needed');

    await layer.shutdown?.();
  });
});

describe('the shared MCP process can be ended', () => {
  it('ends a child created while the process was already running', async () => {
    // Nothing ever ended one. It is reused across requests and replaced only on
    // a TTL, so a run that used this path left a node server running with its
    // stdio pipes attached -- and those pipes keep the parent's event loop
    // alive: `cgmb` had nothing left to do and would not exit.
    const layer = new AIStudioLayer();
    const server = standIn('silent');
    layer.resolveMCPServerPath = () => server.script;

    const inFlight = layer.executeMCPCommandOptimized('analyze_documents', { marker: 'late' });
    inFlight.catch(() => {});

    let child;
    for (let waited = 0; waited < 15000 && !child; waited += 100) {
      await settle(100);
      child = layer.persistentMCPProcess;
    }

    assert.ok(child?.pid, 'a server must have started to prove anything');

    // The process that is actually serving, as reported by itself. Measured on
    // Windows: the layer spawned `cmd.exe /d /s /c "node <script>"`, the tracked
    // pid was the shell, and shutdown killed the shell while the node server
    // kept running with the pipes it had inherited. Checking the tracked pid
    // passed throughout.
    const serving = await servingPid(server.pidFile);
    assert.ok(serving, 'the stand-in must have reported its pid');
    assert.equal(isAlive(serving), true, 'and be running when shutdown is asked for');

    await layer.shutdown();
    await settle(1500);

    assert.equal(isAlive(serving), false, 'the server outlived the shutdown that was meant to end it');
  });

  it('ends a server that does not exit when its pipes close', async () => {
    // The Windows spawn used `shell: true`, so the ChildProcess the layer held
    // was cmd.exe and the node server was its child. kill('SIGKILL') ended the
    // shell; the server was left running, reparented, holding the stdio handles
    // it had inherited. Measured: `cmd.exe /d /s /c "node <script>"` at pid A,
    // node at pid B with parent A; after shutdown A was gone and B was not.
    //
    // The previous case does not catch this. Killing the shell closes the pipe,
    // a server whose only reason to stay alive is stdin then exits on its own,
    // and the assertion passes without shutdown having ended anything.
    const layer = new AIStudioLayer();
    const server = standIn('stubborn');
    layer.resolveMCPServerPath = () => server.script;

    const inFlight = layer.executeMCPCommandOptimized('analyze_documents', { marker: 'stubborn' });
    inFlight.catch(() => {});

    const serving = await servingPid(server.pidFile);
    assert.ok(serving, 'the stand-in must have reported its pid');
    assert.equal(isAlive(serving), true, 'and be running when shutdown is asked for');

    await layer.shutdown();
    await settle(2000);

    assert.equal(
      isAlive(serving), false,
      'shutdown ended the process it was holding, not the server that was running'
    );
  });

  it('can be asked to shut down twice without failing', async () => {
    // A signal handler and the ordinary end of a command can both arrive.
    const layer = new AIStudioLayer();

    await layer.shutdown();
    await layer.shutdown();
  });
});
