import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  isVersionAtLeast,
  looksLikeAgyBinary,
  MIN_AGY_VERSION,
} from '../dist/utils/antigravityCli.js';
import { LayerTypeSchema, TargetLayerSchema, normalizeLayerName } from '../dist/core/types.js';
import { LayerManager, assertNoCredentialFiles } from '../dist/core/LayerManager.js';
import { AntigravityCLILayer } from '../dist/layers/AntigravityCLILayer.js';
import { buildSpawnTarget, isUntrustedBinaryLocation, resolveTrustedCommand, resolveWindowsCommand } from '../dist/utils/processUtils.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const isWindows = process.platform === 'win32';

/** Collect stdout from a child, with a hard deadline. */
function runChild(file, args, options = {}, stdinData) {
  return new Promise(resolve => {
    const child = spawn(file, args, {
      stdio: [stdinData === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
      ...options,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, options.deadlineMs ?? 8000);

    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });

    if (stdinData !== undefined) {
      child.stdin.on('error', () => {});
      child.stdin.end(stdinData);
    }

    child.on('close', code => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });
    child.on('error', error => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: null, timedOut, error });
    });
  });
}

describe('agy version gate', () => {
  it('accepts the minimum and rejects the release below it', () => {
    // Builds before 1.1.7 gate stdout on isatty(): they print nothing and exit
    // 0 on a non-TTY, turning every call into a silent wrong answer.
    assert.equal(MIN_AGY_VERSION, '1.1.7');
    assert.equal(isVersionAtLeast('1.1.7', MIN_AGY_VERSION), true, '1.1.7 must be accepted');
    assert.equal(isVersionAtLeast('1.1.6', MIN_AGY_VERSION), false, '1.1.6 must be rejected');
    assert.equal(isVersionAtLeast('1.0.9', MIN_AGY_VERSION), false);
    assert.equal(isVersionAtLeast('1.2.0', MIN_AGY_VERSION), true);
    assert.equal(isVersionAtLeast('2.0.0', MIN_AGY_VERSION), true);
    assert.equal(isVersionAtLeast('v1.1.7', MIN_AGY_VERSION), true, 'a v prefix must not break parsing');
  });
});

describe('binary identity guard', () => {
  it('refuses a stale GEMINI_CLI_PATH that still points at the retired CLI', () => {
    // Adopting the old binary would either trip the version guard or invoke the
    // wrong program, and would short-circuit the search for a real agy.
    assert.equal(looksLikeAgyBinary('/usr/local/bin/gemini'), false);
    assert.equal(looksLikeAgyBinary('C:\\Users\\x\\AppData\\Local\\gemini\\gemini.exe'), false);

    assert.equal(looksLikeAgyBinary('agy'), true);
    assert.equal(looksLikeAgyBinary('/home/u/.local/bin/agy'), true);
    assert.equal(looksLikeAgyBinary('C:\\Users\\x\\AppData\\Local\\agy\\bin\\agy.EXE'), true);
  });
});

describe('layer naming back-compat', () => {
  it('accepts both the canonical and deprecated names, and rejects unknown ones', () => {
    for (const schema of [LayerTypeSchema, TargetLayerSchema]) {
      assert.equal(schema.safeParse('antigravity').success, true);
      assert.equal(schema.safeParse('gemini').success, true, 'deprecated alias must keep working');
      assert.equal(schema.safeParse('not-a-layer').success, false);
    }
  });

  it('normalizes the deprecated name and leaves others alone', () => {
    assert.equal(normalizeLayerName('gemini'), 'antigravity');
    assert.equal(normalizeLayerName('antigravity'), 'antigravity');
    assert.equal(normalizeLayerName('claude'), 'claude');
    assert.equal(normalizeLayerName('adaptive'), 'adaptive');
  });

  it('keeps the pre-rename public getters on LayerManager', () => {
    // LayerManager is a public export; removing these broke compilation for
    // TypeScript consumers and threw TypeError for JavaScript ones.
    const lm = new LayerManager({
      claude: { timeout: 300000, max_tokens: 16384, temperature: 0.2 },
      gemini: { temperature: 0.2, max_tokens: 16384, timeout: 60000, model: 'gemini-2.5-flash', api_key: '' },
      aistudio: { temperature: 0.2, max_tokens: 16384, timeout: 180000, model: 'gemini-2.5-flash', api_key: '' },
    });

    assert.equal(typeof lm.getGeminiLayer, 'function');
    assert.equal(typeof lm.getGeminiLayerAsync, 'function');
    assert.equal(lm.getGeminiLayer(), lm.getAntigravityLayer(), 'must return the same instance');
  });
});

