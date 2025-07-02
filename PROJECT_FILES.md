# Claude-Gemini Multimodal Bridge - Project Structure

This file lists all the created files for the CGMB project.

## 🚀 Version 1.1.0 - Enterprise-Grade Enhancements (2025-07-02)
- 🏢 **Enterprise-Grade Authentication**: Service-specific caching with OAuth priority for Gemini CLI
- 🧠 **Intelligent Layer Routing**: Automatic task analysis and optimal AI layer selection
- ⚡ **Simplified Architecture**: Streamlined Gemini CLI integration (435 lines vs 1458 lines)
- 🔧 **Fixed MCP Startup**: Direct Node.js execution resolves Claude Code recognition issues
- 🛡️ **Fallback Strategies**: Enterprise-grade error handling with automatic layer switching
- 🔍 **Authentication Caching**: Smart TTL optimization (Gemini 6h, AI Studio 24h, Claude 12h)
- 🎯 **Enhanced MCP Configuration**: Direct Node.js path execution for 100% reliability
- 📊 **TypeScript Optimization**: All compilation errors resolved with improved type safety
- 🔄 **Lazy Layer Loading**: Layers initialize only when needed for faster startup
- 📈 **Performance Monitoring**: Built-in intelligence routing and fallback metrics
- 🌐 **Web Search Priority**: Web search tasks now route to Gemini CLI as highest priority
- 🎵 **Audio Generation**: Proper implementation with gemini-2.5-flash-preview-tts model
- 🖼️ **Image Generation**: Correct model usage (gemini-2.0-flash-preview-image-generation)
- 🚫 **Video Generation Removed**: Unimplemented video generation code completely removed
- 📝 **Script Generation**: Two-step audio generation process with script creation
- 📁 **File Retrieval System**: New MCP tools for accessing generated content
- 🛡️ **Enhanced Security**: Professional tool descriptions to prevent malicious detection
- 📚 **NPM Publishing Ready**: Comprehensive guide and package configuration added
- 🔢 **Model Constants**: Centralized AI model names for consistency
- 🔤 **Prompt Sanitization**: Automatic conversion of problematic words for better content policy compliance
- 📖 **Improved Documentation**: Better Claude Code integration guidance and image generation best practices
- 📦 **genai Migration Complete**: Migrated from @google/generative-ai to @google/genai v1.8.0
- 🚫 **package-lock.json Excluded**: Removed from repository to prevent merge conflicts
- 📋 **.npmignore Added**: Proper NPM package exclusion configuration
- 🔧 **ESLint Enhanced**: Updated rules and ignore patterns for output directories

## Project Root Files
- package.json              # Node.js project configuration and dependencies (genai v1.8.0)
- tsconfig.json             # TypeScript compiler configuration  
- .env.example              # Environment variables template
- .gitignore                # Git ignore patterns (includes output/, package-lock.json, .npmignore)
- .npmignore                # NPM package exclusion configuration
- README.md                 # Project documentation and usage guide
- CLAUDE.md                 # Claude Code usage guidelines and patterns
- PROJECT_FILES.md          # This file - project structure documentation
- CHANGELOG.md              # Version history and release notes
- eslint.config.js          # ESLint configuration for code quality (enhanced rules)

## Documentation (/docs)
- docs/ENHANCED_CLI_GUIDE.md  # Comprehensive CLI command reference
- docs/NPM_PUBLISH_GUIDE.md   # Step-by-step NPM publishing instructions (NEW)

## Source Code (/src)
- src/index.ts              # Main entry point and exports
- src/cli.ts                # Command-line interface implementation

### Core Framework (/src/core) (v1.1.0 Enhanced)
- src/core/types.ts         # TypeScript type definitions, schemas, and AI model constants
- src/core/CGMBServer.ts    # Main MCP server implementation (v1.1.0 updated)
- src/core/LayerManager.ts  # Enhanced with intelligent task analysis and layer routing

### Layer Implementations (/src/layers) (v1.1.0 Enhanced)
- src/layers/ClaudeCodeLayer.ts   # Claude Code integration layer
- src/layers/GeminiCLILayer.ts    # Simplified Gemini CLI integration (435 lines, mcp-gemini-cli patterns)
- src/layers/AIStudioLayer.ts     # Google AI Studio MCP layer with standardized model constants and prompt sanitization

