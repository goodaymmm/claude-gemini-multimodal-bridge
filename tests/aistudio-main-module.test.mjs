/**
 * The AI Studio sub-server starts only when it is the script node was run with.
 *
 * isMainModule() used to answer true when process.argv[1] was missing (node -e,
 * a REPL, a script piped on stdin) or when the comparison threw. Importing the
 * module there -- LayerManager imports it for assertReadableRoot -- started a
 * stdio MCP server inside the importing process, reading its stdin and writing
 * JSON-RPC to its stdout, and kept that process alive.
 *
 * Each case runs in a child with stdin left open, as a real host would have it:
 * a server listening on stdin keeps the child alive, so "exits on its own" is
 * the observable proof that none started.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { isMainModule } from '../dist/mcp-servers/ai-studio-mcp-server.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(ROOT, 'dist', 'mcp-servers', 'ai-studio-mcp-server.js');
const SERVER_URL = pathToFileURL(SERVER).href;
const RUNNING = 'AI Studio MCP Server running on stdio';

const scratch = mkdtempSync(join(tmpdir(), 'cgmb-mainmod-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

/**
 * Run node with `args`, stdin open, until it exits, `ms` passes, or its stderr
 * matches `until`. Resolves with what it printed and whether it exited by itself.
 */
function run(args, ms, until) {
  return new Promise(resolve => {
    const env = { ...process.env, AI_STUDIO_API_KEY: 'AIzaFakeKeyForTestsOnly000000000' };
    for (const key of ['NODE_TEST_CONTEXT', 'LOG_FILE', 'CGMB_DEBUG']) {
      delete env[key];
    }
    const child = spawn(process.execPath, args, { cwd: scratch, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => {
      stderr += chunk;
      if (until?.test(stderr)) { child.kill('SIGKILL'); }
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), ms);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, exitedAlone: signal === null, stdout, stderr });
    });
  });
}

const IMPORT_AND_REPORT =
  `const m = await import(${JSON.stringify(SERVER_URL)});` +
  `process.stdout.write(JSON.stringify({ exported: typeof m.AIStudioMCPServer }) + '\\n');`;

describe('isMainModule()', () => {
  it('is false when node has no script path (node -e, REPL, stdin)', () => {
    assert.equal(isMainModule(SERVER_URL, undefined), false);
    assert.equal(isMainModule(SERVER_URL, ''), false);
  });

  it('is false for a path that does not exist, instead of guessing true', () => {
    assert.equal(isMainModule(SERVER_URL, join(scratch, 'missing.js')), false);
    assert.equal(isMainModule('not a file URL', SERVER), false);
  });

  it('is false for a different script, true for this one and for a symlink to it', () => {
    assert.equal(isMainModule(SERVER_URL, join(ROOT, 'dist', 'cli.js')), false);
    assert.equal(isMainModule(SERVER_URL, SERVER), true);

    const link = join(scratch, 'linked-server.js');
    try {
      symlinkSync(SERVER, link);
    } catch {
      return; // No symlink permission (Windows without developer mode).
    }
    assert.equal(isMainModule(SERVER_URL, link), true);
  });
});

describe('importing the AI Studio sub-server', () => {
  it('from node -e does not start a server', async () => {
    const r = await run(['--input-type=module', '-e', IMPORT_AND_REPORT], 15000);

    assert.ok(r.exitedAlone, `the importing process was kept alive by a server:\n${r.stderr.slice(-1500)}`);
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stderr, new RegExp(RUNNING));
    assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').pop()), { exported: 'function' });
  });

  it('from another script does not start a server', async () => {
    const script = join(scratch, 'importer.mjs');
    writeFileSync(script, IMPORT_AND_REPORT);
    const r = await run([script], 15000);

    assert.ok(r.exitedAlone, `the importing process was kept alive by a server:\n${r.stderr.slice(-1500)}`);
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stderr, new RegExp(RUNNING));
  });

  it('run directly, it still starts', async () => {
    // The positive case, so the two above cannot pass just because the
    // server never starts at all.
    const r = await run([SERVER], 20000, new RegExp(RUNNING));

    assert.equal(r.exitedAlone, false, `the server exited by itself:\n${r.stderr.slice(-1500)}`);
    assert.match(r.stderr, new RegExp(RUNNING));
  });
});