describe('subprocess stdin handling', () => {
  it('a child that drains stdin only completes when stdin is closed', async () => {
    // Regression: `agy models` reads stdin to EOF before emitting anything, and
    // execFile wires stdin to a pipe it never closes -- so the auth probe hung
    // until its own timeout on every call, while `agy --version` (which never
    // touches stdin) made detection look healthy.
    const fixture = join(HERE, 'fixtures', 'stdin-reader.mjs');

    const openPipe = await new Promise(resolve => {
      const child = spawn(process.execPath, [fixture], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let out = '';
      const timer = setTimeout(() => { child.kill('SIGTERM'); resolve({ out, timedOut: true }); }, 3000);
      child.stdout.on('data', d => { out += d; });
      child.on('close', () => { clearTimeout(timer); resolve({ out, timedOut: false }); });
    });
    assert.equal(openPipe.timedOut, true, 'leaving stdin open must hang (this is the bug)');
    assert.equal(openPipe.out.trim(), '');

    const closed = await runChild(process.execPath, [fixture], {}, '');
    assert.equal(closed.timedOut, false, 'closing stdin must let the child finish');
    assert.match(closed.stdout, /STDIN_CLOSED/);
  });
});

describe('windows .cmd argument handling', { skip: !isWindows && 'Windows-only behaviour' }, () => {
  const shimDir = join(tmpdir(), `cgmb-test-shim-${process.pid}`);
  const shim = join(shimDir, 'shim.cmd');

  after(() => rmSync(shimDir, { recursive: true, force: true }));

  it('does not execute shell metacharacters supplied as prompt text', async () => {
    // Regression: prompt text is caller-controlled and reaches the layer from
    // MCP input. Passing it in argv to a .cmd shim meant it became part of a
    // cmd.exe command line, and MSVCRT-style \" escaping does not protect it --
    // cmd.exe has no backslash-escape concept, so the quote closed early and
    // everything after an unquoted & ran as a command.
    rmSync(shimDir, { recursive: true, force: true });
    mkdirSync(shimDir, { recursive: true });
    writeFileSync(shim, '@echo off\r\necho SHIM-ARGS: %*\r\n', { encoding: 'utf8', flag: 'wx' });

    const quote = value => `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`;
    const payload = 'x" & echo INJECTED_MARKER & rem "';
    const comspec = process.env.ComSpec ?? 'cmd.exe';

    const viaCmd = async args => {
      const line = [shim, ...args].map(quote).join(' ');
      return runChild(comspec, ['/d', '/s', '/c', `"${line}"`], {
        windowsVerbatimArguments: true,
      });
    };

    // The vulnerable shape, asserted so the test fails if it ever stops being
    // vulnerable for an unrelated reason (which would invalidate the contrast).
    const inArgv = await viaCmd(['--print', payload]);
    assert.match(inArgv.stdout, /INJECTED_MARKER/, 'sanity: argv delivery is the unsafe shape');

    // The shipped shape: only static flags on the command line.
    const staticOnly = await viaCmd(['--print']);
    assert.doesNotMatch(staticOnly.stdout, /INJECTED_MARKER/, 'static argv must not inject');
    assert.match(staticOnly.stdout, /SHIM-ARGS: "--print"/);
  });
});

describe('windows .cmd launcher', { skip: !isWindows && 'Windows-only behaviour' }, () => {
  const dir = join(tmpdir(), `cgmb-test-launcher-${process.pid}`);
  const shim = join(dir, 'faketool.cmd');

  after(() => rmSync(dir, { recursive: true, force: true }));

  it('can invoke a .cmd shim that execFileSync alone cannot', async () => {
    // Regression: npm installs Claude Code as `claude.cmd` on Windows, and
    // execFileSync on a .cmd fails with EINVAL because CreateProcess cannot run
    // a batch file. An auth probe that called execFileSync directly therefore
    // reported an installed, signed-in Claude as unauthenticated and cached it,
    // disabling the whole layer.
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(shim, '@echo off\r\necho {"loggedIn":true}\r\n', { encoding: 'utf8', flag: 'wx' });

    // Sanity: the naive call really does fail, so the contrast stays meaningful.
    let naiveFailed = false;
    try {
      execFileSync(shim, ['auth', 'status'], { encoding: 'utf8', stdio: 'pipe', windowsHide: true });
    } catch (error) {
      naiveFailed = error.code === 'EINVAL';
    }
    assert.equal(naiveFailed, true, 'sanity: execFileSync on .cmd must fail with EINVAL');

    // The shared launcher must make it work.
    const target = buildSpawnTarget(shim, ['auth', 'status', '--json']);
    const output = execFileSync(target.file, target.args, {
      encoding: 'utf8',
      stdio: 'pipe',
      windowsHide: true,
      ...target.spawnOptions,
    });
    assert.equal(JSON.parse(output.trim()).loggedIn, true);
  });
});

describe('posix shim launcher', { skip: isWindows && 'POSIX-only behaviour' }, () => {
  // The counterpart to the .cmd case above. There is no EINVAL to contrast
  // with here -- the kernel honours a shebang -- so what this pins is that the
  // launcher hands a script straight to spawn without inventing a shell around
  // it, which is what keeps prompt text out of a command line.
  const dir = join(tmpdir(), `cgmb-test-shim-${process.pid}`);
  const shim = join(dir, 'faketool');

  after(() => rmSync(dir, { recursive: true, force: true }));

  it('invokes a shell-script shim without wrapping it in a shell', () => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(shim, '#!/bin/sh\necho \'{"loggedIn":true}\'\n', { encoding: 'utf8', mode: 0o755 });

    const target = buildSpawnTarget(shim, ['auth', 'status', '--json']);

    assert.equal(target.file, shim, 'the script itself must be the spawned file');
    assert.deepEqual(target.args, ['auth', 'status', '--json'], 'arguments stay separate');
    assert.deepEqual(target.spawnOptions, {}, 'no shell, no verbatim-argument flag');

    const output = execFileSync(target.file, target.args, {
      encoding: 'utf8',
      stdio: 'pipe',
    });
    assert.equal(JSON.parse(output.trim()).loggedIn, true);
  });

  it('does not interpret shell metacharacters in an argument', () => {
    // The POSIX counterpart to the cmd.exe injection case: an argument full of
    // separators must arrive as one string, not as further commands.
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(shim, '#!/bin/sh\nprintf "SAW:%s" "$1"\n', { encoding: 'utf8', mode: 0o755 });

    const payload = 'x; echo INJECTED; $(echo INJECTED) `echo INJECTED` && echo INJECTED';
    const target = buildSpawnTarget(shim, [payload]);
    const output = execFileSync(target.file, target.args, { encoding: 'utf8', stdio: 'pipe' });

    assert.match(output, /^SAW:/, 'the shim must be what ran');
    assert.equal(
      output, `SAW:${payload}`,
      'the argument must arrive whole, with nothing executed out of it'
    );
  });
});

describe('spawn target shape', () => {
  // Platform-neutral, and it used to be trapped inside the Windows-only
  // launcher block -- so on Linux and WSL nothing checked it at all.
  it('passes a real executable straight through, without a shell', () => {
    const target = buildSpawnTarget(process.execPath, ['--version']);
    assert.equal(target.file, process.execPath);
    assert.deepEqual(target.args, ['--version']);
    assert.equal(target.spawnOptions.windowsVerbatimArguments, undefined);
  });
});