### MCP Servers (/src/mcp-servers)
- src/mcp-servers/ai-studio-mcp-server.ts  # Custom AI Studio MCP server with file retrieval tools and prompt sanitization

### Authentication System (/src/auth)
- src/auth/AuthVerifier.ts      # Multi-service authentication verification (genai migrated)
- src/auth/OAuthManager.ts      # OAuth flow management for Gemini
- src/auth/InteractiveSetup.ts  # User-friendly authentication wizard
- src/auth/AuthStateManager.ts  # Persistent authentication state with TTL
- src/auth/AuthCache.ts         # Service-specific authentication caching (NEW)

### Intelligence System (/src/intelligence)
- src/intelligence/CapabilityDetector.ts  # Layer capability detection and analysis

### Tools (/src/tools)
- src/tools/multimodalProcess.ts  # Multimodal file processing tool
- src/tools/documentAnalysis.ts   # Document analysis and extraction tool
- src/tools/workflowOrchestrator.ts  # Complex workflow orchestration

### Workflows (/src/workflows)
- src/workflows/AnalysisWorkflow.ts    # Document analysis workflows
- src/workflows/ConversionWorkflow.ts  # File conversion workflows
- src/workflows/ExtractionWorkflow.ts  # Data extraction workflows
- src/workflows/GenerationWorkflow.ts  # Content generation workflows

### Services (/src/services)
- src/services/IntelligentRouter.ts  # Intelligent request routing service

### Proxy System (/src/proxy)
- src/proxy/ClaudeProxy.ts      # Claude Code proxy implementation
- src/proxy/RequestAnalyzer.ts  # Request analysis and optimization

### Utilities (/src/utils)
- src/utils/logger.ts           # Winston-based logging system
- src/utils/errorHandler.ts     # Comprehensive error handling utilities
- src/utils/envLoader.ts        # Smart environment variable loader
- src/utils/mcpConfigManager.ts # MCP configuration management
- src/utils/quotaMonitor.ts     # API quota monitoring and management
- src/utils/SearchCache.ts      # Intelligent search result caching
- src/utils/PromptOptimizer.ts  # Prompt optimization and compression

## Scripts (/scripts)
- scripts/setup.sh              # Automated setup script for dependencies
- scripts/postinstall.cjs       # NPM postinstall automation script
- scripts/verify-dependencies.sh # Dependency verification script

## Build Output (/dist)
- dist/                         # Compiled JavaScript output (git-ignored)
- dist/cli.js                   # Executable CLI script
- dist/index.js                 # Main entry point
- dist/mcp-servers/ai-studio-mcp-server.js  # Compiled MCP server

## Generated Content (/output)
- output/images/                # Generated images directory
- output/audio/                 # Generated audio files directory
- output/documents/             # Processed documents directory

## Key Features by File

### Authentication & Security
- Multi-service auth verification (AuthVerifier.ts)
- OAuth integration (OAuthManager.ts)
- Smart caching with TTLs (AuthCache.ts)
- Professional tool descriptions (ai-studio-mcp-server.ts)

### Performance Optimizations
- Lazy layer loading (LayerManager.ts)
- Search result caching (SearchCache.ts)
- Prompt optimization (PromptOptimizer.ts)
- Intelligent routing (IntelligentRouter.ts)

### File Management
- File retrieval tools (ai-studio-mcp-server.ts)
- Organized output directories
- Metadata tracking and management

### Developer Experience
- Comprehensive CLI (cli.ts)
- NPM publishing guide (NPM_PUBLISH_GUIDE.md)
- Enhanced error messages
- TypeScript type safety

## Configuration Files
- Environment variables (.env.example)
- TypeScript config (tsconfig.json)
- ESLint rules (eslint.config.js)
- NPM package config (package.json)

## Package Management Updates
- Migrated from @google/generative-ai to @google/genai v1.8.0
- Removed package dependency conflicts
- Added .npmignore for clean NPM package distribution
- Excluded package-lock.json from repository to prevent merge conflicts
- Ready for NPM publication with optimized package size

Last updated: 2025-07-02 | genai migration complete | NPM-ready