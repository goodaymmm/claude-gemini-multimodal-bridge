/**
 * Telling CGMB where Claude Code is.
 *
 * .env.example has advertised CLAUDE_CODE_PATH since before this branch, and
 * ConfigSchema carries claude.code_path with a 'claude' default that
 * CGMBServer fills from that same variable -- but claudeCandidatePaths was a
 * fixed literal list and every `new ClaudeCodeLayer()` call passed no
 * arguments, so neither reached the search. An install outside the six
 * hardcoded locations could not be used, however it was declared.
 *
 * The order of the candidate list is the entire mechanism, so that is what
 * these check -- plus the thing that must NOT change: naming a path is a
 * preference, not an exemption from the trust check.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ClaudeCodeLayer } from '../dist/layers/ClaudeCodeLayer.js';
import { buildSpawnTarget } from '../dist/utils/processUtils.js';

const paths = (env = {}, configured) =>
  ClaudeCodeLayer.claudeCandidatePaths('linux', env, configured);

describe('where CGMB looks for Claude Code', () => {
  it('tries CLAUDE_CODE_PATH before anything else', () => {
    const found = paths({ CLAUDE_CODE_PATH: '/opt/custom/claude' });

    assert.equal(found[0], '/opt/custom/claude');
    assert.ok(found.includes('claude'), 'the defaults must still follow as fallbacks');
  });

  it('lets an explicit config path win over the environment', () => {
    // Precedence is constructor argument > CLAUDE_CODE_PATH > defaults: a
    // config the caller passed in is more specific than an inherited variable.
    const found = paths({ CLAUDE_CODE_PATH: '/from/env/claude' }, '/from/config/claude');

    assert.deepEqual(found.slice(0, 2), ['/from/config/claude', '/from/env/claude']);
  });

  it('ignores a blank or whitespace-only setting', () => {
    // An unset variable in a .env file reads as '', which must not become a
    // candidate -- searching for a file named '' wastes a spawn per attempt
    // and, worse, reads as a configured path that mysteriously does not work.
    for (const blank of ['', '   ', '\t']) {
      assert.deepEqual(paths({ CLAUDE_CODE_PATH: blank }), paths({}));
      assert.deepEqual(paths({}, blank), paths({}));
    }
  });

  it('leaves the default list alone when nothing is configured', () => {
    assert.deepEqual(paths({}), [
      'claude',
      'claude-original',
      '/usr/local/bin/claude',
      '/usr/local/bin/claude-original',
      '/opt/homebrew/bin/claude',
      '/opt/homebrew/bin/claude-original',
    ]);
  });

  it('does not list a path twice when config and env agree', () => {
    const found = paths({ CLAUDE_CODE_PATH: '/usr/local/bin/claude' }, '/usr/local/bin/claude');

    assert.equal(found.filter(p => p === '/usr/local/bin/claude').length, 1);
    assert.equal(found[0], '/usr/local/bin/claude');
  });

  it('still puts the Windows npm location on the list', () => {
    const found = ClaudeCodeLayer.claudeCandidatePaths(
      'win32',
      { APPDATA: 'C:\\Users\\x\\AppData\\Roaming', CLAUDE_CODE_PATH: 'D:\\claude.cmd' }
    );

    assert.equal(found[0], 'D:\\claude.cmd');
    assert.ok(found.some(p => p.endsWith('npm\\claude.cmd')), 'defaults must survive');
  });
});

describe('a configured path is a preference, not an exemption', () => {
  // The trust check exists because `where claude` lists the working directory
  // before PATH on Windows, so a claude.cmd dropped in a repo would be picked
  // up and run. Allowing CLAUDE_CODE_PATH to name that same file would reopen
  // exactly the hole -- an attacker who can write a .env can write a .cmd.

  it('refuses a cwd-relative executable however it was named', () => {
    assert.throws(
      () => buildSpawnTarget('./claude.cmd', ['--version']),
      'a relative path under cwd must be rejected'
    );
  });

  it('keeps rejecting it when it arrives through the candidate list', () => {
    const found = paths({ CLAUDE_CODE_PATH: './claude.cmd' });

    // It is offered first -- and then refused, which is the point: ordering
    // changed, the gate did not.
    assert.equal(found[0], './claude.cmd');
    assert.throws(() => buildSpawnTarget(found[0], ['--version']));
  });
});
