/**
 * What the CLI tells people it can do.
 *
 * `generate-audio` advertised `--script`, "Generate script first then convert
 * to audio". It never worked. The first step called an MCP tool named
 * generate_text, and the AI Studio MCP server has never implemented one -- it
 * exposes generate_image, analyze_image, multimodal_process, analyze_documents,
 * get_generated_file, list_generated_files, get_file_info and generate_audio.
 * Measured against 1.2.0 and against this branch: `MCP error -32601: Unknown
 * tool: generate_text`, every time.
 *
 * It appeared in --help and nowhere else: no README entry in either language,
 * nothing in docs/, no MCP tool. So the only thing it did was promise a feature
 * that did not exist and fail when taken up on it.
 *
 * This file holds the CLI to what it actually does. It is about the advertised
 * surface, not about the code behind it: an option offered in --help has to be
 * one the program can carry out.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'dist', 'cli.js');

/** Run the CLI and return what the user would see. */
function cgmb(...args) {
  // NODE_TEST_CONTEXT tells a child it is a test worker, which changes what it
  // prints. The CLI is not one.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;

  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: join(HERE, '..'),
    env,
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true,
  });

  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

describe('the CLI offers only what it can do', () => {
  it('does not advertise the script option on generate-audio', () => {
    const { output } = cgmb('generate-audio', '--help');

    assert.ok(
      output.includes('generate-audio'),
      `--help did not describe the command:\n${output.slice(0, 400)}`
    );
    assert.ok(
      !output.includes('--script'),
      `--script is offered but cannot be carried out:\n${output}`
    );
  });

  it('refuses the script option rather than failing partway through', () => {
    // Before, this reached AI Studio, started an MCP server, sent a request for
    // a tool that does not exist and reported a protocol error -- after the
    // user had waited. An option the program does not have should be rejected
    // by the argument parser, at once.
    const { status, output } = cgmb('generate-audio', 'anything', '--script');

    assert.notEqual(status, 0, 'an option that does not exist must not succeed');
    assert.match(
      output, /unknown option/i,
      `the parser should reject it outright, not fail later:\n${output.slice(0, 600)}`
    );
  });

  it('still offers the audio generation that works', () => {
    // The plain path uses generate_audio, which the server does implement, and
    // was measured producing a wav. Removing the broken option must not take it.
    const { output } = cgmb('generate-audio', '--help');

    assert.match(output, /--voice/, 'the voice option belongs to the working path');
    assert.match(output, /--output/, 'and so does the output path');
  });
});

/**
 * Words the command does not take are refused, not dropped.
 *
 * Up to commander 12, extra command-arguments were accepted and ignored, so
 * `cgmb generate-image a red fox` (unquoted) generated an image of "a" and
 * said nothing about "red fox". Commander 13 made excess arguments an error by
 * default; CGMB keeps that default rather than opting back into the old
 * behaviour, because a silently truncated prompt costs a paid API call and
 * produces the wrong thing.
 */
describe('the CLI refuses arguments it would otherwise drop', () => {
  it('rejects an unquoted multi-word prompt for generate-image before calling anything', () => {
    const { status, output } = cgmb('generate-image', 'a', 'red', 'fox');

    assert.notEqual(status, 0, 'a prompt that would be truncated must not succeed');
    assert.match(
      output, /too many arguments/i,
      `the parser should reject it outright, not generate an image of "a":\n${output.slice(0, 600)}`
    );
  });

  it('rejects arguments to a command that takes none', () => {
    const { status, output } = cgmb('info', 'extra');

    assert.notEqual(status, 0);
    assert.match(output, /too many arguments/i, output.slice(0, 600));
  });
});