describe('translation sanitiser', () => {
  const layer = new AntigravityCLILayer();
  const clean = raw => layer.extractTranslation(raw, 'ORIGINAL');

  it('keeps leading digits that are part of the text', () => {
    // A greedy [\d.)\s]+ strip turned "3D render" into "D render" and dropped
    // the year from "2026 Tokyo skyline" -- generating a different image
    // rather than failing.
    assert.equal(clean('3D render of three cats'), '3D render of three cats');
    assert.equal(clean('2026 Tokyo skyline'), '2026 Tokyo skyline');
    assert.equal(clean('4K photo of a bridge'), '4K photo of a bridge');
  });

  it('still strips genuine list and heading markers', () => {
    assert.equal(clean('1. A cat on a sofa'), 'A cat on a sofa');
    assert.equal(clean('- A cat on a sofa'), 'A cat on a sofa');
    assert.equal(clean('> A cat on a sofa'), 'A cat on a sofa');
    assert.equal(clean('### A cat on a sofa'), 'A cat on a sofa');
  });

  it('does not accept a bare label or refusal as a single-line translation', () => {
    // Taking any single line verbatim let these through as successful
    // translations; the AI Studio layer then marked wasTranslated and sent them
    // to the image API, which generated a picture of the wrong thing and
    // reported success.
    assert.equal(clean('Option 1'), 'ORIGINAL');
    assert.equal(clean('Here are a few options:'), 'ORIGINAL');
    assert.equal(clean('I cannot help with that request'), 'ORIGINAL');

    // But a labelled answer keeps its payload.
    assert.equal(clean('Translation: A cat on a sofa'), 'A cat on a sofa');
  });

  it('keeps single-line prompts that mention a style', () => {
    // A vocabulary-based label heuristic rejected these as headings, so the
    // Japanese original was sent to the image API instead of the translation.
    assert.equal(clean('Anime style illustration of a cat'), 'Anime style illustration of a cat');
    assert.equal(clean('Cinematic shot of a mountain landscape'), 'Cinematic shot of a mountain landscape');
    assert.equal(clean('Photorealistic portrait of a dog'), 'Photorealistic portrait of a dog');
  });

  it('does not mistake a section label for the translation', () => {
    const reply = [
      'Here are a few options:',
      '',
      '### 1. Natural & Direct Translation (Best all-rounder)',
      '> **"A landscape of blue sky and white clouds"**',
    ].join('\n');
    assert.equal(clean(reply), 'A landscape of blue sky and white clouds');
  });

  it('caps runaway output and falls back when nothing is usable', () => {
    assert.ok(clean(`x${'y'.repeat(900)}`).length <= 400);
    assert.equal(clean('   '), 'ORIGINAL');
  });
});

describe('translation failure reaches the caller', () => {
  // translateToEnglish used to catch everything and return its input. That made
  // a failed translation indistinguishable from a successful one: AIStudioLayer
  // took the untranslated prompt as a translation, recorded wasTranslated:true,
  // and sent Japanese to an image API expecting English. Its own "translation
  // unavailable, continuing in the input language" branch existed the whole
  // time and had never been reachable.

  /** A layer whose underlying agy call fails. */
  function layerWithFailingCli(message) {
    const layer = new AntigravityCLILayer();
    layer.isInitialized = true;
    layer.executeAntigravityCLI = async () => { throw new Error(message); };
    return layer;
  }

  it('rejects instead of returning the untranslated text', async () => {
    const layer = layerWithFailingCli('agy is not installed');
    const original = '夕暮れの海辺を歩く犬の水彩画';

    await assert.rejects(
      () => layer.translateToEnglish(original, 'ja'),
      error => {
        assert.doesNotMatch(
          error.message.replace(/Could not translate the .* prompt to English: /, ''),
          new RegExp(original),
          'the refusal must not hand back the input as if it were a translation'
        );
        return true;
      }
    );
  });

  it('names the language and keeps the underlying reason', async () => {
    const layer = layerWithFailingCli('agy exited with code 1');

    await assert.rejects(
      () => layer.translateToEnglish('こんにちは', 'ja'),
      error =>
        /Japanese/.test(error.message) &&
        /agy exited with code 1/.test(error.message)
    );
  });

  it('still returns the translation when the CLI answers', async () => {
    const layer = new AntigravityCLILayer();
    layer.isInitialized = true;
    layer.executeAntigravityCLI = async () => 'A watercolour of a dog on the shore at dusk';

    const translated = await layer.translateToEnglish('夕暮れの海辺を歩く犬の水彩画', 'ja');
    assert.equal(translated, 'A watercolour of a dog on the shore at dusk');
  });
});

describe('binary discovery trust', () => {
  it('refuses an agy candidate inside the working directory', () => {
    // Windows `where` lists the current directory before PATH. Verified: with
    // an agy.cmd present, `where agy` returns it ahead of the real install --
    // so a repository could execute its own binary, inheriting every
    // environment variable including API keys.
    assert.equal(isUntrustedBinaryLocation(join(process.cwd(), 'agy.exe')), true);
    assert.equal(isUntrustedBinaryLocation(join(process.cwd(), 'tools', 'agy')), true);
    assert.equal(isUntrustedBinaryLocation('./agy.cmd'), true);
    assert.equal(isUntrustedBinaryLocation(process.cwd()), true);

    // A real installation outside the tree stays usable.
    assert.equal(isUntrustedBinaryLocation(join(tmpdir(), 'agy', 'bin', 'agy.exe')), false);
  });

  it('applies the trust check to explicit paths on every platform', () => {
    // buildSpawnTarget returned the command untouched off Windows, so a bare
    // `claude` was handed to spawn for PATH to resolve -- and PATH routinely
    // leads with ./node_modules/.bin, inside the repository.
    const inTree = join(process.cwd(), 'node_modules', '.bin', 'claude');
    assert.equal(resolveTrustedCommand(inTree), undefined, 'an in-tree path must be refused');
    assert.throws(() => buildSpawnTarget(inTree, ['--version']), /Could not resolve a trusted/);

    // An explicit path outside the tree is still honoured.
    const outside = join(tmpdir(), 'tools', 'claude');
    assert.equal(resolveTrustedCommand(outside), outside);
  });

  it('fails closed rather than falling back to a bare command name', () => {
    // Returning the bare name after rejecting every candidate handed it to
    // spawn, and on a default Windows install the executable search includes
    // the current directory -- so the rejected file would run anyway. There is
    // nothing safe to execute when no trusted candidate exists.
    //
    // buildSpawnTarget resolves and checks on every platform, so this half is
    // not Windows-specific: gating it as such meant Linux and WSL never
    // exercised the refusal at all.
    const missing = `cgmb-no-such-tool-${process.pid}`;

    assert.throws(
      () => buildSpawnTarget(missing, ['--version']),
      /Could not resolve a trusted/,
      'buildSpawnTarget must refuse rather than spawn a bare name'
    );
  });

  it('refuses an unresolvable name through the Windows helper', { skip: !isWindows && 'Windows-only helper' }, () => {
    const missing = `cgmb-no-such-tool-${process.pid}`;
    assert.equal(resolveWindowsCommand(missing), undefined, 'an unresolvable name must not be returned');
  });
});

