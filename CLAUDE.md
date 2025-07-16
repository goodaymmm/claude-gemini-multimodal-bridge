# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This repository contains the **Claude-Gemini Multimodal Bridge (CGMB)** v1.1.0 - an enterprise-grade TypeScript MCP (Model Context Protocol) server that creates an intelligent AI integration bridge connecting Claude Code, Gemini CLI, and Google AI Studio. The project implements a sophisticated 3-layer architecture with intelligent routing, enhanced authentication system with type safety, and advanced multimodal processing capabilities.

## Architecture

### 3-Layer System Architecture
- **Claude Code Layer** (`src/layers/ClaudeCodeLayer.ts`): Complex reasoning, code analysis, strategic planning
- **Gemini CLI Layer** (`src/layers/GeminiCLILayer.ts`): Real-time web search, current information, simplified 435-line implementation
- **AI Studio Layer** (`src/layers/AIStudioLayer.ts`): Multimodal processing, image/audio generation, document analysis

### Core Entry Points
- `src/index.ts`: Main MCP server entry point for Claude Code integration
- `src/cli.ts`: Comprehensive CLI interface with 20+ commands  
- `src/core/CGMBServer.ts`: MCP server implementation with tool registration
- `src/core/LayerManager.ts`: Orchestrates all AI layers with intelligent routing

## Essential Commands

### Build & Development
```bash
# Build the project (includes MCP server compilation)
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

# System verification
cgmb verify
```

### MCP Server Operations
```bash
# Start main MCP server
cgmb serve

# Start custom AI Studio MCP server
npm run mcp:aistudio

# Test MCP server with dummy credentials
npm run mcp:test
```

## Key Directories Structure

### Core System (`src/core/`)
- **CGMBServer.ts**: Main MCP server with tool handlers and request processing
- **LayerManager.ts**: Central orchestrator with adaptive routing and workflow execution
- **types.ts**: Comprehensive TypeScript schemas with Zod validation and AI_MODELS constants

### AI Layers (`src/layers/`)
- **ClaudeCodeLayer.ts**: Complex reasoning with 300s timeout for strategic tasks
- **GeminiCLILayer.ts**: Web search priority layer with 30s minimum timeout
- **AIStudioLayer.ts**: Multimodal processing with 120s timeout, supports image/audio generation

### Authentication System (`src/auth/`) - **Enhanced v1.1.0**
- **types.ts**: Comprehensive type definitions for authentication interfaces
- **AuthCache.ts**: Service-specific caching with type-safe failure tracking
- **AuthStateManager.ts**: Persistent authentication state with enhanced error handling
- **AuthVerifier.ts**: Multi-service verification with nullish coalescing safety
- **InteractiveSetup.ts**: User-friendly authentication wizard with type safety
- **OAuthManager.ts**: OAuth flow management with improved environment variable handling

### Processing Tools (`src/tools/`)
- **multimodalProcess.ts**: Main multimodal content processing engine
- **documentAnalysis.ts**: Advanced document analysis with multi-layer processing
- **workflowOrchestrator.ts**: Complex workflow execution with parallel/sequential modes

### Workflow Implementations (`src/workflows/`)
- **AnalysisWorkflow.ts**: Content analysis workflows
- **ConversionWorkflow.ts**: File format conversion workflows  
- **ExtractionWorkflow.ts**: Data extraction workflows
- **GenerationWorkflow.ts**: Content generation workflows

### Utilities (`src/utils/`)
- **logger.ts**: Structured logging system with Winston
- **errorHandler.ts**: Enterprise-grade error handling with fallback strategies
- **PromptOptimizer.ts**: Automatic prompt compression and optimization
- **SearchCache.ts**: Intelligent caching with 60-80% hit rates and 1-hour TTL
- **mcpConfigManager.ts**: Claude Code MCP configuration automation
- **quotaMonitor.ts**: Google AI Studio quota tracking and management

## Authentication Requirements

### Required Environment Variables
```bash
# AI Studio API key (required for generation features)
AI_STUDIO_API_KEY=your_api_key_here

# Optional - Gemini API key (OAuth preferred)
GEMINI_API_KEY=your_api_key_here
```

### Authentication Setup
```bash
# OAuth authentication for Gemini (recommended)
gemini auth

# Claude authentication
claude auth

# Interactive setup wizard
cgmb auth --interactive
```

### OAuth Authentication (v1.0.0)
CGMB now uses simplified OAuth authentication:
- **File-based verification**: Checks `~/.gemini/oauth_creds.json` directly
- **No gemini command execution**: Eliminates Claude Code environment issues
- **Automatic token refresh**: Handles expired tokens gracefully
- **Exponential backoff**: Smart retry logic for failed authentications

## MCP Integration Patterns

