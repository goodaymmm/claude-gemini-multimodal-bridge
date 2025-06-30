# Claude-Gemini Multimodal Bridge - Project Structure

This file lists all the created files for the CGMB project.

## ✨ Recent Updates (2025-07-01) - Enhanced CLI v1.0.0
- 🚀 **Simplified MCP Integration**: "add MCP" style easy setup
- 🔧 **Automatic Environment Loading**: Smart .env file detection  
- 🛡️ **Security Enhanced**: No hardcoded API keys in MCP config
- ⚡ **Auto-startup**: Claude Code automatically starts server when needed
- ✅ **Error.md/Error2.md/Error3.md Issues Resolution**: Fixed "unknown command" and timeout problems
- 🎆 **Enhanced CLI Commands**: Direct layer access (`cgmb gemini`, `cgmb aistudio`, `cgmb process`)
- 🎯 **True Multimodal Processing**: Real content generation and analysis (not just initialization)
- 🔧 **Custom AI Studio MCP Server**: Built-in MCP server replaces non-existent aistudio-mcp-server package
- 🖼️ **AI Studio Image Generation**: Direct support for Imagen models through custom MCP server
- 📊 **Production-Ready**: Demo scripts and dependency verification

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

### MCP Servers (/src/mcp-servers) ✅ COMPLETED
- src/mcp-servers/ai-studio-mcp-server.ts  # Custom AI Studio MCP server implementation

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


### Documentation (/docs) ✅ COMPLETED
- docs/INSTALLATION.md         # Detailed installation guide
- docs/USAGE.md               # Usage examples and tutorials
- docs/API.md                 # API reference documentation
- docs/CONTRIBUTING.md        # Contribution guidelines
- docs/TROUBLESHOOTING.md     # Common issues and solutions
- docs/ENHANCED_CLI_GUIDE.md  # Enhanced CLI commands guide (Error.md fixes)

### Examples (/examples) ✅ COMPLETED
- examples/android_monetization.js  # Android app monetization demo
- examples/gemini_search_demo.js    # Gemini CLI search and grounding demo  
- examples/aistudio_image_demo.js   # AI Studio multimodal processing demo
- **Demo Scripts**: npm run demo:android, demo:gemini, demo:aistudio, demo:all

### Configuration Files
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
- ✅ **Enhanced CLI Commands** (cgmb gemini, cgmb aistudio, cgmb process, cgmb test)
- ✅ **Error.md/Error2.md/Error3.md Issues Resolution** (fixed "unknown command" and timeout problems)
- ✅ **Production-Ready Demo Scripts** (real-world examples for practical use)
- ✅ **Custom AI Studio MCP Server** (built-in server replaces non-existent npm package)
- ✅ **AI Studio Image Generation** (Imagen models support through Gemini API)

🔄 **In Progress**
- NPM package final publication preparation
- Documentation refinement

⏳ **Pending**
- CI/CD pipeline setup
- Performance optimization
- Production deployment guides
- Community feedback integration

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

### Basic Commands
- `npm run dev`              # Run in development mode
- `npm run build`            # Build TypeScript to JavaScript
- `npm run serve`            # Start MCP server
- `npm start`                # Start MCP server (alias)
- `npm run clean`            # Clean build artifacts
- `npm run lint`             # Run ESLint
- `npm run setup`            # Run setup script

- `npm run typecheck`        # Run TypeScript type checking

### Demo Commands (Error.md Fixes Verification)
- `npm run demo:android`     # Run Android monetization demo
- `npm run demo:gemini`      # Run Gemini CLI search demo
- `npm run demo:aistudio`    # Run AI Studio multimodal demo
- `npm run demo:all`         # Run all demo scripts

### MCP Server Commands
- `npm run mcp:aistudio`     # Run AI Studio MCP server standalone
- `npm run mcp:test`         # Test MCP server with dummy API key

### Enhanced CLI Commands
- `cgmb --help`              # Show CLI help
- `cgmb serve`               # Start MCP server directly
- `cgmb verify`              # Verify system configuration
- `cgmb auth-status`         # Check authentication status
- `cgmb setup-mcp`           # Setup Claude Code MCP integration

### Direct Layer Access (NEW - Error.md Fixes)
- `cgmb gemini -p "question" --search`    # Direct Gemini CLI with search
- `cgmb aistudio -p "task" -f file.png`   # Direct AI Studio multimodal processing
- `cgmb process -p "task" -w analysis`    # Intelligent layer routing
- `cgmb test -p "test" -f file.pdf`       # Enhanced testing with actual processing

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
- ✅ **Error Resolution** (fixed Error.md/Error2.md/Error3.md issues)
- 🎆 **Enhanced CLI Commands** (direct layer access with cgmb gemini, cgmb aistudio, cgmb process)
- 🎯 **True Multimodal Processing** (real content generation and analysis)
- 📊 **Production-Ready** (demo scripts and dependency verification)

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