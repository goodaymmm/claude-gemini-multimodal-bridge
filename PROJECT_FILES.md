# Claude-Gemini Multimodal Bridge - Project Structure

This file lists all the created files for the CGMB project.

## ✨ Recent Updates (2025-06-30)
- 🚀 **Simplified MCP Integration**: "add MCP" style easy setup
- 🔧 **Automatic Environment Loading**: Smart .env file detection  
- 🛡️ **Security Enhanced**: No hardcoded API keys in MCP config
- ⚡ **Auto-startup**: Claude Code automatically starts server when needed

## Project Root Files
- package.json              # Node.js project configuration and dependencies
- tsconfig.json             # TypeScript compiler configuration  
- .env.example              # Environment variables template
- .gitignore                # Git ignore patterns
- README.md                 # Project documentation and usage guide

## Source Code (/src)
- src/index.ts              # Main entry point and exports
- src/cli.ts                # Command-line interface implementation

### Core Framework (/src/core)
- src/core/types.ts         # TypeScript type definitions and schemas
- src/core/CGMBServer.ts    # Main MCP server implementation
- src/core/LayerManager.ts  # Multi-layer orchestration system

### Utilities (/src/utils)
- src/utils/logger.ts       # Winston-based logging system
- src/utils/errorHandler.ts # Comprehensive error handling utilities

## Scripts (/scripts) ✅ COMPLETED
- scripts/setup.sh          # Automated setup script for dependencies
- scripts/postinstall.cjs   # NPM postinstall automation script

## Layer Implementations (/src/layers) ✅ COMPLETED
- src/layers/ClaudeCodeLayer.ts   # Claude Code integration layer
- src/layers/GeminiCLILayer.ts    # Gemini CLI integration layer  
- src/layers/AIStudioLayer.ts     # Google AI Studio MCP layer

### Additional Utilities (/src/utils) ✅ COMPLETED
- src/utils/envLoader.ts         # Smart environment variable loading
- src/utils/mcpConfigManager.ts  # MCP configuration management
- src/utils/quotaMonitor.ts      # API quota monitoring and management

### Authentication System (/src/auth) ✅ COMPLETED
- src/auth/AuthStateManager.ts   # Authentication state management
- src/auth/AuthVerifier.ts       # Multi-service authentication verification
- src/auth/InteractiveSetup.ts   # Interactive authentication setup wizard
- src/auth/OAuthManager.ts       # OAuth flow management

### Intelligence & Analysis (/src/intelligence) ✅ COMPLETED
- src/intelligence/CapabilityDetector.ts # Layer capability detection

### Proxy System (/src/proxy) ✅ COMPLETED
- src/proxy/ClaudeProxy.ts       # Claude Code proxy and integration
- src/proxy/RequestAnalyzer.ts   # Request analysis and routing

### Tools and Workflows (/src/tools) ✅ COMPLETED
- src/tools/multimodalProcess.ts     # Main multimodal processing tool
- src/tools/documentAnalysis.ts     # Document analysis workflows
- src/tools/workflowOrchestrator.ts # Workflow management system

### Workflow Implementations (/src/workflows) ✅ COMPLETED
- src/workflows/AnalysisWorkflow.ts  # Document and content analysis workflows
- src/workflows/ConversionWorkflow.ts # File format conversion workflows
- src/workflows/ExtractionWorkflow.ts # Data extraction workflows
- src/workflows/GenerationWorkflow.ts # Content generation workflows

### Testing (/tests)
- tests/unit/                    # Unit tests for individual components
- tests/integration/            # Integration tests for layer interactions
- tests/e2e/                   # End-to-end workflow tests

### Documentation (/docs)
- docs/INSTALLATION.md         # Detailed installation guide
- docs/USAGE.md               # Usage examples and tutorials
- docs/API.md                 # API reference documentation
- docs/CONTRIBUTING.md        # Contribution guidelines
- docs/TROUBLESHOOTING.md     # Common issues and solutions

