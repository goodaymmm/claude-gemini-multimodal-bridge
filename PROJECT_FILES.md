# Claude-Gemini Multimodal Bridge - Project Structure

This file lists all the created files for the CGMB project.

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

## Scripts (/scripts)
- scripts/setup.sh          # Automated setup script for dependencies

## Next Steps - Files to Create

### Layer Implementations (/src/layers)
- src/layers/ClaudeCodeLayer.ts   # Claude Code integration layer
- src/layers/GeminiCLILayer.ts    # Gemini CLI integration layer  
- src/layers/AIStudioLayer.ts     # Google AI Studio MCP layer

### Additional Utilities (/src/utils)
- src/utils/fileProcessor.ts     # File handling and processing
- src/utils/promptOptimizer.ts   # Prompt optimization utilities
- src/utils/cache.ts             # Caching system implementation

### Tools and Workflows (/src/tools)
- src/tools/multimodalProcess.ts     # Main multimodal processing tool
- src/tools/documentAnalysis.ts     # Document analysis workflows
- src/tools/workflowOrchestrator.ts # Workflow management system

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

✅ **Completed (Core Framework)**
- Project structure and configuration
- Type definitions and schemas
- Main server implementation
- Layer management system
- Logging and error handling
- CLI interface
- Documentation and setup scripts

🔄 **In Progress**
- Layer implementations (Claude Code, Gemini CLI, AI Studio)
- Tool implementations
- Testing framework

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

6. Start the server:
   ```bash
   npm start
   ```

## Development Commands

- `npm run dev`              # Run in development mode
- `npm run build`            # Build TypeScript to JavaScript
- `npm run test`             # Run all tests
- `npm run lint`             # Run ESLint
- `npm run setup`            # Run setup script
- `cgmb --help`              # Show CLI help

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

This project provides a comprehensive foundation for multi-layer AI integration with robust error handling, adaptive execution, and extensive configurability.