describe('subprocess output decoding', () => {
  it('does not corrupt a UTF-8 character split across chunks', async () => {
    // Calling toString() per Buffer decoded chunks independently, so a
    // multi-byte character split across data events became U+FFFD on both
    // sides -- corrupting Japanese answers silently and caching the result.
    const fixture = join(HERE, 'fixtures', 'split-utf8.mjs');

    const decoded = await new Promise(resolve => {
      const child = spawn(process.execPath, [fixture], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let out = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => { out += chunk; });
      child.on('close', () => resolve(out));
    });

    assert.match(decoded, /日本語テスト応答/, 'the split character must survive');
    assert.doesNotMatch(decoded, /�/, 'no replacement characters');
  });
});

// Read once, at load, so the scan below can tell this run's leaks from debris
// that was already in a shared tmpdir.
const SUITE_STARTED = Date.now();

describe('workspace isolation', () => {
  it('leaves no shared, predictably-named scratch directory behind', () => {
    // Regression: every run shared <tmp>/cgmb-agy-workspace and never cleaned
    // it, so files from one request could leak into the next, and the
    // predictable name invited pre-creation or symlink swaps on shared hosts.
    assert.equal(
      existsSync(join(tmpdir(), 'cgmb-agy-workspace')),
      false,
      'the fixed shared workspace must no longer be created'
    );

    // Any per-run directory created since this file loaded would mean cleanup
    // regressed. Scoped by time on purpose: tmpdir is shared, so an unscoped
    // scan fails on debris left by an unrelated process, by a run of an older
    // build, or by the very defect a later case in this suite is proving is
    // fixed -- which is what it did, reporting a leak that this run had not
    // caused and could not clean up.
    const leftovers = readdirSync(tmpdir())
      .filter(name => /^cgmb-agy-/.test(name))
      .filter(name => {
        try {
          const at = statSync(join(tmpdir(), name));
          // birthtime is not recorded on every filesystem and reads as 0
          // where it is not; mtime is, and nothing writes to a workspace
          // after its run, so the later of the two dates the directory.
          return Math.max(at.birthtimeMs, at.mtimeMs) >= SUITE_STARTED;
        } catch {
          return false; // removed while being listed: cleanup working
        }
      });
    assert.deepEqual(leftovers, [], `stale agy workspaces: ${leftovers.join(', ')}`);
  });
});

describe('AI Studio failure does not become a fabricated success', () => {
  // The end-to-end form of the getFallbackOrder unit test below. Codex asked
  // for exactly this: fail AI Studio for real and prove the request dies there
  // rather than sliding to a layer that cannot read the files and answering
  // from the prompt alone.

  /** Replace a manager's layers with recording stubs. */
  function stubLayers(manager, { aistudio, claude, antigravity }) {
    const calls = { aistudio: [], claude: [], antigravity: [] };

    const make = (name, behaviour) => ({
      initialize: async () => {},
      isAvailable: async () => true,
      execute: async task => {
        calls[name].push(task);
        return behaviour(task);
      },
    });

    manager.aiStudioLayer = make('aistudio', aistudio);
    manager.claudeLayer = make('claude', claude);
    manager.antigravityLayer = make('antigravity', antigravity);

    // getXLayerAsync() caches a promise; seed it so the real constructors are
    // never reached (they would want credentials and a subprocess).
    manager.aiStudioLayerPromise = Promise.resolve(manager.aiStudioLayer);
    manager.claudeLayerPromise = Promise.resolve(manager.claudeLayer);
    manager.antigravityLayerPromise = Promise.resolve(manager.antigravityLayer);

    manager.layerInitialized.aistudio = true;
    manager.layerInitialized.claude = true;
    manager.layerInitialized.antigravity = true;

    return calls;
  }

  const succeed = data => () => ({ success: true, data, metadata: { layer: 'stub', duration: 1 } });
  const fail = message => () => { throw new Error(message); };

  it('fails a file-carrying request instead of routing it to a layer that cannot read files', async () => {
    const manager = new LayerManager();
    const calls = stubLayers(manager, {
      aistudio: fail('AI Studio quota exceeded'),
      claude: succeed('I have reviewed the documents.'),
      antigravity: succeed('here is a search result'),
    });

    await assert.rejects(
      () => manager.executeWithOptimalLayer({
        type: 'multimodal',
        prompt: 'Summarise the attached report',
        files: [{ path: '/tmp/report.pdf', type: 'document' }],
      }),
      /cannot process files|no fallback layer can process files/i,
      'the request must fail rather than be answered without the file'
    );

    assert.deepEqual(calls.claude, [], 'Claude must not be handed a file-carrying task');
    assert.deepEqual(calls.antigravity, [], 'the search layer must not be handed one either');
    assert.equal(calls.aistudio.length, 1, 'AI Studio should have been the one attempt');
  });

  it('still falls back normally for a text-only request', async () => {
    // The guard must be scoped to files. If it also stopped text fallback it
    // would take out the layer redundancy the router exists to provide.
    const manager = new LayerManager();
    const calls = stubLayers(manager, {
      aistudio: fail('AI Studio down'),
      claude: succeed('answered by Claude'),
      antigravity: fail('agy down'),
    });

    const result = await manager.executeWithOptimalLayer({
      type: 'text_processing',
      prompt: 'Explain the difference between TCP and UDP',
    });

    assert.equal(result.success, true);
    assert.equal(result.data, 'answered by Claude');
    assert.equal(calls.claude.length, 1, 'Claude must still be reachable for text');
  });
});

