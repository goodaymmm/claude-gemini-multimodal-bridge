/**
 * stdout belongs to the protocol.
 *
 * CGMB's main mode is an MCP server speaking JSON-RPC over stdio. One log line
 * on stdout is a parse error for the host, and the logger used to force every
 * level there. The only thing preventing a broken server was the MCP
 * registration happening to carry NODE_ENV=production, which disabled the
 * console transport outright -- so the channel was clean by accident, and the
 * server produced no diagnostics at all while it was.
 *
 * Measured before the fix, with NODE_ENV unset: 86 of 87 stdout lines were log
 * output.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'dist', 'cli.js');

/** How long to wait for the milestone before giving up and letting a test fail. */
const READY_TIMEOUT_MS = 60000;
/** Grace after the milestone for trailing writes on both streams to arrive. */
const SETTLE_MS = 400;

/** The JSON value on a line, or undefined if it is not JSON at all. */
function parseLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/**
 * Is this a JSON-RPC 2.0 frame?
 *
 * Being parseable is not the same as being protocol. The logger emits JSON --
 * `{"level":"info","message":"..."}` is a perfectly good JSON document -- so a
 * check that only asked whether a line parsed accepted exactly the output it
 * exists to reject. Every frame carries jsonrpc "2.0" and is either a request
 * or notification (method) or a response (result or error against an id).
 */
function isProtocolFrame(value) {
  const has = (key) => Object.prototype.hasOwnProperty.call(value, key);

  if (typeof value !== 'object' || value === null || Array.isArray(value)) { return false; }
  if (value.jsonrpc !== '2.0') { return false; }
  if (typeof value.method === 'string') { return true; }

  return has('id') && (has('result') || has('error'));
}

/** Has the server answered the initialize request -- with a response, not just JSON? */
function sawInitializeResponse(stdout) {
  return stdout.split('\n').some(line => {
    const trimmed = line.trim();
    if (trimmed === '') { return false; }
    const frame = parseLine(trimmed);
    return isProtocolFrame(frame)
      && frame.id === 1
      && Object.prototype.hasOwnProperty.call(frame, 'result');
  });
}

/**
 * Start `serve`, send one initialize request, and collect both streams.
 *
 * The server is killed rather than shut down cleanly: it has no exit path that
 * does not involve a signal, and what is under test is what it wrote, not how
 * it stops.
 *
 * Runs stop at a milestone -- by default the initialize response -- rather than
 * after a fixed wall-clock wait. The wait used to be 8 seconds, which failed
 * under WSL whenever a build had just run over /mnt/m and the server needed
 * longer than that to say anything: measured, `npm test` there failed one or
 * two of these while `node --test` on the same tree passed. Worse, the two
 * "stdout is clean" cases passed in that state for the wrong reason, since a
 * server that has written nothing has written nothing bad either. Callers get
 * `ready` so they can insist the milestone was actually reached.
 */