### Automatic MCP Configuration
CGMB automatically configures Claude Code MCP integration:
- Configuration path: `~/.claude-code/mcp_servers.json`
- Direct Node.js execution for 100% compatibility
- Safe merge without overwriting existing servers

### CGMB Keyword Triggering
Use "CGMB" keyword in Claude Code prompts for optimal tool selection:
```
✅ "CGMB analyze this document"
✅ "Use CGMB to process these images"
❌ "Analyze this document" (won't trigger CGMB)
```

## Performance Characteristics

### Layer-Specific Timeouts
- **Claude Code**: 300s (complex reasoning tasks)
- **Gemini CLI**: 30s minimum (network + processing requirements)
- **AI Studio**: 120s (multimodal processing)

### Caching Strategy
- **Authentication Cache**: 80% overhead reduction with service-specific TTLs
- **Search Cache**: 60-80% hit rates with 1-hour TTL
- **Prompt Optimization**: Automatic compression for token efficiency

### Error Recovery
- 95% automatic recovery with intelligent fallback strategies
- Circuit breaker pattern prevents cascade failures
- Per-layer timeout configuration based on service characteristics

## Development Patterns

### Error Handling
```typescript
// Standard error handling pattern
try {
  result = await layerManager.execute(task);
} catch (error) {
  if (error instanceof LayerError && error.layer === 'gemini') {
    // Fallback to Claude Code layer
    result = await layerManager.executeWithFallback(task, 'claude');
  }
  throw error;
}
```

### Workflow Execution
```typescript
// Sequential workflow for dependent steps
const workflow = {
  steps: [
    { id: "extract", layer: "aistudio", dependsOn: [] },
    { id: "analyze", layer: "claude", dependsOn: ["extract"] },
    { id: "summarize", layer: "gemini", dependsOn: ["analyze"] }
  ]
};

// Parallel workflow for independent operations
const parallelWorkflow = {
  steps: [
    { id: "ocr_doc1", layer: "aistudio", dependsOn: [] },
    { id: "ocr_doc2", layer: "aistudio", dependsOn: [] },
    { id: "web_search", layer: "gemini", dependsOn: [] }
  ]
};
```

## Important Implementation Details

### Image Generation
- Uses `gemini-2.0-flash-preview-image-generation` model
- Automatic prompt sanitization (cute → friendly-looking)
- Safety prefixes added automatically
- Generated files saved to `output/images/`
- **Automatic Translation (v1.0.0)**: Non-English prompts are translated to English via Gemini CLI for optimal results

### Audio Generation  
- Uses `gemini-2.5-flash-preview-tts` model
- Multiple voice options (Kore, Puck)
- Supports script generation workflow

### Web Search Priority
- Gemini CLI has highest priority for web search tasks
- Auto-detection based on keywords: weather, news, stock, today, latest, current, etc.
- Built-in grounding capabilities without additional flags

### URL Processing Strategy
- **PDF URLs** (ending in .pdf): Routed to Claude Code layer for optimal processing
- **Web Page URLs**: Routed to Gemini CLI for current information retrieval
- **Local PDF files**: Processed by AI Studio using Gemini File API
- Automatic layer selection ensures best performance for each content type

### File Retrieval System
- Automatic file organization by type (images/, audio/, documents/)
- MCP tools: get_generated_file, list_generated_files, get_file_info
- Includes file metadata (path, size, format) in responses

## Common Debugging Approaches

### Debug Mode
```bash
# Enable comprehensive debugging
export CGMB_DEBUG=true
cgmb gemini -p "test prompt"

# Debug with verbose logging
LOG_LEVEL=debug cgmb serve --debug
```

### Authentication Issues
```bash
# Check detailed authentication status
cgmb auth-status --verbose

# Verify all system components
cgmb verify --fix

# Check quota usage (links to Google Cloud Console)
cgmb quota-status
```

### Layer Communication
```bash
# Test individual layers
cgmb test --file sample.pdf

# Monitor layer performance
cgmb quota-status
```

## Troubleshooting Guide

### Initial Setup Issues

#### Problem: Claude Code uses wrong command paths
**Symptoms**: Commands like `./dist/cli.js chat` or `./dist/cli.js gemini` instead of `cgmb chat`
**Solution**:
```bash
# 1. Ensure proper build
npm run build

# 2. Verify cgmb command is available
which cgmb
cgmb --version

# 3. Reinstall if needed
npm install -g .

# 4. Check MCP configuration
cgmb mcp-status
cgmb setup-mcp
```

#### Problem: Image/Audio generation hangs after completion
**Symptoms**: Generation completes in 5-10 seconds but CLI waits for 2 minutes
**Fixed**: This issue has been resolved in v1.0.0. Update to latest version.
```bash
# Verify you're on the latest version
cgmb --version  # Should be 1.1.0 or higher
```

### Authentication Problems

