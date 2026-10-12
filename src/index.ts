#!/usr/bin/env node

import { createRequire } from 'module';
import { CGMBServer } from './core/CGMBServer.js';
import { logger } from './utils/logger.js';
import { loadDotenvFile } from './utils/envLoader.js';
import { shutdownAIStudio } from './layers/AIStudioLayer.js';

// Read version from package.json
const require = createRequire(import.meta.url);
const packageJson = require('../package.json') as { version: string };
const VERSION = packageJson.version;

// ===================================
// MCP Server Entry Point for Claude Code
// ===================================

async function main() {
  try {
    // Load environment variables (silently: stdout is the MCP channel)
    loadDotenvFile();

    // Log startup information for MCP server
    logger.info('Starting CGMB MCP Server for Claude Code integration...', {
      version: VERSION,
      nodeVersion: process.version,
      platform: process.platform,
      mcpMode: true,
    });

    // Create and initialize MCP server
    const server = new CGMBServer();

    // Start the MCP server (stdio transport for Claude Code)
    await server.start();

    logger.info('CGMB MCP Server ready', {
      version: VERSION,
      mainTool: 'cgmb - handles all CGMB requests',
      capabilities: {
        'Commands': 'chat, search, analyze, generate, process, extract, translate',
        'Files': 'PDF, images, audio, documents (relative/absolute paths)',
        'URLs': 'Web pages are read by the Antigravity CLI (agy); PDF URLs are downloaded and sent to AI Studio',
        'Generation': 'Images and audio (TTS) through AI Studio (Gemini image and TTS models)',
        'Routing': 'Automatic optimal AI layer selection'
      },
      tips: [
        'Always use "CGMB" keyword in prompts',
        'Relative paths like ./file.pdf are auto-resolved',
        'Web page URLs go to the Antigravity CLI (agy); PDF URLs go to AI Studio'
      ]
    });

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
      logger.info('Received SIGINT, shutting down MCP server...');
      await shutdownAIStudio();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      logger.info('Received SIGTERM, shutting down MCP server...');
      await shutdownAIStudio();
      process.exit(0);
    });

  } catch (error) {
    logger.error('Failed to start CGMB MCP server', error as Error);
    process.exit(1);
  }
}

// Run the main function if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('Unhandled error in main:', error);
    process.exit(1);
  });
}

export { CGMBServer } from './core/CGMBServer.js';
export { LayerManager } from './core/LayerManager.js';
export * from './core/types.js';