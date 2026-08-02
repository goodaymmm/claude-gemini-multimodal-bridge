/**
 * Model IDs the AI Studio layer sends to Google.
 *
 * A plausible-looking ID is not the same as an existing one. `gemini-2.0-flash-exp`
 * was the hardcoded default for image and multimodal analysis at six call sites,
 * long after Google shut the 2.0 Flash line down -- it is absent from the live
 * catalogue, so every call that fell back to the default would have been
 * rejected. Nothing caught it because nothing checked.
 *
 * These are static checks: asking the live catalogue would need a billed API key
 * and network, which does not belong in a unit test. What can be pinned here is
 * that no shut-down generation is used as a default and that every constant is
 * shaped like a model ID. Existence against the catalogue is verified by hand
 * with GET /v1beta/models when a value changes.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { AI_MODELS } from '../dist/core/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src');

/** Every .ts file under src/. */
function sourceFiles(dir = SRC, found = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, found);
    } else if (entry.endsWith('.ts')) {
      found.push(full);
    }
  }
  return found;
}

describe('AI Studio model constants', () => {
  it('names no shut-down generation', () => {
    // Google lists Gemini 2.0 Flash and 2.0 Flash-Lite as shut down. A default
    // pointing at one is a request that cannot succeed.
    for (const [key, value] of Object.entries(AI_MODELS)) {
      assert.doesNotMatch(
        value, /^gemini-2\.0-/,
        `${key} = ${value} is from a shut-down generation`
      );
    }
  });

  it('gives every constant the shape of a model ID', () => {
    for (const [key, value] of Object.entries(AI_MODELS)) {
      assert.equal(typeof value, 'string', `${key} must be a string`);
      assert.match(value, /^gemini-[0-9]/, `${key} = ${value} does not look like a model ID`);
      assert.doesNotMatch(value, /\s/, `${key} = ${value} contains whitespace`);
    }
  });

  it('covers the four things the layer actually does', () => {
    // Each of these is read by a specific call path; a missing key would send
    // `undefined` as the model name.
    for (const key of [
      'IMAGE_GENERATION',
      'AUDIO_GENERATION',
      'DOCUMENT_PROCESSING',
      'MULTIMODAL_ANALYSIS',
    ]) {
      assert.ok(AI_MODELS[key], `AI_MODELS.${key} must be set`);
    }
  });
});

describe('no source file hardcodes a retired model', () => {
  it('names no model from the shut-down 2.0 generation at all', () => {
    // The -exp check below was too narrow. A plain `gemini-2.0-flash` sat in
    // the TTS script step, and Google has shut that whole generation down --
    // so audio generation failed at its first step, every time. Any 2.0 model
    // is a request that cannot succeed, whatever the suffix.
    const offenders = [];
    const COMMENT = new RegExp('^\s*(//|\*|/\*)');
    const LITERAL = /['"`](gemini-2\.0-[a-z0-9.-]*)['"`]/g;

    for (const file of sourceFiles()) {
      const relative = file.replace(/.*[\/]src[\/]/, 'src/');

      readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
        // A comment explaining the removal is fine; a string literal is not.
        if (COMMENT.test(line)) { return; }

        for (const match of line.matchAll(LITERAL)) {
          offenders.push(`${relative}:${index + 1}  ${match[1]}`);
        }
      });
    }

    assert.deepEqual(
      offenders, [],
      `a shut-down generation cannot answer; these calls always fail:\n${offenders.join('\n')}`
    );
  });


  it('has removed every gemini-2.0-flash-exp literal', () => {
    const offenders = [];

    for (const file of sourceFiles()) {
      const text = readFileSync(file, 'utf8');
      // Comments explaining the removal are fine; a string literal is not.
      for (const line of text.split('\n')) {
        if (!line.includes('gemini-2.0-flash-exp')) { continue; }
        const isComment = /^\s*(\/\/|\*|\/\*)/.test(line);
        if (!isComment) {
          offenders.push(`${file.replace(/.*[\\/]src[\\/]/, 'src/')}: ${line.trim().slice(0, 80)}`);
        }
      }
    }

    assert.deepEqual(offenders, [], `retired model still used:\n${offenders.join('\n')}`);
  });
});
