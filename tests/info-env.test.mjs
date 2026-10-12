/**
 * `cgmb info`, the credential check behind it, and `--debug`.
 *
 * The check counted GEMINI_API_KEY, GOOGLE_AI_STUDIO_API_KEY or CLAUDE_API_KEY
 * as "configured" and never looked at AI_STUDIO_API_KEY -- the name the README
 * tells people to use. Set alone, it reported "Not loaded properly"; set
 * alongside CLAUDE_API_KEY, which nothing in CGMB reads, it passed. The listing
 * showed the retired GEMINI_CLI_PATH and not ANTIGRAVITY_CLI_PATH.
 *
 * `--debug` set LOG_LEVEL inside the command's action, after the logger had
 * been built at import time with the old level. It changed nothing.
 *
 * Everything runs the real CLI in a scratch directory, so the repository's own
 * .env is not found and only the variables given here are present.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'dist', 'cli.js');

const CLEARED = [
  'NODE_TEST_CONTEXT', 'AI_STUDIO_API_KEY', 'GOOGLE_AI_STUDIO_API_KEY', 'GEMINI_API_KEY',
  'CLAUDE_API_KEY', 'ANTIGRAVITY_CLI_PATH', 'CLAUDE_CODE_PATH', 'GEMINI_CLI_PATH',
  'CGMB_ENV_PATH', 'CGMB_DEBUG', 'LOG_LEVEL', 'NODE_ENV', 'CGMB_CLI_MODE',
];

const strip = (text) => text.replace(/\x1b\[[0-9;]*m/g, '');

let cwd;
before(() => {
  cwd = mkdtempSync(join(tmpdir(), 'cgmb-info-'));
});
after(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function cgmb(args, extraEnv = {}) {
  const env = { ...process.env };
  for (const name of CLEARED) {
    delete env[name];
  }
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    env: { ...env, ...extraEnv },
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true,
  });
  return { status: result.status, stdout: strip(result.stdout ?? ''), stderr: strip(result.stderr ?? '') };
}

describe('cgmb info', () => {
  it('counts AI_STUDIO_API_KEY on its own as configured, and masks it', () => {
    const key = 'AIzaTEST-0123456789-abcdefghij';
    const { status, stdout } = cgmb(['info'], { AI_STUDIO_API_KEY: key });

    assert.equal(status, 0, stdout);
    assert.match(stdout, /Environment: Loaded successfully/);
    assert.match(stdout, /Source: environment variables/);
    assert.match(stdout, /✅ AI_STUDIO_API_KEY: AIzaTEST\.\.\.ghij/);
    assert.ok(!stdout.includes(key), 'the full key must not be printed');
  });

  it('accepts the deprecated aliases AuthVerifier still reads', () => {
    for (const name of ['GOOGLE_AI_STUDIO_API_KEY', 'GEMINI_API_KEY']) {
      const { stdout } = cgmb(['info'], { [name]: 'AIzaALIAS-0123456789' });
      assert.match(stdout, /Environment: Loaded successfully/, name);
      assert.match(stdout, new RegExp(`✅ ${name}:`), name);
    }
  });

  it('does not count CLAUDE_API_KEY, which nothing reads', () => {
    const { stdout } = cgmb(['info'], { CLAUDE_API_KEY: 'sk-ant-unused' });

    assert.match(stdout, /Environment: Not loaded properly/);
    assert.ok(!stdout.includes('CLAUDE_API_KEY'), stdout);
  });

  it('shows the current path variables and not the retired one', () => {
    const { stdout } = cgmb(['info'], {
      ANTIGRAVITY_CLI_PATH: '/opt/agy/bin/agy',
      CLAUDE_CODE_PATH: '/opt/claude/bin/claude',
      GEMINI_CLI_PATH: '/opt/gemini/bin/gemini',
    });

    assert.match(stdout, /✅ ANTIGRAVITY_CLI_PATH: \/opt\/agy\/bin\/agy/);
    assert.match(stdout, /✅ CLAUDE_CODE_PATH: \/opt\/claude\/bin\/claude/);
    assert.ok(!stdout.includes('GEMINI_CLI_PATH'), `the retired variable is still listed:\n${stdout}`);
  });
});

describe('--debug reaches the logger', () => {
  const debugLine = /\[debug\]|"level":"debug"/;

  it('cgmb info --debug writes a debug line to stderr', () => {
    const { status, stdout, stderr } = cgmb(['info', '--debug']);

    assert.equal(status, 0, stderr);
    assert.match(stderr, debugLine, `no debug output:\n${stderr}`);
    assert.doesNotMatch(stdout, debugLine, 'logging must not reach stdout');
  });

  it('works before the command name too', () => {
    const { stderr } = cgmb(['--debug', 'info']);
    assert.match(stderr, debugLine);
  });

  it('plain cgmb info writes no debug line', () => {
    const { status, stderr } = cgmb(['info']);

    assert.equal(status, 0, stderr);
    assert.doesNotMatch(stderr, debugLine, stderr);
  });

  it('is offered in every command\'s help', () => {
    const { stdout } = cgmb(['info', '--help']);
    assert.match(stdout, /--debug/);
  });
});
