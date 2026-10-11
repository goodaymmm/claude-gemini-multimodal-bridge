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
const SEP = String.fromCharCode(92);
const NEWLINE = String.fromCharCode(10);
/** Any model from the shut-down 2.0 generation, in a string literal. */
const RETIRED_2_0 = /['"`](gemini-2[.]0-[a-z0-9.-]*)['"`]/g;
/**
 * Any model from the 2.5 generation, in a string literal. Since 2026-09-18
 * Google serves 2.5 only to accounts that already used it, so a fresh key is
 * refused. The match ends at the closing quote, so it also catches a 2.5 ID
 * embedded in a longer string such as a help text.
 */
const RESTRICTED_2_5 = /['"`][^'"`]*?(gemini-2[.]5-[a-z0-9.-]*)/g;

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

  it('names nothing a new API key cannot reach', () => {
    // Gemini 2.5 is limited to existing users since 2026-09-18, and
    // gemini-3-pro-preview was shut down on 2026-03-09 (the ID survives only as
    // an alias). A default on either works for some users and fails for every
    // new install, which is the case that matters most.
    for (const [key, value] of Object.entries(AI_MODELS)) {
      assert.doesNotMatch(value, /^gemini-2\.5-/, `${key} = ${value} is restricted to existing users`);
      assert.notEqual(value, 'gemini-3-pro-preview', `${key} = ${value} was shut down`);
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
    // No escapes anywhere in this check. A backslash written into a generated
    // string or regex has been lost five times in this work; here it turned
    // `^\s*` into `^s*` and the pattern into a SyntaxError, so the case
    // failed without ever looking at a model name -- a red that proved nothing,
    // which is the same problem as a green that proves nothing.
    const offenders = [];
    const isComment = line => {
      const t = line.trimStart();
      return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
    };

    for (const file of sourceFiles()) {
      const relative = file.split(SEP).join('/').replace(/.*\/src\//, 'src/');

      readFileSync(file, 'utf8').split(NEWLINE).forEach((line, index) => {
        // A comment explaining the removal is fine; a string literal is not.
        if (isComment(line)) { return; }

        for (const match of line.matchAll(RETIRED_2_0)) {
          offenders.push(`${relative}:${index + 1}  ${match[1]}`);
        }
      });
    }

    assert.deepEqual(
      offenders, [],
      `a shut-down generation cannot answer; these calls always fail:\n${offenders.join('\n')}`
    );
  });

  it('names no model from the access-restricted 2.5 generation', () => {
    // Same rule as the 2.0 check above. gemini-2.5-flash was hardcoded at a
    // dozen call sites -- including the auth probe, which would have reported
    // a brand-new, valid key as broken. Every model goes through AI_MODELS.
    // No escapes in this check, for the reason given above.
    const offenders = [];
    const isComment = line => {
      const t = line.trimStart();
      return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
    };

    for (const file of sourceFiles()) {
      const relative = file.split(SEP).join('/').replace(/.*\/src\//, 'src/');

      readFileSync(file, 'utf8').split(NEWLINE).forEach((line, index) => {
        if (isComment(line)) { return; }

        for (const match of line.matchAll(RESTRICTED_2_5)) {
          offenders.push(`${relative}:${index + 1}  ${match[1]}`);
        }
      });
    }

    assert.deepEqual(
      offenders, [],
      `a new API key is refused for 2.5; use AI_MODELS instead:\n${offenders.join('\n')}`
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