describe('workflow execution modes', () => {
  // executeWorkflow's four modes had no coverage: the live checks exercised
  // sequential and parallel, adaptive and hybrid nothing at all. Driven with
  // stub layers so no CLI or API is involved.

  /** A manager whose layers record their calls with timings. */
  function managerWithTimedStubs({ failStep } = {}) {
    const manager = new LayerManager();
    const calls = [];

    for (const [name, field] of [
      ['aistudio', 'aiStudioLayer'],
      ['claude', 'claudeLayer'],
      ['antigravity', 'antigravityLayer'],
    ]) {
      const stub = {
        initialize: async () => {},
        isAvailable: async () => true,
        execute: async task => {
          // The task itself is kept, not just its name: what a step was given
          // is the only way to tell a resolved @step.output reference from the
          // literal string.
          const entry = { layer: name, action: task.action, task, startedAt: Date.now() };
          calls.push(entry);
          await new Promise(resolve => setTimeout(resolve, 40));
          entry.endedAt = Date.now();

          if (failStep && task.action === failStep) {
            throw new Error(`stub failure in ${failStep}`);
          }
          return { success: true, data: `did:${task.action}`, metadata: { layer: name, duration: 40 } };
        },
      };
      manager[field] = stub;
      manager[`${field}Promise`] = Promise.resolve(stub);
      manager.layerInitialized[name] = true;
    }

    manager.stubCalls = calls;
    return manager;
  }

  const chain = {
    steps: [
      { id: 'first', layer: 'antigravity', action: 'search', input: { prompt: 'a' } },
      { id: 'second', layer: 'claude', action: 'synthesize_response', input: { prompt: 'b' }, dependsOn: ['first'] },
    ],
  };

  const independent = {
    steps: [
      { id: 'a', layer: 'antigravity', action: 'search', input: { prompt: 'a' } },
      { id: 'b', layer: 'antigravity', action: 'grounded_search', input: { prompt: 'b' } },
    ],
  };

  it('runs a dependent chain in order under adaptive', async () => {
    const manager = managerWithTimedStubs();

    const result = await manager.executeWorkflow(chain, {}, { executionMode: 'adaptive' });

    assert.equal(result.success, true, JSON.stringify(result.results));
    assert.deepEqual(Object.keys(result.results).sort(), ['first', 'second']);

    const [first, second] = manager.stubCalls;
    assert.ok(
      first.endedAt <= second.startedAt,
      'a step that depends on another must not start before it finishes'
    );
  });

  it('overlaps independent steps under parallel', async () => {
    const manager = managerWithTimedStubs();

    await manager.executeWorkflow(independent, {}, { executionMode: 'parallel' });

    const [a, b] = manager.stubCalls;
    assert.ok(
      b.startedAt < a.endedAt,
      'independent steps must actually overlap, not merely be labelled parallel'
    );
  });

  it('reports a failed step rather than folding it into success', async () => {
    // A past defect derived success from a count and reported a run with a
    // failed step as fully successful.
    const manager = managerWithTimedStubs({ failStep: 'synthesize_response' });

    const result = await manager.executeWorkflow(chain, {}, { executionMode: 'adaptive' });

    assert.equal(result.success, false, 'a failed step must fail the run');
    assert.equal(result.results.first.success, true);
    assert.equal(result.results.second.success, false);
    assert.match(String(result.summary), /fail/i);
  });

  it('does not double-wrap a step result', async () => {
    // executeStep once returned a LayerResult wrapped in another LayerResult,
    // so result.data was an object with its own success/data rather than the
    // answer.
    const manager = managerWithTimedStubs();

    const result = await manager.executeWorkflow(chain, {}, { executionMode: 'sequential' });

    assert.equal(typeof result.results.first.data, 'string', 'data must be the answer itself');
    assert.equal(result.results.first.data, 'did:search');
  });

  it('completes a mixed workflow under hybrid', async () => {
    // Reaching executeHybrid is a narrow target: adaptive goes sequential when
    // the work "requires complex reasoning" (a prompt over 1000 characters, or
    // more than three steps) and parallel when the estimated complexity is
    // low, and only otherwise hybrid. This case used to pass {} as the input,
    // which lands on low complexity -- so it ran the parallel branch and every
    // assertion in it held, hybrid untouched. A generation-shaped prompt with
    // three steps is medium complexity without requiring reasoning, which is
    // the combination hybrid is for.
    const manager = managerWithTimedStubs();

    let hybridRan = 0;
    const realHybrid = manager.executeHybrid.bind(manager);
    manager.executeHybrid = (...args) => {
      hybridRan += 1;
      return realHybrid(...args);
    };

    const mixed = {
      steps: [
        { id: 'search', layer: 'antigravity', action: 'search', input: { prompt: 'a' } },
        { id: 'reason', layer: 'claude', action: 'complex_reasoning', input: { prompt: 'b' } },
        { id: 'wrap', layer: 'claude', action: 'synthesize_response', input: { prompt: 'c' }, dependsOn: ['search', 'reason'] },
      ],
    };

    const result = await manager.executeWorkflow(
      mixed,
      { prompt: 'generate a summary poster' },
      { executionMode: 'adaptive' }
    );

    assert.equal(hybridRan, 1, 'adaptive must have chosen hybrid, not another branch');
    assert.equal(result.success, true, JSON.stringify(result.results));
    assert.deepEqual(Object.keys(result.results).sort(), ['reason', 'search', 'wrap']);

    const wrap = manager.stubCalls.find(c => c.action === 'synthesize_response');
    const others = manager.stubCalls.filter(c => c.action !== 'synthesize_response');
    assert.equal(others.length, 2, 'both independent steps must have run');
    for (const earlier of others) {
      assert.ok(earlier.endedAt <= wrap.startedAt, 'the dependent step must run last');
    }
  });

  it('runs the steps that share a priority group concurrently', async () => {
    // What hybrid is for: within one dependency level, steps on the same layer
    // form a group and run together. A hybrid run that quietly degraded to
    // one-at-a-time would look identical from its results alone.
    const manager = managerWithTimedStubs();

    const sameLayer = {
      steps: [
        { id: 'searchA', layer: 'antigravity', action: 'search', input: { prompt: 'a' } },
        { id: 'searchB', layer: 'antigravity', action: 'search', input: { prompt: 'b' } },
        { id: 'wrap', layer: 'claude', action: 'synthesize_response', input: { prompt: 'c' }, dependsOn: ['searchA', 'searchB'] },
      ],
    };

    await manager.executeWorkflow(sameLayer, { prompt: 'generate a summary poster' }, { executionMode: 'adaptive' });

    const [a, b] = manager.stubCalls.filter(c => c.action === 'search');
    assert.ok(a && b, 'both searches must have run');
    assert.ok(
      a.startedAt < b.endedAt && b.startedAt < a.endedAt,
      'steps sharing a group must overlap, not merely be labelled a group'
    );
  });

  it('gives a hybrid step the output of the step it depends on', async () => {
    // `@step.output` is the only way a step reads an earlier answer. Hybrid ran
    // its layer groups in priority order regardless of dependsOn, so a
    // synthesis step could start before the steps it named had begun -- and
    // resolve its reference against an empty map.
    const manager = managerWithTimedStubs();

    const chained = {
      steps: [
        { id: 'search', layer: 'antigravity', action: 'search', input: { prompt: 'a' } },
        { id: 'wrap', layer: 'claude', action: 'synthesize_response', input: { prompt: '@search.output' }, dependsOn: ['search'] },
      ],
    };

    const result = await manager.executeWorkflow(chained, { prompt: 'generate a summary poster' }, { executionMode: 'adaptive' });

    assert.equal(result.success, true, JSON.stringify(result.results));
    const wrap = manager.stubCalls.find(c => c.action === 'synthesize_response');
    assert.equal(
      wrap.task.prompt, 'did:search',
      'the reference must carry the upstream answer, not the literal @search.output'
    );
  });

  it('gives a parallel step the output of the step it depends on', async () => {
    // The same contract, in the mode that never honoured it: parallel handed
    // resolveStepInput the raw LayerResults, which have no `output`, so the
    // reference resolved to undefined and the step ran with nothing.
    const manager = managerWithTimedStubs();

    const chained = {
      steps: [
        { id: 'search', layer: 'antigravity', action: 'search', input: { prompt: 'a' } },
        { id: 'wrap', layer: 'claude', action: 'synthesize_response', input: { prompt: '@search.output' }, dependsOn: ['search'] },
      ],
    };

    const result = await manager.executeWorkflow(chained, {}, { executionMode: 'parallel' });

    assert.equal(result.success, true, JSON.stringify(result.results));
    const wrap = manager.stubCalls.find(c => c.action === 'synthesize_response');
    assert.equal(wrap.task.prompt, 'did:search', 'a parallel step must see its dependency answer');
  });

  it('fails a hybrid run whose step fails, rather than reporting the rest', async () => {
    const manager = managerWithTimedStubs({ failStep: 'complex_reasoning' });

    const mixed = {
      steps: [
        { id: 'search', layer: 'antigravity', action: 'search', input: { prompt: 'a' } },
        { id: 'reason', layer: 'claude', action: 'complex_reasoning', input: { prompt: 'b' } },
        { id: 'wrap', layer: 'claude', action: 'synthesize_response', input: { prompt: 'c' }, dependsOn: ['search', 'reason'] },
      ],
    };

    const result = await manager.executeWorkflow(
      mixed,
      { prompt: 'generate a summary poster' },
      { executionMode: 'adaptive' }
    );

    assert.equal(result.success, false, 'a failed step must fail the run');
    assert.equal(result.results.search.success, true);
    assert.equal(result.results.reason.success, false);
  });
});

