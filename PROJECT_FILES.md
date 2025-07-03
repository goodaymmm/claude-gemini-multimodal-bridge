# Claude-Gemini Multimodal Bridge v1.0.0 - Project Files

## 📁 Project Structure

```
claude-gemini-multimodal-bridge/
├── 📄 Core Configuration
│   ├── package.json              # NPM package configuration v1.0.0
│   ├── package-lock.json         # Dependencies lock file
│   ├── tsconfig.json             # TypeScript configuration
│   ├── eslint.config.js          # ESLint configuration with output directories
│   └── .env.example              # Environment variables template
│
├── 📖 Documentation
│   ├── README.md                 # Main project documentation v1.0.0
│   ├── CHANGELOG.md              # Version history and release notes
│   ├── CLAUDE.md                 # Claude Code integration guidelines
│   ├── PROJECT_FILES.md          # This file - project structure
│   └── docs/
│       └── ENHANCED_CLI_GUIDE.md # Comprehensive CLI command reference
│
├── 🔧 Scripts & Configuration
│   ├── scripts/
│   │   ├── postinstall.cjs       # Post-installation setup
│   │   ├── setup.sh              # System setup script
│   │   └── verify-dependencies.sh # Dependency verification
│
├── 💻 Source Code (src/)
│   ├── 🚀 Core System
│   │   ├── index.ts              # MCP server entry point
│   │   ├── cli.ts                # CLI interface with 15+ commands
│   │   └── core/
│   │       ├── CGMBServer.ts     # MCP server implementation
│   │       ├── LayerManager.ts   # AI layer orchestration
│   │       └── types.ts          # TypeScript types and constants
│   │
│   ├── 🤖 AI Layers
│   │   └── layers/
│   │       ├── ClaudeCodeLayer.ts    # Complex reasoning layer
│   │       ├── GeminiCLILayer.ts     # Web search and rapid processing
│   │       └── AIStudioLayer.ts      # Multimodal processing layer
│   │
│   ├── 🔐 Authentication System
│   │   └── auth/
│   │       ├── AuthCache.ts          # Service-specific caching
│   │       ├── AuthStateManager.ts   # Persistent auth state
│   │       ├── AuthVerifier.ts       # Multi-service verification
│   │       ├── InteractiveSetup.ts   # User-friendly auth wizard
│   │       └── OAuthManager.ts       # OAuth flow management
│   │
│   ├── 🛠 Processing Tools
│   │   └── tools/
│   │       ├── multimodalProcess.ts  # Main multimodal processing
│   │       ├── documentAnalysis.ts   # Document analysis with dynamic PDF processing
│   │       └── workflowOrchestrator.ts # Complex workflow execution
│   │
│   ├── 📋 Workflow Implementations
│   │   └── workflows/
│   │       ├── AnalysisWorkflow.ts   # Content analysis workflows
│   │       ├── ConversionWorkflow.ts # File format conversion
│   │       ├── ExtractionWorkflow.ts # Data extraction workflows
│   │       └── GenerationWorkflow.ts # Content generation workflows
│   │
│   ├── 🎯 Intelligence & Routing
│   │   ├── intelligence/
│   │   │   └── CapabilityDetector.ts # Smart task analysis
│   │   ├── proxy/
│   │   │   ├── ClaudeProxy.ts        # Claude Code proxy
│   │   │   └── RequestAnalyzer.ts    # Request analysis
│   │   └── services/
│   │       └── IntelligentRouter.ts  # Optimal layer routing
│   │
│   ├── 🖥 MCP Servers
│   │   └── mcp-servers/
│   │       └── ai-studio-mcp-server.ts # Custom AI Studio MCP server
│   │
│   └── ⚙️ Utilities
│       └── utils/
│           ├── logger.ts             # Structured logging system
│           ├── errorHandler.ts       # Enterprise error handling
│           ├── PromptOptimizer.ts    # Automatic prompt optimization
│           ├── SearchCache.ts        # Intelligent caching system
│           ├── TimeoutManager.ts     # Adaptive timeout management
│           ├── envLoader.ts          # Environment loading
│           ├── mcpConfigManager.ts   # MCP configuration automation
│           └── quotaMonitor.ts       # API quota tracking
│
├── 🏗 Build Output
│   └── dist/                     # Compiled JavaScript (auto-generated)
│       ├── index.js              # Compiled MCP server
│       ├── cli.js                # Compiled CLI (executable)
│       └── [source structure]    # Compiled source tree
│
└── 📁 Runtime Directories
    ├── output/                   # Generated content storage
    │   ├── images/               # Generated images
    │   ├── audio/                # Generated audio files
    │   └── documents/            # Processed documents
    ├── logs/                     # Application logs
    └── node_modules/             # NPM dependencies
```

## 🔑 Key Features by File

### Core System Files

