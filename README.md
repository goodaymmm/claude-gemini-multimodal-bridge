# Claude-Gemini Multimodal Bridge (CGMB)

🚀 **Multi-layer AI integration bridge** connecting Claude Code, Gemini CLI, and Google AI Studio for advanced multimodal processing

[![npm version](https://badge.fury.io/js/claude-gemini-multimodal-bridge.svg)](https://badge.fury.io/js/claude-gemini-multimodal-bridge)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org/)

## ✨ Features

- 🔗 **3-Layer Architecture**: Claude Code ↔ Gemini CLI ↔ AI Studio
- 🎯 **Adaptive Execution**: Automatically routes tasks to optimal AI layer
- 📊 **Multimodal Processing**: Images, Audio, PDFs, Documents
- ⚡ **Workflow Orchestration**: Complex multi-step automation
- 🛡️ **Robust Error Handling**: Fallback strategies & retry logic
- 🔧 **Extensible Design**: Easy to add new layers and tools
- 💰 **Cost Optimization**: Smart layer selection for efficiency
- 🔄 **Real-time Processing**: Streaming responses and parallel execution

## 🏗️ Architecture

CGMB operates as an **MCP (Model Context Protocol) server** that seamlessly integrates three powerful AI layers. Claude Code connects to CGMB via MCP, enabling transparent enhancement of your existing workflows.

```mermaid
graph TD
    A[Claude Code CLI] --> B[MCP Connection]
    B --> C[CGMB Server]
    C --> D[Layer Manager]
    D --> E[Claude Code Layer]
    D --> F[Gemini CLI Layer]  
    D --> G[AI Studio MCP Layer]
    
    E --> H[Complex Reasoning & Workflow Orchestration]
    F --> I[Real-time Grounding & Google Search]
    G --> J[Multimodal Processing & File Conversion]
    
    H --> K[Intelligent Result Synthesis]
    I --> K
    J --> K
    
    K --> L[Enhanced Response to Claude Code]
```

### How It Works

1. **MCP Integration**: CGMB runs as an MCP server that Claude Code can connect to
2. **Transparent Enhancement**: Your existing Claude Code workflows remain unchanged
3. **Intelligent Routing**: CGMB automatically routes tasks to the optimal AI layer
4. **Unified Results**: All responses are synthesized and returned through Claude Code

### Layer Responsibilities

| Layer | Primary Functions | Best For |
|-------|------------------|----------|
| **Claude Code** | Complex reasoning, workflow orchestration, code analysis | Strategic planning, complex logic |
| **Gemini CLI** | Grounding, search, rapid processing | Real-time data, command execution |
| **AI Studio MCP** | Multimodal processing, file conversion | Images, audio, PDFs, documents |

## 🚀 Quick Start

### Installation

**Option 1: NPM Installation (Coming Soon)**
```bash
# When published to NPM (future)
npm install -g claude-gemini-multimodal-bridge
```

**Option 2: Clone and Build (Current Method)**
```bash
# Clone the repository
git clone https://github.com/goodaymmm/claude-gemini-multimodal-bridge.git
cd claude-gemini-multimodal-bridge

# Install dependencies and build
npm install
npm run build

# Make CLI globally available
npm link
```

**Option 3: Direct Usage (No Installation)**
```bash
# Run directly with npx
npx claude-gemini-multimodal-bridge serve

# Or clone and run without global installation
git clone https://github.com/goodaymmm/claude-gemini-multimodal-bridge.git
cd claude-gemini-multimodal-bridge
npm install && npm run build
npm start
```

### Prerequisites

- **Node.js** ≥ 18.0.0
- **Claude Code CLI** installed and configured
- **Gemini CLI** installed and authenticated
- **Google AI Studio API key**

### Setup

```bash
# Run setup wizard
cgmb setup

# Set up authentication for all services
cgmb auth --interactive

# Verify installation and authentication
cgmb verify

# Check quota status before usage
cgmb quota-status

# Start the MCP server
cgmb serve
```

### Configuration

Copy `.env.example` to `.env` and configure:

```bash
# API Keys
GEMINI_API_KEY=your_gemini_api_key_here

# Paths
CLAUDE_CODE_PATH=/usr/local/bin/claude
GEMINI_CLI_PATH=/usr/local/bin/gemini

# Processing Options
GEMINI_MODEL=gemini-2.5-pro
DEFAULT_LAYER_PRIORITY=adaptive
ENABLE_CACHING=true
```

## 📖 Usage

### Basic MCP Tool Usage

```bash
# In Claude Code, call the multimodal processing tool
mcp__cgmb__multimodal_process \
  prompt: "Analyze these documents and extract key insights" \
  files: [{"path": "/path/to/document.pdf", "type": "pdf"}] \
  workflow: "analysis" \
  options: {"quality_level": "balanced"}
```

### Advanced Workflow Example

```typescript
// Custom workflow definition
const workflow = {
  steps: [
    {
      id: "extract_text",
      layer: "aistudio", 
      action: "convert_pdf_to_text",
      input: { files: "@input.files" }
    },
    {
      id: "analyze_content",
      layer: "claude",
      action: "complex_analysis", 
      input: { 
        text: "@extract_text.output",
        analysis_type: "sentiment_and_themes"
      },
      dependsOn: ["extract_text"]
    },
    {
      id: "generate_summary",
      layer: "gemini",
      action: "create_summary",
      input: {
        analysis: "@analyze_content.output",
        format: "executive_summary"
      },
      dependsOn: ["analyze_content"]
    }
  ]
};
```

### Workflow Types

| Type | Description | Use Cases |
|------|-------------|-----------|
| `analysis` | Multi-layer content analysis | Research, insights, evaluation |
| `conversion` | File format conversion | PDF→Markdown, image processing |
| `extraction` | Data extraction from files | Tables, text, metadata |
| `generation` | Content creation | Reports, summaries, presentations |

## 📊 Quota Monitoring & Management

CGMB includes comprehensive API quota monitoring to help you stay within free tier limits and avoid unexpected charges.

### Free Tier Limits (Google AI Studio)

- **Requests**: 15/minute, 1,500/day
- **Tokens**: 32,000/minute, 50,000/day

### Quota Commands

```bash
# Check current quota usage
cgmb quota-status

# Detailed quota breakdown
cgmb quota-status --detailed
```

### Automatic Quota Management

- **Pre-request Validation**: Checks quota before making API calls
- **Smart Warnings**: Alerts at 80% and 90% usage thresholds  
- **Automatic Blocking**: Prevents requests that would exceed limits
- **Reset Tracking**: Monitors daily and per-minute reset times

### Quota Status Examples

```bash
📊 Google AI Studio API Quota Status
=====================================
Tier: FREE

✅ Requests (Daily): 45/1500 (3%)
   Remaining: 1455
   Reset in: 18h

✅ Tokens (Daily): 12450/50000 (25%)
   Remaining: 37550

✅ Overall Status: HEALTHY
```

## 🛠️ API Reference

### Core Tools

#### `multimodal_process`
Process multimodal content through the 3-layer pipeline.

```json
{
  "prompt": "string",
  "files": [{"path": "string", "type": "image|audio|pdf|document"}],
  "workflow": "analysis|conversion|extraction|generation",
  "options": {
    "layer_priority": "claude|gemini|aistudio|adaptive",
    "execution_mode": "sequential|parallel|adaptive", 
    "quality_level": "fast|balanced|quality"
  }
}
```

#### `document_analysis`
Advanced document analysis combining all layers.

```json
{
  "documents": ["string"],
  "analysis_type": "summary|comparison|extraction|translation",
  "output_requirements": "string"
}
```

#### `workflow_orchestration`
Execute complex multi-step workflows.

```json
{
  "workflow_definition": {
    "steps": [/* WorkflowStep[] */],
    "fallbackStrategies": {/* ... */}
  },
  "input_data": {/* any */},
  "execution_mode": "sequential|parallel|adaptive"
}
```

## 📊 Performance & Optimization

### Adaptive Layer Selection

CGMB automatically selects the optimal layer based on:

- **Task complexity**: Simple → Gemini, Complex → Claude
- **Content type**: Multimodal → AI Studio, Text → Gemini
- **Real-time needs**: Urgent → Gemini CLI, Quality → Claude
- **Cost considerations**: Budget-conscious routing

### Caching Strategy

```bash
# Enable intelligent caching
ENABLE_CACHING=true
CACHE_TTL=3600  # 1 hour

# Cache hit rates typically 40-60% for repeated operations
```

### Cost Optimization

- **Free Tier Usage**: Maximizes free quotas across all services
- **Smart Routing**: Routes simple tasks to free/cheaper layers
- **Batch Processing**: Combines multiple operations when possible

## 🔧 Advanced Configuration

### Layer-Specific Settings

```bash
# Claude Code Layer
CLAUDE_CODE_TIMEOUT=300000
CLAUDE_ENABLE_DANGEROUS_MODE=false

# Gemini CLI Layer  
GEMINI_MODEL=gemini-2.5-pro
GEMINI_TIMEOUT=60000
GEMINI_USE_SEARCH=true

# AI Studio Layer
AISTUDIO_MAX_FILES=10
AISTUDIO_MAX_FILE_SIZE=100
AISTUDIO_ENABLE_VISION=true
```

### Custom Workflows

```typescript
import { LayerManager, ExecutionPlan } from 'claude-gemini-multimodal-bridge';

const customWorkflow: ExecutionPlan = {
  steps: [
    // Your custom workflow steps
  ],
  fallbackStrategies: {
    // Fallback configurations
  }
};

const layerManager = new LayerManager(config);
const result = await layerManager.executeWorkflow(customWorkflow, inputData, options);
```

## 🧪 Testing

```bash
# Run all tests
npm test

# Run specific test suites
npm run test:unit
npm run test:integration  
npm run test:e2e

# Test with real APIs
cgmb test --file example.pdf --prompt "Analyze this document"
```

## 🐛 Troubleshooting

### Common Issues

**"Layer not available" errors:**
```bash
# Check layer status and authentication
cgmb verify

# Check authentication status
cgmb auth-status

# Test individual layers
claude --version
gemini --help
```

**API key issues:**
```bash
# Check authentication status
cgmb auth-status --verbose

# Test Gemini API directly
gemini "test prompt"

# Verify environment variables
cgmb detect-paths
```

**Quota exceeded errors:**
```bash
# Check current quota usage
cgmb quota-status

# Wait for quota reset or upgrade plan
# Free tier resets daily
```

**Path detection issues:**
```bash
# Auto-detect CLI tool paths
cgmb detect-paths

# Fix common PATH issues
cgmb detect-paths --fix

# Manual PATH setup
export GEMINI_CLI_PATH=/usr/local/bin/gemini
export CLAUDE_CODE_PATH=/usr/local/bin/claude
```

**Performance issues:**
```bash
# Enable debug logging
LOG_LEVEL=debug cgmb serve

# Check resource usage
htop  # Monitor CPU/memory during processing

# Monitor quota usage
cgmb quota-status --detailed
```

### Debug Mode

```bash
# Enable comprehensive debugging
DEBUG=true LOG_LEVEL=debug cgmb serve --debug
```

## 🤝 Contributing

We welcome contributions! See [CONTRIBUTING.md](docs/CONTRIBUTING.md) for guidelines.

### Development Setup

```bash
git clone https://github.com/yourusername/claude-gemini-multimodal-bridge
cd claude-gemini-multimodal-bridge
npm install
npm run dev
```

### Adding New Layers

```typescript
import { LayerInterface, LayerResult } from './types';

export class MyCustomLayer implements LayerInterface {
  async initialize(): Promise<void> { /* ... */ }
  async execute(task: any): Promise<LayerResult> { /* ... */ }
  // Implement other required methods
}
```

## 📄 License

MIT License - see [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- **Anthropic** for Claude and MCP protocol
- **Google** for Gemini models and AI Studio
- **Community contributors** for feedback and improvements

## 📞 Support

- **Issues**: [GitHub Issues](https://github.com/yourusername/claude-gemini-multimodal-bridge/issues)
- **Discussions**: [GitHub Discussions](https://github.com/yourusername/claude-gemini-multimodal-bridge/discussions)
- **Documentation**: [docs/](docs/)

---

**Built with ❤️ for the AI development community**