describe('credential files never reach the AI Studio egress', () => {
  // Being able to read a file locally is not the same authorisation as sending
  // it to Google. AI Studio's MCP server readFileSync()s whatever path it is
  // given, so this is the point of actual disclosure.

  it('refuses credential-shaped names and allows ordinary ones', () => {
    const refused = [
      '.env', '.env.production', '.npmrc', '.netrc', 'id_rsa', 'id_ed25519',
      'credentials.json', 'secrets.yaml', 'server.pem', 'client.p12',
    ];

    for (const name of refused) {
      assert.throws(
        () => assertNoCredentialFiles({ files: [{ path: join('/some/dir', name), type: 'text' }] }),
        /credential file pattern/,
        `${name} must be refused`
      );
    }

    const allowed = [
      'report.pdf', 'notes.md', 'environment.md', 'index.ts',
      'Dockerfile', 'secretsmanager.ts', 'monkey.png',
    ];

    for (const name of allowed) {
      assert.doesNotThrow(
        () => assertNoCredentialFiles({ files: [{ path: join('/some/dir', name), type: 'document' }] }),
        `${name} must be allowed`
      );
    }
  });

  it('checks every file, and tolerates tasks with no files', () => {
    assert.throws(
      () => assertNoCredentialFiles({
        files: [{ path: '/a/report.pdf' }, { path: '/b/.env' }],
      }),
      /credential file pattern/,
      'a credential file anywhere in the list must fail the whole task'
    );

    assert.doesNotThrow(() => assertNoCredentialFiles({ prompt: 'hello' }));
    assert.doesNotThrow(() => assertNoCredentialFiles({ files: [] }));
    assert.doesNotThrow(() => assertNoCredentialFiles(undefined));
  });
});

