# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This workspace contains the **Claude-Gemini Multimodal Bridge (CGMB)** project - an enterprise-grade TypeScript MCP (Model Context Protocol) server located in the `claude-gemini-multimodal-bridge/` directory. The project creates an intelligent AI integration bridge connecting Claude Code, Gemini CLI, and Google AI Studio with sophisticated 3-layer architecture and advanced multimodal processing capabilities.

## Workspace Structure

```
/mnt/m/work9/
├── claude-gemini-multimodal-bridge/    # Main project directory
│   ├── src/                           # Source code
│   ├── dist/                          # Built artifacts
│   ├── package.json                   # Project dependencies
│   ├── tsconfig.json                  # TypeScript configuration
│   └── CLAUDE.md                      # Detailed project guidance
├── temp/                              # Temporary files
├── test-cgmb-fresh/                   # Test environment
└── various documentation files (*.md)
```

## Essential Commands

### Navigation
```bash
# Always work in the main project directory
cd claude-gemini-multimodal-bridge

# Check current project status
npm run verify
```

### Build & Development
```bash
# Build the project (required after code changes)
npm run build

# Development with hot reload
npm run dev

# Type checking
npm run typecheck

# Linting
npm run lint
npm run lint:fix

# Clean and rebuild
npm run clean && npm run build
```

### Testing & Verification
```bash
# Integration tests (requires authentication)
npm run test:integration

# Verify system dependencies
npm run verify

# Authentication status check
cgmb auth-status --verbose
```

### MCP Server Operations
```bash
# Start main MCP server
cgmb serve

# Start custom AI Studio MCP server
npm run mcp:aistudio

# Test MCP server
npm run mcp:test
```

## Architecture Overview

### 3-Layer System
- **Claude Code Layer** (`src/layers/ClaudeCodeLayer.ts`): Complex reasoning, code analysis, strategic planning (300s timeout)
- **Gemini CLI Layer** (`src/layers/GeminiCLILayer.ts`): Real-time web search, current information (30s minimum timeout)
- **AI Studio Layer** (`src/layers/AIStudioLayer.ts`): Multimodal processing, image/audio generation (120s timeout)

### Key Entry Points
- `src/index.ts`: Main MCP server entry point
- `src/cli.ts`: Comprehensive CLI interface with 20+ commands
- `src/core/CGMBServer.ts`: MCP server implementation with tool registration
- `src/core/LayerManager.ts`: Central orchestrator with intelligent routing

### Core Directories
- `src/core/`: MCP server and layer management
- `src/layers/`: AI layer implementations
- `src/auth/`: Authentication system with OAuth support
- `src/tools/`: Multimodal processing tools
- `src/workflows/`: Workflow implementations
- `src/utils/`: Utilities and helpers

## Development Workflow

### Working with Code Changes
1. **Always build after changes**: `npm run build`
2. **Run type checking**: `npm run typecheck`
3. **Fix linting issues**: `npm run lint:fix`
4. **Verify functionality**: `npm run verify`

### Authentication Requirements
```bash
# Required environment variables
AI_STUDIO_API_KEY=your_api_key_here

# OAuth authentication setup
gemini auth
claude auth
```

### File Processing Capabilities
- **Documents**: PDF (max 1000 pages), TXT, MD, HTML via Gemini File API
- **Images**: PNG, JPG, GIF (analysis + generation with Imagen 3)
- **Audio**: WAV, MP3 (analysis + generation with TTS)
- **Code**: All major programming languages

## Important Implementation Notes

### MCP Integration
- **Automatic Configuration**: Updates `~/.claude-code/mcp_servers.json`
- **Tool Registration**: Main tool is `cgmb` with intelligent routing
- **Keyword Triggering**: Use "CGMB" in prompts for optimal tool selection

### Layer Routing Strategy
1. **Code files**: Always route to Claude Code layer
2. **Media files**: Route to AI Studio layer
3. **Web search**: Route to Gemini CLI layer
4. **Generation tasks**: Route to AI Studio layer
5. **Complex reasoning**: Route to Claude Code layer

### Performance Characteristics
- **Authentication Caching**: 80% overhead reduction
- **Search Cache**: 60-80% hit rates with 1-hour TTL
- **Lazy Initialization**: Layers initialized on-demand
- **Intelligent Fallback**: 95% automatic recovery

## Development Patterns

### Error Handling
```typescript
// Use safeExecute wrapper for operations
return safeExecute(
  async () => {
    return await layerManager.execute(task);
  },
  {
    operationName: 'layer-execution',
    timeout: 30000,
  }
);
```

### File Type Detection
The system automatically detects file types and routes appropriately:
- Code files (`.ts`, `.js`, `.py`, etc.) → Claude Code
- Media files (`.png`, `.mp4`, `.wav`) → AI Studio
- Documents (`.pdf`, `.docx`) → AI Studio
- Configuration files (`.json`, `.yaml`) → Claude Code

## Troubleshooting

### Common Issues
1. **Command not found**: Ensure you're in `claude-gemini-multimodal-bridge/` directory
2. **Build failures**: Run `npm run clean && npm run build`
3. **Authentication errors**: Check `cgmb auth-status --verbose`
4. **Type errors**: Run `npm run typecheck`

### Debug Mode
```bash
# Enable comprehensive debugging
export CGMB_DEBUG=true
export LOG_LEVEL=debug

# Test specific functionality
cgmb test --file sample.pdf
```

## Version Requirements

- **Node.js**: ≥ 22.0.0
- **NPM**: ≥ 8.0.0
- **Claude Code CLI**: Latest version
- **Gemini CLI**: Auto-installed via postinstall

## Key Features

### Image Generation
- Uses `gemini-2.0-flash-preview-image-generation` model
- Automatic translation for non-English prompts
- Safety filters and prompt sanitization
- Generated files saved to `output/images/`

### Audio Generation
- Uses `gemini-2.5-flash-preview-tts` model
- Multiple voice options (Kore, Puck)
- Script generation workflow support
- Generated files saved to `output/audio/`

### Document Processing
- PDF URL processing via Gemini CLI
- Local PDF processing via AI Studio
- Automatic format conversion
- Multi-language support

## Working Directory Context

When working with this codebase:

1. **Primary work directory**: `/mnt/m/work9/claude-gemini-multimodal-bridge/`
2. **Always use relative paths** when referencing files within the project
3. **Build artifacts** are in `dist/` directory
4. **Generated content** is organized in `output/` directory

## Important Notes

- The project uses **ES modules** (type: "module" in package.json)
- **TypeScript strict mode** is enabled
- **Winston logging** is configured for structured logging
- **Zod validation** is used for schema validation
- **MCP protocol** integration is automatic

Always consult the detailed project-specific `claude-gemini-multimodal-bridge/CLAUDE.md` file for comprehensive implementation details and troubleshooting guidance.