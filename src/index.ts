#!/usr/bin/env node

import { config } from 'dotenv';
import { CGMBServer } from './core/CGMBServer.js';
import { logger } from './utils/logger.js';

// ===================================
// MCP Server Entry Point for Claude Code
// ===================================

async function main() {
  try {
    // Load environment variables
    config();

    // Log startup information for MCP server
    logger.info('Starting CGMB MCP Server for Claude Code integration...', {
      version: '1.0.0',
      nodeVersion: process.version,
      platform: process.platform,
      mcpMode: true,
    });

    // Create and initialize MCP server
    const server = new CGMBServer();
    
    // Start the MCP server (stdio transport for Claude Code)
    await server.start();
    
    logger.info('CGMB MCP Server ready for Claude Code connections');

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
      logger.info('Received SIGINT, shutting down MCP server...');
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      logger.info('Received SIGTERM, shutting down MCP server...');
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