### Configuration Files
- jest.config.js              # Jest testing configuration
- eslint.config.js           # ESLint linting rules
- .github/workflows/ci.yml   # GitHub Actions CI/CD pipeline

## Current Status

✅ **Completed (Full Implementation)**
- ✅ Project structure and configuration
- ✅ Type definitions and schemas  
- ✅ Main server implementation
- ✅ Layer management system
- ✅ Logging and error handling
- ✅ CLI interface with comprehensive commands
- ✅ All layer implementations (Claude Code, Gemini CLI, AI Studio)
- ✅ Authentication system (OAuth, API keys, session management)
- ✅ Tool implementations (multimodal processing, document analysis, workflow orchestration)
- ✅ Workflow implementations (analysis, conversion, extraction, generation)
- ✅ Intelligence and capability detection
- ✅ Proxy system for Claude Code integration
- ✅ Environment management and MCP configuration
- ✅ Quota monitoring and management
- ✅ NPM package preparation and automation scripts
- ✅ **Simplified MCP Integration** ("add MCP" style setup)

🔄 **In Progress**
- NPM package testing and final publication
- Advanced testing suite expansion

⏳ **Pending**
- Complete testing suite
- Advanced documentation
- CI/CD pipeline
- Performance optimization
- Production deployment guides

## Installation and Setup

1. Navigate to the project directory:
   ```bash
   cd M:\work9\claude-gemini-multimodal-bridge
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Run setup script:
   ```bash
   chmod +x scripts/setup.sh
   ./scripts/setup.sh
   ```

4. Configure environment:
   ```bash
   cp .env.example .env
   # Edit .env file with your API keys
   ```

5. Build the project:
   ```bash
   npm run build
   ```

6. Start the MCP server:
   ```bash
   npm start
   # or directly:
   cgmb serve
   ```

## Development Commands

- `npm run dev`              # Run in development mode
- `npm run build`            # Build TypeScript to JavaScript
- `npm run serve`            # Start MCP server
- `npm start`                # Start MCP server (alias)
- `npm run test`             # Run all tests
- `npm run lint`             # Run ESLint
- `npm run setup`            # Run setup script
- `cgmb --help`              # Show CLI help
- `cgmb serve`               # Start MCP server directly
- `cgmb verify`              # Verify system configuration
- `cgmb auth-status`         # Check authentication status
- `cgmb setup-mcp`           # Setup Claude Code MCP integration

## Architecture Overview

```
CGMB Server
├── Layer Manager (Orchestration)
│   ├── Claude Code Layer (Complex reasoning)
│   ├── Gemini CLI Layer (Grounding & CLI tools)  
│   └── AI Studio Layer (Multimodal processing)
├── Tools (MCP Interface)
│   ├── Multimodal Processing
│   ├── Document Analysis
│   └── Workflow Orchestration
└── Utilities
    ├── Logging System
    ├── Error Handling
    ├── File Processing
    └── Caching
```

This project provides a **complete implementation** of multi-layer AI integration with:
- 🚀 **Simplified MCP Integration** ("add MCP" style setup)
- 🛡️ **Robust Authentication** (OAuth, API keys, session management)  
- ⚡ **Adaptive Execution** (intelligent layer selection)
- 🔧 **Comprehensive CLI** (setup, verification, testing)
- 📊 **Quota Management** (monitoring and optimization)
- 🌐 **Multi-format Support** (images, audio, PDFs, documents)
- 🔄 **Workflow Orchestration** (analysis, conversion, extraction, generation)

## MCP Integration

### Simple Setup (Claude Code)
```json
{
  "mcpServers": {
    "claude-gemini-multimodal-bridge": {
      "command": "cgmb",
      "args": ["serve"]
    }
  }
}
```

### Features
- ✅ **Auto-startup**: Claude Code starts server automatically
- ✅ **Environment Auto-loading**: Smart .env file detection
- ✅ **No API Key Hardcoding**: Secure environment variable handling
- ✅ **Graceful Fallbacks**: Works with limited layer availability