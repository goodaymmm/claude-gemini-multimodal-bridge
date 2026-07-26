# Runtime configuration for CGMB's Claude layer

This directory is **not** development tooling. It configures the headless
Claude Code process that `src/layers/ClaudeCodeLayer.ts` spawns for CGMB's
internal reasoning and synthesis calls (`claude --print`).

It ships with the npm package (listed in `package.json` `files`) because it has
to be present at the installed package root to take effect.

## Why it lives here

Claude Code reads `CLAUDE.md`, `.claude/settings.json` and any skills from its
**working directory**. `ClaudeCodeLayer` pins that directory to the package
root, so this file is what governs those calls no matter where a user invokes
`cgmb` from. Before that pinning, cwd was `process.cwd()` — the end user's
project — which meant CGMB's internal calls inherited an unrelated
repository's instructions and permissions.

## Contents

- `settings.json` — pins a single full model ID and grants the minimum access
  the reasoning calls need.
  - The model is a **full ID**, not an alias. Aliases can be remapped by
    `ANTHROPIC_DEFAULT_*` environment variables; `ClaudeCodeLayer.buildChildEnv()`
    strips those from the child, and a full ID means the pin holds regardless.
  - No `opusplan` — plan mode does not exist in headless `--print` runs.
  - `.env` is denied explicitly: it holds API keys, and these calls never need it.

## What does not belong here

Development-oriented agents, skills and commands. Those live in the workspace
tree (`M:\workMCPtest\.claude\`) and are for people working *on* CGMB, not for
the process CGMB spawns at runtime.

Skills placed here would also be loaded by a parent Claude Code session that
has this repository open, so anything added later should carry a `cgmb-`
prefix to keep the two namespaces distinct.
