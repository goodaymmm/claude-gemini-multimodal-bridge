#!/usr/bin/env node
/**
 * A stand-in for `agy` that records how CGMB invoked it.
 *
 * Installed through ANTIGRAVITY_CLI_PATH -- the same setting a user would use
 * to point at a non-standard install -- so the layer reaches it by its ordinary
 * discovery path rather than through anything test-only.
 *
 * Configured by argument, not environment, because the layer strips the
 * environment before spawning: agy is a coding agent handling caller-supplied
 * text, so it is given an allowlist and nothing else. The first version of this
 * fixture read CGMB_RECORDER_OUT and recorded nothing at all -- the isolation
 * working exactly as intended.
 *
 *   --cgmb-out <file>   where to write the recording
 *   --cgmb-mode <mode>  reply | slow | fail | stubborn
 */

const fs = require('fs');

const argv = process.argv.slice(2);

function takeOption(name) {
  const at = argv.indexOf(name);
  if (at === -1) { return undefined; }
  const [value] = argv.splice(at, 2).slice(1);
  return value;
}

const out = takeOption('--cgmb-out');
const mode = takeOption('--cgmb-mode') || 'reply';
// argv now holds only what CGMB itself passed.
const args = argv;

if (args.includes('--version')) {
  process.stdout.write('1.1.8\n');
  process.exit(0);
}

if (args[0] === 'models') {
  process.stdout.write('gemini-3.6-flash-low\n');
  process.exit(0);
}

const chunks = [];
process.stdin.on('data', c => chunks.push(c));
process.stdin.on('end', () => {
  if (out) {
    fs.writeFileSync(out, JSON.stringify({
      args,
      stdin: Buffer.concat(chunks).toString('utf8'),
      pid: process.pid,
      cwd: process.cwd(),
      // Names only: a value would put a secret in a file if one ever leaked.
      envNames: Object.keys(process.env).sort(),
      // Which secrets arrived, without recording what they were.
      sawSecrets: ['AI_STUDIO_API_KEY', 'CLAUDE_API_KEY', 'GEMINI_API_KEY', 'CGMB_SECRET_PROBE']
        .filter(name => process.env[name] !== undefined),
      workspaceEntries: fs.readdirSync(process.cwd()),
    }, null, 2), 'utf8');
  }

  if (mode === 'fail') {
    process.stderr.write('stand-in refused\n');
    process.exit(3);
  }

  if (mode === 'slow') {
    // Outlive the caller's timeout, so cleanup-after-timeout is testable.
    setInterval(() => {}, 1000);
    return;
  }

  if (mode === 'stubborn') {
    // Outlives its budget *and* refuses SIGTERM, so only a real escalation to
    // SIGKILL ends it. A stand-in that would have died on SIGTERM proves
    // nothing about whether the escalation exists.
    process.on('SIGTERM', () => {});
    process.on('SIGINT', () => {});
    setInterval(() => {}, 1000);
    return;
  }

  // A multi-byte character split across two writes, which is how mojibake got
  // in: decoding each chunk on its own turned one character into two U+FFFD.
  const text = Buffer.from('東京の天気は晴れ', 'utf8');
  const cut = 4; // lands inside a character
  process.stdout.write(text.subarray(0, cut));
  setTimeout(() => {
    process.stdout.write(text.subarray(cut));
    process.stdout.end();
    process.exit(0);
  }, 30);
});
