/**
 * The Gemini CLI -> Antigravity CLI rename, finished.
 *
 * GeminiCLILayer.ts existed as a nine-line shim re-exporting AntigravityCLILayer,
 * and its own comment said it would be removed once every import site had moved.
 * Two had not, so the shim could not go and the codebase still read as though
 * the old CLI were in use. These checks keep it that way once it is gone.
 *
 * The distinction that matters: the *internal* name is fully migrated, while the
 * `gemini` spelling stays valid on the *external* surface -- MCP callers written
 * against the old name must keep working. Removing that alias would be a
 * breaking change to the tool contract, not a completion of the rename.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { LayerManager } from '../dist/core/LayerManager.js';
import { LayerTypeSchema, TargetLayerSchema, normalizeLayerName } from '../dist/core/types.js';

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

const rel = file => file.replace(/.*[\\/]src[\\/]/, 'src/').replace(/\\/g, '/');

describe('the internal rename is complete', () => {
  it('has no GeminiCLILayer module left', () => {
    assert.equal(
      existsSync(join(SRC, 'layers', 'GeminiCLILayer.ts')), false,
      'the compatibility shim should be gone once nothing imports it'
    );
  });

  it('imports the layer by its real name everywhere', () => {
    const offenders = [];

    for (const file of sourceFiles()) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!/GeminiCLILayer/.test(line)) { continue; }
        // A comment recording the history is fine; an import is not.
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) { continue; }
        offenders.push(`${rel(file)}: ${line.trim().slice(0, 80)}`);
      }
    }

    assert.deepEqual(offenders, [], `still referencing the old name:\n${offenders.join('\n')}`);
  });

  it('leaves no orphaned workflows directory', () => {
    // src/workflows/ held 3,619 lines that nothing imported: LayerManager and
    // workflowOrchestrator each build their workflows inline. Unreachable code
    // still costs lint, build and review time, and reads as though it were the
    // implementation.
    assert.equal(existsSync(join(SRC, 'workflows')), false, 'src/workflows/ was unreachable');

    const importers = sourceFiles().filter(f => /from '.*workflows\//.test(readFileSync(f, 'utf8')));
    assert.deepEqual(importers.map(rel), []);
  });
});

describe('the external surface still accepts the old spelling', () => {
  // Deliberately unchanged. MCP callers written against `gemini` predate the
  // rename and must keep working; the alias is the contract, not a leftover.

  it('parses gemini as a layer and as a target', () => {
    assert.equal(LayerTypeSchema.safeParse('gemini').success, true);
    assert.equal(TargetLayerSchema.safeParse('gemini').success, true);
  });

  it('normalises gemini to antigravity and leaves the rest alone', () => {
    assert.equal(normalizeLayerName('gemini'), 'antigravity');
    assert.equal(normalizeLayerName('antigravity'), 'antigravity');
    assert.equal(normalizeLayerName('claude'), 'claude');
    assert.equal(normalizeLayerName('aistudio'), 'aistudio');
  });

  it('keeps the deprecated getter on LayerManager', () => {
    const manager = new LayerManager();
    assert.equal(typeof manager.getGeminiLayer, 'function');
    assert.equal(typeof manager.getGeminiLayerAsync, 'function');
  });
});