#### Problem: API key not recognized
**Symptoms**: Authentication errors despite valid API keys
**Solution**:
```bash
# Check authentication status
cgmb auth-status --verbose

# Verify environment variables (priority order)
echo $AI_STUDIO_API_KEY      # Preferred
echo $GOOGLE_AI_STUDIO_API_KEY  # Alternative
echo $GEMINI_API_KEY         # Deprecated but supported

# Interactive setup
cgmb auth --interactive
```

#### Problem: OAuth authentication fails
**Solution**:
```bash
# Reauthorize Gemini CLI
gemini auth
cgmb verify
```

### PDF Processing Issues

#### Problem: PDF text extraction incomplete
**Symptoms**: PDF content not properly understood or analyzed
**Solution**: v1.0.0 now uses Gemini File API for better PDF processing
```bash
# Test PDF processing
cgmb analyze document.pdf --type summary

# For large PDFs (>50MB), split the file first
# Gemini File API supports up to 50MB and 1,000 pages
```

### Performance Issues

#### Problem: Slow response times
**Solution**:
```bash
# Enable authentication caching (reduces overhead by 80%)
# Caching is automatic in v1.0.0:
# - Gemini: 6 hours
# - AI Studio: 24 hours  
# - Claude: 12 hours

# Check cache status
cgmb auth-status

# Monitor quota usage
cgmb quota-status --detailed
```

### Environment Variables

#### Debug Control
```bash
# Enable debug mode for detailed logging
export CGMB_DEBUG=true

# Reduce logging for production
export NODE_ENV=production

# Control CLI verbosity
export CGMB_CLI_MODE=true

# Custom log level
export LOG_LEVEL=debug  # debug, info, warn, error
```

#### Quick Debug Check
```bash
# View current configuration
cgmb auth-status --verbose

# Test all components
cgmb verify

# Check system dependencies
npm run verify
```

## TypeScript Configuration

- **Target**: ES2022 with ESNext modules
- **Strict Mode**: Enabled with comprehensive type checking  
- **Build Output**: `dist/` directory with declaration files
- **Module System**: ESNext with Node.js resolution

## Version Requirements

- Node.js ≥ 22.0.0
- NPM ≥ 8.0.0
- Claude Code CLI (latest)
- Gemini CLI (auto-installed via postinstall)

Always run `npm run build` after source changes to update the MCP server, and use `cgmb verify` to ensure all components are properly configured.

---

## Development Planning

### Current Status (v1.1.0)
- ✅ Authentication system enhanced with comprehensive type safety
- ✅ Non-null assertions eliminated for runtime safety
- ✅ Nullish coalescing applied to environment variable handling
- ✅ Lint problems reduced from 458 to 429 (29 improvements)
- ✅ PDF OCR processing fully implemented and verified working
- ✅ MCP server output standardized (console.log → console.error)
- ✅ PDF timeout issues resolved with immediate response handling

### Development Guidelines
The project maintains a systematic approach to code quality improvement:
- Prioritize authentication and security-related type safety
- Apply nullish coalescing for environment variable handling
- Remove dangerous non-null assertions with proper error handling
- Maintain build success and functionality throughout improvements
- Use progressive enhancement for TypeScript strict mode compliance

For ongoing development, focus on high-impact, low-risk improvements while preserving system stability and user experience.

### Next Implementation: Video Generation Feature (v1.2.0)
**Branch**: `feature/video-generation` → `development`
**Status**: 🚧 **In Progress**

#### Current Implementation Status
- ✅ Type definitions (VideoGenOptions in types.ts)
- ✅ Video generation request detection (isVideoGenerationRequest)
- ✅ Timeout configuration (300s for video generation)
- ✅ CLI command structure prepared
- ❌ **Not Implemented**: Actual video generation processing

#### Implementation Plan
1. **MCP Server Integration** (`src/mcp-servers/ai-studio-mcp-server.ts`)
   - Add `generate_video` tool with proper schema validation
   - Implement video generation using Google AI Studio APIs
   - Handle video output file management

2. **AI Studio Layer** (`src/layers/AIStudioLayer.ts`)
   - Remove `throw new Error('Video generation is not yet implemented')` (line 361)
   - Implement `generateVideo` method with proper API calls
   - Add video file download and storage functionality

3. **CLI Commands** (`src/cli.ts`)
   - Add video generation command options
   - Implement video generation parameter validation
   - Add progress reporting for video generation

#### Technical Considerations
- **API**: Google AI Studio's video generation capabilities
- **Models**: Veo-2 and other available video generation models
- **File Output**: Save to `output/videos/` directory
- **Timeout**: 300s (5 minutes) for video processing
- **File Types**: MP4 output format support

#### Testing Strategy
- Test video generation with various prompts
- Verify timeout handling and error recovery
- Test file output and retrieval functionality
- Validate integration with existing MCP architecture