describe('files are refused, not silently dropped', () => {
  // The layer used to accept task.files and ignore them, so a request to
  // summarise a document was answered from the prompt alone and reported as a
  // success. Inlining file contents was tried as the fix and then removed:
  // making it safe cost far more code than the fallback was worth. Failing is
  // now the contract, and these tests hold it in place.

  it('refuses a task that carries files', async () => {
    const layer = new AntigravityCLILayer();

    await assert.rejects(
      () => layer.execute({
        type: 'text_processing',
        prompt: 'Summarise this',
        files: [{ path: join(HERE, 'antigravity-cli.test.mjs'), type: 'text' }],
      }),
      /cannot process files/i,
      'a file-carrying task must fail rather than answer from the prompt alone'
    );
  });

  it('refuses processFiles and names the layer to use instead', async () => {
    const layer = new AntigravityCLILayer();

    await assert.rejects(
      () => layer.processFiles([{ path: '/tmp/report.pdf', type: 'document' }], 'Summarise'),
      error => /cannot process files/i.test(error.message) && /cgmb analyze/.test(error.message),
      'the refusal must point the caller at the AI Studio path'
    );
  });

  it('drops file-incapable layers from the fallback order', () => {
    // executeWithFallback swallows each layer's error and moves on, so the
    // search layer's refusal used to be caught and the task slid to Claude --
    // which declares task.files and never reads it, then reports success.
    const manager = new LayerManager();
    const withFiles = {
      type: 'multimodal',
      prompt: 'Summarise',
      files: [{ path: '/tmp/report.pdf', type: 'document' }],
    };

    const afterAiStudio = manager.getFallbackOrder('aistudio', withFiles);
    assert.deepEqual(
      afterAiStudio,
      [],
      'nothing can read files once AI Studio is out, so the chain must end'
    );

    const afterClaude = manager.getFallbackOrder('claude', withFiles);
    assert.deepEqual(
      afterClaude,
      ['aistudio'],
      'only the file-capable layer may remain'
    );

    // Text-only routing must be untouched.
    const textOnly = manager.getFallbackOrder('aistudio', { type: 'search', prompt: 'hello' });
    assert.deepEqual(textOnly, ['antigravity', 'claude']);
  });

  it('refuses to fall back to the search layer for a step that carries files', async () => {
    const manager = new LayerManager();

    const failedStep = {
      id: 'analyse',
      layer: 'aistudio',
      input: { files: [{ path: '/tmp/report.pdf', type: 'document' }], prompt: 'Summarise' },
    };
    const workflow = {
      steps: [failedStep],
      fallbackStrategies: {
        aistudio_unavailable: {
          replace: 'analyse',
          with: { id: 'analyse-fallback', layer: 'gemini', input: { prompt: 'Summarise' } },
        },
      },
    };

    // tryFallbackStrategy is private in TypeScript terms only; the compiled
    // output exposes it, and this is the behaviour worth pinning.
    await assert.rejects(
      () => manager.tryFallbackStrategy(
        failedStep,
        workflow,
        new Error('AI Studio quota exceeded'),
        { executionMode: 'sequential' }
      ),
      error =>
        /cannot fall back to the Antigravity CLI layer/.test(error.message) &&
        /AI Studio quota exceeded/.test(error.message),
      'the fallback must fail loudly and preserve the original cause'
    );
  });
});

