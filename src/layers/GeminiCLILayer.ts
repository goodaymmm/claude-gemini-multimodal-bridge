/**
 * @deprecated Use `AntigravityCLILayer` from './AntigravityCLILayer.js' instead.
 *
 * Google discontinued Gemini CLI for individual accounts on 2026-06-18; the
 * successor is the Antigravity CLI (`agy`). This module is a compatibility shim
 * so existing imports keep working while the rename lands across the codebase.
 * It will be removed once every import site has been migrated.
 */
export { AntigravityCLILayer, AntigravityCLILayer as GeminiCLILayer } from './AntigravityCLILayer.js';