function runServe({
  env: overrides = {},
  dropNodeEnv = false,
  args = [],
  until = stdout => sawInitializeResponse(stdout),
  cli = CLI,
} = {}) {
  return new Promise(resolve => {
    const env = { ...process.env, ...overrides };
    if (dropNodeEnv) { delete env.NODE_ENV; }

    const child = spawn(process.execPath, [cli, 'serve', ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let exit;
    let spawnError;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });

    child.stdin.on('error', () => {});
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'cgmb-stdio-test', version: '1.0.0' },
      },
    })}\n`);

    const startedAt = Date.now();
    let ready = false;
    let poll;
    let done = false;

    // One way out, idempotent, and it always stops the poll.
    //
    // Both the exit handlers below and the post-kill fallback can reach this,
    // and after a milestone the child may exit on its own during the settle
    // window -- so it has to be safe to call more than once.
    const finish = () => {
      if (done) { return; }
      done = true;
      clearInterval(poll);
      resolve({ stdout, stderr, ready, exit, spawnError });
    };

    // Subscribed from the start, not from inside stop().
    //
    // A `serve` that dies before answering -- a bad build, a missing
    // dependency -- would otherwise go unnoticed: `until` never turns true, so
    // the poll ran the full timeout. Five runs in this file, so a broken start
    // cost minutes and the real reason was buried under a CI timeout instead of
    // being reported as "exited with code 1".
    child.on('close', (code, signal) => {
      exit = { code, signal };
      finish();
    });
    child.on('error', error => {
      spawnError = error;
      finish();
    });

    const stop = () => {
      child.kill('SIGKILL');
      // close may not fire promptly on Windows after SIGKILL.
      setTimeout(finish, 1500).unref();
    };

    poll = setInterval(() => {
      if (until(stdout, stderr)) {
        ready = true;
        clearInterval(poll);
        setTimeout(stop, SETTLE_MS);
      } else if (Date.now() - startedAt > READY_TIMEOUT_MS) {
        clearInterval(poll);
        stop();
      }
    }, 50);
  });
}

/** Why a run ended, for an assertion message that names the cause. */
function whyItEnded({ exit, spawnError }) {
  if (spawnError) { return `spawn failed: ${spawnError.message}`; }
  if (exit?.signal) { return `killed by ${exit.signal}`; }
  if (exit?.code != null) { return `exited with code ${exit.code}`; }
  return 'still running at the deadline';
}

/** Lines on stdout that are not JSON-RPC frames. */
function nonProtocolLines(stdout) {
  return stdout
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
    .filter(line => !isProtocolFrame(parseLine(line)));
}

describe('what counts as protocol on stdout', () => {
  it('rejects a JSON log line as firmly as a plain one', () => {
    // The check these cases depend on. It used to ask only whether a line
    // parsed as JSON, and the logger emits JSON: a Winston line on stdout --
    // the exact failure the suite exists to catch -- would have been counted as
    // protocol and the run would have gone green.
    const logLine = JSON.stringify({ level: 'info', message: 'CGMB server started' });
    const noVersion = JSON.stringify({ id: 1, result: {} });
    const wrongVersion = JSON.stringify({ jsonrpc: '1.0', id: 1, result: {} });
    const bare = 'CGMB server started';

    assert.deepEqual(nonProtocolLines([logLine, noVersion, wrongVersion, bare].join('\n')),
      [logLine, noVersion, wrongVersion, bare],
      'only JSON-RPC frames may pass');

    const response = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { capabilities: {} } });
    const failure = JSON.stringify({ jsonrpc: '2.0', id: 2, error: { code: -32601, message: 'x' } });
    const notification = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' });

    assert.deepEqual(nonProtocolLines([response, failure, notification, ''].join('\n')), [],
      'and real frames must not be reported');
  });

  it('accepts only a real initialize response as the milestone', () => {
    // `ready` gates the other cases: if anything with id 1 satisfies it, a run
    // that logged its way to an id can be read as a server that answered.
    const good = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2024-11-05' } });

    assert.equal(sawInitializeResponse(good), true);
    assert.equal(sawInitializeResponse(JSON.stringify({ id: 1, result: {} })), false, 'no jsonrpc field');
    assert.equal(sawInitializeResponse(JSON.stringify({ jsonrpc: '2.0', id: 2, result: {} })), false, 'wrong id');
    assert.equal(
      sawInitializeResponse(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'x' })), false,
      'a request carrying id 1 is not an answer to one'
    );
  });
});

describe('MCP stdio channel', () => {
  it('writes nothing but JSON to stdout, with NODE_ENV unset', async () => {
    // The configuration that used to break it. A registration that omits
    // NODE_ENV is perfectly legal, and this is what it produced.
    const run = await runServe({ dropNodeEnv: true });
    const { stdout, ready } = run;

    // Insisted on first: a server that never answered has a clean stdout too,
    // and this case would then pass without having tested anything.
    assert.ok(ready, `the server must have answered initialize (${whyItEnded(run)})`);
    assert.deepEqual(
      nonProtocolLines(stdout), [],
      'stdout is the JSON-RPC channel; log output there is a parse error for the host'
    );
  });

  it('writes nothing but JSON to stdout under NODE_ENV=production', async () => {
    const run = await runServe({ env: { NODE_ENV: 'production' } });

    assert.ok(run.ready, `the server must have answered initialize (${whyItEnded(run)})`);
    assert.deepEqual(nonProtocolLines(run.stdout), []);
  });

  it('still reports diagnostics, on stderr', async () => {
    // Suppressing the console transport kept stdout clean but left a
    // misbehaving server silent. Diagnostics belong on stderr, which is where
    // MCP hosts look for them.
    const run = await runServe({
      env: { NODE_ENV: 'production' },
      until: (stdout, err) => sawInitializeResponse(stdout) && err.trim().length > 0,
    });
    const { stderr } = run;

    assert.ok(run.ready, `no diagnostics appeared on stderr (${whyItEnded(run)})`);
    assert.ok(
      stderr.trim().length > 0,
      'a server that says nothing anywhere cannot be diagnosed'
    );
  });

  it('honours --debug, which used to print nothing under production', async () => {
    // --debug set LOG_LEVEL but not CGMB_DEBUG, and the console transport was
    // gated on the latter -- so the flag was silently inert exactly where it
    // was needed.
    // Both runs stop at the same milestone -- the initialize response plus the
    // same settle window -- so the comparison is between what the two
    // configurations wrote, not between how long each was allowed to run.
    // Stopping each as soon as its own condition was met would make the sizes
    // a function of timing.
    const plain = await runServe({ env: { NODE_ENV: 'production' } });
    const debug = await runServe({ env: { NODE_ENV: 'production' }, args: ['--debug'] });

    assert.ok(
      plain.ready && debug.ready,
      `both runs must have reached the same point (plain: ${whyItEnded(plain)}, ` +
      `debug: ${whyItEnded(debug)})`
    );
    assert.ok(
      debug.stderr.length > plain.stderr.length,
      '--debug must produce more output than a plain run'
    );
    assert.deepEqual(nonProtocolLines(debug.stdout), [], '--debug must not reach stdout either');
  });
});

describe('a server that never starts', () => {
  // Codex review, P2. The poll waits for a milestone that a dead process will
  // never reach, and `close` was only subscribed inside stop() -- which the
  // poll alone decides to call. So a `serve` that died on startup went
  // unnoticed until the full timeout, five times over in this file. What made
  // that worse than slow is that the reason was then a CI timeout rather than
  // "exited with code 1".

  it('is noticed when it exits, not when the deadline passes', async () => {
    const startedAt = Date.now();
    // A script that does not exist: node exits with MODULE_NOT_FOUND in well
    // under a second, which is a faithful stand-in for a build that cannot run.
    const run = await runServe({ cli: join(HERE, '..', 'dist', 'no-such-entry.js') });
    const elapsed = Date.now() - startedAt;

    assert.equal(run.ready, false, 'it cannot have reached the milestone');
    assert.ok(run.exit || run.spawnError, 'the exit must have been observed');
    // The assertion that would fail without the fix: waiting out the timeout
    // still ends with ready === false, just minutes later.
    assert.ok(
      elapsed < READY_TIMEOUT_MS / 2,
      `must resolve on exit, not on the deadline -- took ${elapsed}ms`
    );
  });

  it('says why, so the failure is not just a timeout', () => {
    assert.match(whyItEnded({ exit: { code: 1, signal: null } }), /code 1/);
    assert.match(whyItEnded({ spawnError: new Error('ENOENT') }), /spawn failed: ENOENT/);
    assert.match(whyItEnded({}), /still running/);
  });
});
