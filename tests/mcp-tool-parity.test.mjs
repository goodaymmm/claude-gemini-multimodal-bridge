/**
 * Every MCP tool the AI Studio layer asks for must be one the server has.
 *
 * The layer talks to its own MCP server by name. Nothing checks that the name
 * exists: a request for a tool the server never implemented comes back as
 * `MCP error -32601: Unknown tool: <name>` at runtime, from whichever user
 * action happened to reach it.
 *
 * That is not hypothetical. `generate-audio --script` ran a two-step path whose
 * first step asked for `generate_text`, and the server has never had one, so the
 * option failed on every call it ever received -- through 1.2.0 and every
 * release before it. It was removed in 1.2.1.
 *
 * Four more names were in the same state at that point: analyze_audio_advanced,
 * convert_file, convert_pdf and transcribe_audio. None could be reached from the
 * CLI or from any MCP tool, so nobody hit them -- but neither could
 * generate_text, until `--script` was added and gave it an entrance. Being
 * unreachable is a property of today's callers, not of the code.
 *
 * So the rule is about the pair, not about reachability: if the layer can name
 * a tool, the server has to have it.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SERVER = join(ROOT, 'dist', 'mcp-servers', 'ai-studio-mcp-server.js');
const LAYER = join(ROOT, 'dist', 'layers', 'AIStudioLayer.js');

const NEWLINE = String.fromCharCode(10);

const isLetter = ch => (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
const isBlank = ch => ch === ' ' || ch.trim() === '';

/**
 * The tool names the layer can ask for.
 *
 * Read out of the built layer by scanning, not by regular expression: a single
 * backslash in a pattern is an escape, `[\/]` matches only "/", and the result
 * is a search that quietly finds less than it looks like it does. That has cost
 * this codebase several hours, so string work here is done by hand.
 *
 * Returns the literal names, and separately the call sites whose first argument
 * is not a literal -- those cannot be checked and must not pass unnoticed.
 */
function toolsTheLayerAsksFor(source) {
  const marker = 'executeMCPCommand';
  const names = new Set();
  const unreadable = [];

  let at = 0;
  for (;;) {
    const found = source.indexOf(marker, at);
    if (found < 0) { break; }
    at = found + marker.length;

    // Step over a suffix such as "Optimized", then whitespace, then "(".
    let i = at;
    while (i < source.length && isLetter(source[i])) { i += 1; }
    while (i < source.length && isBlank(source[i])) { i += 1; }
    if (source[i] !== '(') { continue; }
    i += 1;
    while (i < source.length && isBlank(source[i])) { i += 1; }

    const quote = source[i];
    if (quote !== "'" && quote !== '"' && quote !== '`') {
      // The method's own declaration reads `executeMCPCommand(command, params)`.
      // Anything else here is a call whose tool name is computed, which this
      // check cannot follow.
      const argument = source.slice(i, source.indexOf(')', i));
      if (!argument.startsWith('command')) {
        unreadable.push(source.slice(Math.max(0, found - 40), i + 40));
      }
      continue;
    }

    const end = source.indexOf(quote, i + 1);
    if (end > 0) { names.add(source.slice(i + 1, end)); }
  }

  return { names, unreadable };
}

/** The tool names the server answers `tools/list` with. */
function toolsTheServerHas() {
  return new Promise((resolve, reject) => {
    // tools/list does not call Google, so the key only has to exist. The server
    // refuses to construct without one.
    const child = spawn(process.execPath, [SERVER], {
      cwd: ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, AI_STUDIO_API_KEY: 'test-key-not-used' },
      windowsHide: true,
    });

    let buffered = '';
    let stderr = '';
    const done = (error, value) => {
      clearTimeout(timer);
      child.kill('SIGKILL');
      error ? reject(error) : resolve(value);
    };

    const timer = setTimeout(
      () => done(new Error(`the server did not answer tools/list. stderr:${NEWLINE}${stderr.slice(-800)}`)),
      60000
    );

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => done(error));

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffered += chunk;
      for (;;) {
        const brk = buffered.indexOf(NEWLINE);
        if (brk < 0) { break; }
        const line = buffered.slice(0, brk).trim();
        buffered = buffered.slice(brk + 1);
        if (!line) { continue; }

        let message;
        try { message = JSON.parse(line); } catch { continue; }

        if (message.id === 1) {
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + NEWLINE);
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + NEWLINE);
        } else if (message.id === 2) {
          const listed = message.result?.tools ?? [];
          done(null, new Set(listed.map(tool => tool.name)));
        }
      }
    });

    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'parity', version: '1' } },
    }) + NEWLINE);
  });
}

describe('the layer and its MCP server agree on what exists', () => {
  it('asks only for tools the server implements', async () => {
    const { names, unreadable } = toolsTheLayerAsksFor(readFileSync(LAYER, 'utf8'));

    assert.deepEqual(
      unreadable, [],
      `these call sites name their tool at runtime, so this check cannot cover them:${NEWLINE}${unreadable.join(NEWLINE)}`
    );
    assert.ok(names.size > 0, 'the scan found no tool names at all -- it is not looking at what it thinks it is');

    const implemented = await toolsTheServerHas();
    assert.ok(implemented.size > 0, 'the server listed no tools');

    const missing = [...names].filter(name => !implemented.has(name)).sort();

    assert.deepEqual(
      missing, [],
      `the layer asks for tools the server does not have, so these fail with -32601 ` +
      `wherever they can be reached:${NEWLINE}  ${missing.join(NEWLINE + '  ')}${NEWLINE}` +
      `server implements: ${[...implemented].sort().join(', ')}`
    );
  });
});
