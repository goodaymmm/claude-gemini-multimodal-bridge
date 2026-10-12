/**
 * AIStudioLayer must leave the process's console alone.
 *
 * Its constructor used to replace console.log and console.debug with wrappers
 * ("ghost log detection") that raised an error-level log line and a
 * console.trace whenever the output contained "AI Studio", "API", "using",
 * "direct" or "integration" -- words the CLI prints all the time. The wrappers
 * stacked once per instance, so two layers meant two errors and two stack
 * traces for one ordinary line of output, and the error line copied the whole
 * message, user input included, into LOG_FILE.
 *
 * Run in a child process so its stderr can be read in full, untouched by the
 * test runner's own output.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LAYER_URL = pathToFileURL(join(ROOT, 'dist', 'layers', 'AIStudioLayer.js')).href;
const MARK = 'CONSOLE-CHECK ';

const SCRIPT = `
const originalLog = console.log;
const originalDebug = console.debug;
const { AIStudioLayer } = await import(${JSON.stringify(LAYER_URL)});
new AIStudioLayer();
new AIStudioLayer();
console.log('AI Studio ready');
console.debug('using direct API integration');
process.stdout.write('\\n' + ${JSON.stringify(MARK)} + JSON.stringify({
  logUntouched: console.log === originalLog,
  debugUntouched: console.debug === originalDebug,
}) + '\\n');
`;

function runChild() {
  const env = { ...process.env, AI_STUDIO_API_KEY: 'AIzaFakeKeyForTestsOnly000000000', LOG_LEVEL: 'debug' };
  for (const key of ['NODE_TEST_CONTEXT', 'LOG_FILE', 'CGMB_CLI_MODE', 'CGMB_DEBUG']) {
    delete env[key];
  }
  return spawnSync(process.execPath, ['--input-type=module', '-e', SCRIPT], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 30000,
  });
}

describe('AIStudioLayer and the console', () => {
  it('two instances leave console.log and console.debug as they were', () => {
    const child = runChild();
    assert.equal(child.status, 0, `child failed:\n${child.stderr}`);

    const line = child.stdout.split('\n').find(l => l.startsWith(MARK));
    assert.ok(line, `no result line in stdout:\n${child.stdout}`);
    assert.deepEqual(JSON.parse(line.slice(MARK.length)), { logUntouched: true, debugUntouched: true });

    // The line itself still reaches stdout, once.
    assert.equal(child.stdout.split('\n').filter(l => l === 'AI Studio ready').length, 1);
  });

  it('an ordinary line mentioning AI Studio produces no error and no stack trace', () => {
    const child = runChild();
    assert.equal(child.status, 0, `child failed:\n${child.stderr}`);

    assert.doesNotMatch(child.stderr, /GHOST/i, 'no ghost-log detection may run');
    assert.doesNotMatch(child.stderr, /^Trace:/m, 'no console.trace may be printed');
    // Text format prints [error]; JSON format prints "level":"error".
    assert.doesNotMatch(child.stderr, /\[error\]|"level":"error"/, `unexpected error-level log:\n${child.stderr}`);
  });
});
