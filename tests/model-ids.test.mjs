/**
 * Model IDs this project sends, checked against a catalogue rather than a shape.
 *
 * A plausible-looking ID is not the same as an existing one. `gemini-2.0-flash-exp`
 * was the hardcoded default for image and multimodal analysis at six call sites,
 * long after Google shut the 2.0 Flash line down -- every call that fell back to
 * the default would have been rejected, and nothing caught it because nothing
 * checked.
 *
 * The first version of this file then checked for that one literal and for a
 * `^gemini-[0-9]` shape. Both are satisfied by any invented ID, and a plain
 * `gemini-2.0-flash` -- the same shut-down generation -- sat in the TTS script
 * step untouched by either. Membership of a dated catalogue is the check that
 * would have caught it, so that is what this does now:
 * tests/fixtures/model-catalogue.json lists what has been verified to exist,
 * against which service, and when.
 *
 * Still a snapshot, not a live lookup: asking the real catalogue needs a billed
 * key and network. What it buys is that a new or changed ID cannot reach a call
 * site without someone verifying it and dating the entry.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { AI_MODELS, ANTIGRAVITY_MODELS, DEFAULT_ANTIGRAVITY_MODEL } from '../dist/core/types.js';



const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src');

const CATALOGUE = JSON.parse(readFileSync(join(HERE, 'fixtures', 'model-catalogue.json'), 'utf8'));
const KNOWN = new Set([...CATALOGUE.aistudio, ...CATALOGUE.antigravity]);
const RETIRED = CATALOGUE.retired;

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
  it('names only models the catalogue says exist', () => {
    // The check the shape regex could not make: `gemini-9.9-turbo` matches
    // ^gemini-[0-9] perfectly and does not exist.
    for (const [key, value] of Object.entries(AI_MODELS)) {
      assert.equal(typeof value, 'string', `${key} must be a string`);
      assert.ok(
        CATALOGUE.aistudio.includes(value),
        `AI_MODELS.${key} = ${value} is not in the verified AI Studio catalogue. `
        + 'Confirm it with GET /v1beta/models, then add it to '
        + 'tests/fixtures/model-catalogue.json with the date.'
      );
    }
  });

  it('names nothing that has been retired', () => {
    for (const [key, value] of Object.entries(AI_MODELS)) {
      assert.equal(
        RETIRED[value], undefined,
        `AI_MODELS.${key} = ${value} is retired: ${RETIRED[value]}`
      );
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

describe('Antigravity CLI model constants', () => {
  it('lists only models agy was seen to serve', () => {
    // A different catalogue from AI Studio's, and the only authority for it is
    // the live output of `agy models`. Guessing here produces a CLI call that
    // fails at the far end with an unhelpful message.
    for (const value of ANTIGRAVITY_MODELS) {
      if (!value.startsWith('gemini-')) { continue; } // agy also serves other vendors
      assert.ok(
        CATALOGUE.antigravity.includes(value),
        `${value} is not in the verified agy catalogue -- check \`agy models\``
      );
    }
  });

  it('defaults to one of them', () => {
    assert.ok(
      ANTIGRAVITY_MODELS.includes(DEFAULT_ANTIGRAVITY_MODEL),
      `the default ${DEFAULT_ANTIGRAVITY_MODEL} is not a model agy serves`
    );
  });
});

describe('every model literal at a call site', () => {
  it('is a model that has been verified to exist', () => {
    // The constants above are only half of it: a literal typed inline at a call
    // site bypasses them entirely, which is how a shut-down gemini-2.0-flash
    // stayed in the TTS script step while AI_MODELS was clean.
    const offenders = [];

    for (const file of sourceFiles()) {
      const relative = file.replace(/.*[\\\\/]src[\\\\/]/, 'src/');
      const text = readFileSync(file, 'utf8');

      text.split('\n').forEach((line, index) => {
        // A comment naming a retired model is how the removal is explained.
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) { return; }

        // Anchored on a version digit: every real ID carries one, and
          // `gemini-first` -- a --strategy value in cli.ts -- does not.
          for (const match of line.matchAll(/['"`](gemini-[0-9][a-z0-9.-]*)['"`]/g)) {
          const id = match[1];
          const why = RETIRED[id];

          if (why) {
            offenders.push(`${relative}:${index + 1}  ${id} -- retired: ${why}`);
          } else if (!KNOWN.has(id)) {
            offenders.push(`${relative}:${index + 1}  ${id} -- not in the verified catalogue`);
          }
        }
      });
    }

    assert.deepEqual(
      offenders, [],
      'model IDs must be verified and listed in tests/fixtures/model-catalogue.json:\n'
      + offenders.join('\n')
    );
  });
});
