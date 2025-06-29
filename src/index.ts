#!/usr/bin/env node

import { config } from 'dotenv';
import { CGMBServer } from './core/CGMBServer.js';
import { logger } from './utils/logger.js';

// ===================================
// Main Entry Point
// ===================================

async function main() {
  try {
    // Load environment variables
    config();

    // Log startup information
    logger.info('Starting Claude-Gemini Multimodal Bridge (CGMB)...', {
      version: '1.0.0',
      nodeVersion: process.version,
      platform: process.platform,
    });

    // Create and initialize server
    const server = new CGMBServer();
    
    // Start the server
    await server.start();
    
    logger.info('CGMB is ready to accept connections');

    // Graceful shutdown handling
    process.on('SIGINT', async () => {
      logger.info('Received SIGINT, shutting down gracefully...');
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      logger.info('Received SIGTERM, shutting down gracefully...');
      process.exit(0);
    });

  } catch (error) {
    logger.error('Failed to start CGMB server', error);
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