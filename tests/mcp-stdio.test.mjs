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

/**
 * Start `serve`, send one initialize request, and collect both streams.
 *
 * The server is killed rather than shut down cleanly: it has no exit path that
 * does not involve a signal, and what is under test is what it wrote, not how
 * it stops.
 */
function runServe({ env: overrides = {}, dropNodeEnv = false, args = [] } = {}) {
  return new Promise(resolve => {
    const env = { ...process.env, ...overrides };
    if (dropNodeEnv) { delete env.NODE_ENV; }

    const child = spawn(process.execPath, [CLI, 'serve', ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
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

    setTimeout(() => {
      child.kill('SIGKILL');
      child.on('close', () => resolve({ stdout, stderr }));
      // close may not fire promptly on Windows after SIGKILL.
      setTimeout(() => resolve({ stdout, stderr }), 1500).unref();
    }, 8000);
  });
}

/** Lines on stdout that are not parseable JSON. */
function nonProtocolLines(stdout) {
  return stdout
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
    .filter(line => {
      try {
        JSON.parse(line);
        return false;
      } catch {
        return true;
      }
    });
}

describe('MCP stdio channel', () => {
  it('writes nothing but JSON to stdout, with NODE_ENV unset', async () => {
    // The configuration that used to break it. A registration that omits
    // NODE_ENV is perfectly legal, and this is what it produced.
    const { stdout } = await runServe({ dropNodeEnv: true });

    assert.deepEqual(
      nonProtocolLines(stdout), [],
      'stdout is the JSON-RPC channel; log output there is a parse error for the host'
    );
  });

  it('writes nothing but JSON to stdout under NODE_ENV=production', async () => {
    const { stdout } = await runServe({ env: { NODE_ENV: 'production' } });

    assert.deepEqual(nonProtocolLines(stdout), []);
  });

  it('still reports diagnostics, on stderr', async () => {
    // Suppressing the console transport kept stdout clean but left a
    // misbehaving server silent. Diagnostics belong on stderr, which is where
    // MCP hosts look for them.
    const { stderr } = await runServe({ env: { NODE_ENV: 'production' } });

    assert.ok(
      stderr.trim().length > 0,
      'a server that says nothing anywhere cannot be diagnosed'
    );
  });

  it('honours --debug, which used to print nothing under production', async () => {
    // --debug set LOG_LEVEL but not CGMB_DEBUG, and the console transport was
    // gated on the latter -- so the flag was silently inert exactly where it
    // was needed.
    const plain = await runServe({ env: { NODE_ENV: 'production' } });
    const debug = await runServe({ env: { NODE_ENV: 'production' }, args: ['--debug'] });

    assert.ok(
      debug.stderr.length > plain.stderr.length,
      '--debug must produce more output than a plain run'
    );
    assert.deepEqual(nonProtocolLines(debug.stdout), [], '--debug must not reach stdout either');
  });
});