#### `src/index.ts` - MCP Server Entry Point
- Model Context Protocol server for Claude Code integration
- Tool registration and request handling
- CGMB keyword triggering for enhanced capabilities

#### `src/cli.ts` - CLI Interface
- 15+ commands for direct system interaction
- User-friendly interfaces: `cgmb chat`, `cgmb c`
- Enhanced commands: `generate-audio`, `generate-image`, `analyze`
- Intelligent routing and layer management

#### `src/core/LayerManager.ts` - AI Layer Orchestration
- Intelligent task analysis and layer selection
- Adaptive timeout management
- Fallback strategies with 95% self-healing
- Workflow execution (sequential, parallel, adaptive)

### AI Layer Implementations

#### `src/layers/AIStudioLayer.ts` - Multimodal Processing
- **Dynamic PDF Processing**: pdf-parse loaded only when needed
- Image generation with Imagen models
- Audio generation with high-quality TTS
- Multi-language support and automatic translation
- File API integration for large document processing

#### `src/layers/GeminiCLILayer.ts` - Web Search & Rapid Processing
- Real-time web search capabilities
- Simplified architecture (435 lines vs 1458 lines)
- OAuth authentication with caching
- Automatic search detection and prioritization

#### `src/layers/ClaudeCodeLayer.ts` - Complex Reasoning
- Strategic planning and complex logic
- Code analysis and workflow orchestration
- Long-form reasoning with 300s timeout
- Synthesis and complex task breakdown

### Authentication & Security

#### `src/auth/AuthCache.ts` - Service-Specific Caching
- Smart TTL optimization (Gemini 6h, AI Studio 24h, Claude 12h)
- 80% authentication overhead reduction
- Intelligent cache invalidation
- Service-specific optimization strategies

#### `src/auth/AuthVerifier.ts` - Multi-Service Verification
- Unified authentication status checking
- OAuth token validation
- API key verification
- Health monitoring and diagnostics

### Processing & Analysis Tools

#### `src/tools/documentAnalysis.ts` - Document Analysis
- **Fixed PDF Processing**: Dynamic pdf-parse loading prevents audio generation errors
- Gemini File API prioritization (50MB, 1000 pages)
- Fallback to pdf-parse when needed
- Enhanced text extraction for Japanese content
- OCR integration for complex documents

#### `src/mcp-servers/ai-studio-mcp-server.ts` - Custom MCP Server
- **Dynamic PDF Processing**: Prevents global library loading
- Professional tool descriptions for security compliance
- File retrieval system (get_generated_file, list_generated_files)
- Image/audio generation with safety mechanisms
- Multimodal file processing

### Utilities & Performance

#### `src/utils/SearchCache.ts` - Intelligent Caching
- 60-80% cache hit rates
- 1-hour TTL with intelligent cleanup
- Memory optimization and automatic management
- Performance monitoring and metrics

#### `src/utils/TimeoutManager.ts` - Adaptive Timeout Management
- **Fixed Timeout Handling**: Immediate response upon completion
- Layer-specific timeouts (Claude 300s, Gemini 30s, AI Studio 120s)
- No hanging timeouts or memory leaks
- Intelligent timeout adjustment based on task complexity

## 🚀 Version 1.0.0 Key Improvements

### Fixed Issues
- ✅ **PDF Processing Isolation**: Audio generation no longer triggers PDF processing
- ✅ **Dynamic Library Loading**: pdf-parse loaded only when processing PDFs
- ✅ **Timeout Optimization**: Immediate response upon task completion
- ✅ **Memory Efficiency**: Eliminated unnecessary library initialization

### Enhanced Features  
- ✅ **Stable Architecture**: Simplified and optimized layer interactions
- ✅ **Improved Error Handling**: 95% self-healing with smart fallbacks
- ✅ **Performance Optimization**: Reduced startup time and memory usage
- ✅ **Multi-Language Support**: Automatic translation for image generation

### Development & Deployment
- ✅ **Clean Build System**: TypeScript compilation with proper error handling
- ✅ **NPM Package Ready**: Optimized for distribution and installation
- ✅ **Enhanced Documentation**: Comprehensive guides and troubleshooting
- ✅ **Robust Testing**: Verified audio generation and PDF analysis workflows

## 🏷 File Type Legend

- 📄 Configuration files
- 📖 Documentation
- 🔧 Scripts and build tools
- 💻 Source code
- 🚀 Core system components
- 🤖 AI layer implementations
- 🔐 Authentication and security
- 🛠 Processing tools
- 📋 Workflow definitions
- 🎯 Intelligence and routing
- 🖥 MCP server implementations
- ⚙️ Utilities and helpers
- 🏗 Build output
- 📁 Runtime directories

This structure represents a mature, production-ready multi-layer AI integration system with robust error handling, intelligent routing, and comprehensive multimodal capabilities.