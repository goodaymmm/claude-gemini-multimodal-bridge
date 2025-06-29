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

```mermaid
graph TD
    A[Claude Code] --> B[Layer Manager]
    B --> C[Claude Code Layer]
    B --> D[Gemini CLI Layer]
    B --> E[AI Studio MCP Layer]
    
    C --> F[Complex Reasoning]
    D --> G[Grounding & CLI Tools]
    E --> H[Multimodal Processing]
    
    F --> I[Workflow Orchestration]
    G --> I
    H --> I
    
    I --> J[Unified Results]
```

### Layer Responsibilities

| Layer | Primary Functions | Best For |
|-------|------------------|----------|
| **Claude Code** | Complex reasoning, workflow orchestration, code analysis | Strategic planning, complex logic |
| **Gemini CLI** | Grounding, search, rapid processing | Real-time data, command execution |
| **AI Studio MCP** | Multimodal processing, file conversion | Images, audio, PDFs, documents |

## 🚀 Quick Start

### Installation

```bash
# Install globally
npm install -g claude-gemini-multimodal-bridge

# Or clone and build
git clone https://github.com/yourusername/claude-gemini-multimodal-bridge
cd claude-gemini-multimodal-bridge
npm install
npm run build
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

# Verify installation
cgmb verify

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
GEMINI_MODEL=gemini-2.5-flash
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
GEMINI_MODEL=gemini-2.5-flash
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
# Check layer status
cgmb verify

# Test individual layers
claude --version
gemini --help
```

**API key issues:**
```bash
# Verify API keys are set
cgmb info

# Test Gemini API directly
gemini "test prompt"
```

**Performance issues:**
```bash
# Enable debug logging
LOG_LEVEL=debug cgmb serve

# Check resource usage
htop  # Monitor CPU/memory during processing
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