describe('the real invocation, recorded by a stand-in agy', {
  // The layer spawns the binary directly, with no shell -- which is the
  // behaviour being protected. On Windows that means a .cmd stand-in raises
  // EINVAL before the layer is even exercised, and the real agy there is an
  // .exe we cannot forge. So these run on POSIX, including the WSL leg and the
  // ubuntu CI job; on Windows nothing below is verified.
  skip: isWindows && 'the layer spawns without a shell, so a .cmd stand-in cannot stand in for agy.exe',
}, () => {
  // The three suites above prove things about Node and about the test's own
  // setup: that a pipe left open blocks, that a decoder the test builds joins
  // chunks, that a directory the test never created is absent. None of them
  // enters AntigravityCLILayer, so the production path could stop closing
  // stdin, decode per chunk, inherit secrets or leave its workspace behind and
  // they would all still pass.
  //
  // This drives the layer itself. The stand-in is installed through
  // ANTIGRAVITY_CLI_PATH, which is how a user points CGMB at a non-standard
  // install -- no test-only seam.

  const RECORDER = join(HERE, 'fixtures', 'agy-recorder.cjs');
  const layerUrl = new URL('../dist/layers/AntigravityCLILayer.js', import.meta.url).href;
  // Built, not typed. Line endings written by hand into generated scripts is
  // how the cancellation fixture came to be invalid JavaScript that died on
  // startup while its case still passed.
  const NEWLINE = String.fromCharCode(10);
  const CRLF = String.fromCharCode(13, 10);
  const recorderScratch = mkdtempSync(join(tmpdir(), 'cgmb-recorder-'));
  after(() => rmSync(recorderScratch, { recursive: true, force: true }));

  /**
   * Run one execute() against the stand-in, in a child process.
   *
   * A child because binary discovery memoises its answer for the lifetime of a
   * process, so a second scenario in this one would reuse the first one's
   * decision and quietly test nothing. It also keeps the environment edits from
   * leaking into other suites.
   *
   * The stand-in is a real executable -- a .cmd on Windows, a shell script with
   * the execute bit elsewhere -- because that is what the layer spawns. A .cjs
   * file cannot be exec'd on either platform, which is why the first attempt
   * recorded nothing at all.
   */
  function installStandIn({ out, mode }) {
    const dir = mkdtempSync(join(recorderScratch, 'bin-'));
    const node = process.execPath;

    // The recording path and mode ride in on argv, baked into this wrapper.
    // The layer strips the environment before spawning -- deliberately, since
    // agy is a coding agent handling caller text -- so anything passed that way
    // never arrives.
    const agy = join(dir, 'agy');
    writeFileSync(agy, [
      '#!/bin/sh',
      `exec ${JSON.stringify(node)} ${JSON.stringify(RECORDER)}`
        + ` --cgmb-out ${JSON.stringify(out)} --cgmb-mode ${JSON.stringify(mode)} "$@"`,
      '',
    ].join(NEWLINE), {
      encoding: 'utf8',
      mode: 0o755,
    });
    return agy;
  }

  async function runRecorded({ mode = 'reply', linger = false, prompt = '東京の天気' } = {}) {
    const out = join(recorderScratch, `rec-${Math.random().toString(36).slice(2)}.json`);
    const agy = installStandIn({ out, mode });

    const script = `
      import { AntigravityCLILayer } from ${JSON.stringify(layerUrl)};
      const layer = new AntigravityCLILayer();
      try {
        const result = await layer.execute({
          type: 'text_processing',
          prompt: process.env.CGMB_TEST_PROMPT,
          useSearch: false,
        });
        console.log('VERDICT ' + JSON.stringify({ ok: true, data: String(result?.data ?? ''), success: result?.success }));
      } catch (error) {
        console.log('VERDICT ' + JSON.stringify({ ok: false, message: String(error.message) }));
      }
      ${linger ? `
      // Stay alive past the escalation the layer scheduled, then report what it
      // achieved -- while this process is still running, so the answer is about
      // the layer and not about the exit sweep that would clean up anyway.
      await new Promise(resolve => setTimeout(resolve, 6000));
      const { existsSync, readFileSync } = await import('node:fs');
      const rec = JSON.parse(readFileSync(process.env.CGMB_TEST_REC, 'utf8'));
      let alive = false;
      try { process.kill(rec.pid, 0); alive = true; } catch {}
      console.log('AFTER ' + JSON.stringify({ alive, workspace: existsSync(rec.cwd), pid: rec.pid }));
      ` : ''}
      process.exit(0);
    `;

    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: dirname(RECORDER),
      env: {
        ...process.env,
        ANTIGRAVITY_CLI_PATH: agy,
        ANTIGRAVITY_TIMEOUT: mode === 'slow' || mode === 'stubborn' ? '1500' : '30000',
        CGMB_TEST_PROMPT: prompt,
        // Handed over rather than spliced into the generated source: escaping a
        // path into a string literal is what made the cancellation fixture
        // invalid JavaScript that died on startup while its case still passed.
        CGMB_TEST_REC: out,
        // A secret the child must not pass on to agy.
        CGMB_SECRET_PROBE: 'a-secret-the-child-must-not-see',
        AI_STUDIO_API_KEY: 'key-that-must-not-reach-agy',
      },
      encoding: 'utf8',
      timeout: 120000,
      windowsHide: true,
    });

    const lines = (child.stdout || '').split(NEWLINE);
    const pick = (tag) => {
      const line = lines.find(l => l.startsWith(`${tag} `));
      return line ? JSON.parse(line.slice(tag.length + 1)) : undefined;
    };
    const recorded = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : undefined;
    return { verdict: pick('VERDICT'), after: pick('AFTER'), recorded, stderr: child.stderr };
  }

  it('closes stdin, so a child that drains it can finish', async () => {
    const { verdict, recorded, stderr } = await runRecorded();

    assert.ok(recorded, `the stand-in never reached end-of-stdin:
${stderr}`);
    assert.equal(verdict?.ok, true, verdict?.message);
  });

  it('delivers the prompt on stdin, not on the command line', async () => {
    const prompt = 'weather "quoted" & chained; text';
    const { recorded } = await runRecorded({ prompt });

    assert.ok(recorded, 'no recording');
    assert.equal(recorded.stdin.trim(), prompt, 'the prompt must arrive whole');
    assert.ok(
      !recorded.args.some(arg => arg.includes('weather')),
      `the prompt must not appear in argv: ${JSON.stringify(recorded.args)}`
    );
  });

  it('joins output split mid-character instead of corrupting it', async () => {
    const { verdict } = await runRecorded();

    // The stand-in cuts a multi-byte character across two writes. Decoding
    // each chunk on its own turns that one character into two U+FFFD.
    assert.equal(verdict?.ok, true, verdict?.message);

    assert.match(String(verdict.data), /東京の天気は晴れ/, 'the answer came back mangled');
    assert.doesNotMatch(String(verdict.data), /\uFFFD/, 'a replacement character means per-chunk decoding');
  });

  it('does not hand the child CGMB secrets', async () => {
    const { recorded } = await runRecorded();

    assert.ok(recorded, 'no recording');
    assert.deepEqual(
      recorded.sawSecrets, [],
      `agy is a coding agent running caller-supplied text; it received ${recorded.sawSecrets.join(', ')}`
    );
  });

  it('runs it in a private empty directory', async () => {
    const { recorded } = await runRecorded();

    assert.ok(recorded, 'no recording');
    assert.notEqual(recorded.cwd, process.cwd(), 'it must not run in the caller repository');
    assert.deepEqual(recorded.workspaceEntries, [], 'the workspace must start empty');
  });

  it('escalates to SIGKILL for a child that ignores SIGTERM', async () => {
    // The layer sends SIGTERM on timeout and, two seconds later, SIGKILL if the
    // process is still there. The previous version of this check sent the
    // signals itself and re-implemented the condition the layer uses, so it
    // held whether or not the layer did any of it.
    //
    // Here the stand-in refuses SIGTERM and the layer is left to deal with it.
    // The verdict is read while the CGMB process is still running, six seconds
    // after the timeout: past the escalation, and before the exit sweep -- which
    // would also have killed the child and so would have hidden a missing
    // escalation behind a pass.
    const { verdict, after, recorded } = await runRecorded({ mode: 'stubborn', linger: true });

    assert.ok(recorded, 'the stand-in never ran');
    assert.equal(verdict?.ok, false, 'the run was supposed to time out');
    assert.match(String(verdict.message), /timeout/i);
    assert.ok(after, 'the probe did not report');
    assert.ok(after.pid > 0, 'nothing to escalate against');

    assert.equal(
      after.alive, false,
      `agy ignored SIGTERM and survived: pid ${after.pid} still running six seconds after the timeout`
    );
    assert.equal(after.workspace, false, 'and its scratch directory outlived it');
  });

  it('removes that directory after success, failure and timeout', async () => {
    for (const mode of ['reply', 'fail', 'slow']) {
      const { recorded } = await runRecorded({ mode });
      assert.ok(recorded, `no recording for ${mode}`);

      // Checked after the CGMB process has exited, which is the case that was
      // broken. Cleanup is wired to the child closing; a timeout closes nothing,
      // so on the one-shot CLI path -- `cgmb search`, which returns to the shell
      // as soon as the request settles -- neither the cleanup nor the SIGKILL
      // scheduled two seconds out ever ran. Measured before the fix: the
      // directory still present and two stand-ins still running.
      //
      // An in-process poll would have missed it. Waiting around for the child
      // is exactly what the real caller does not do.
      assert.equal(
        existsSync(recorded.cwd), false,
        `the workspace survived a ${mode} run and its process exiting: ${recorded.cwd}`
      );
    }
  });
});
