# CGMB Enhanced CLI Guide

## 🚀 Overview

This guide covers all CLI commands available in Claude-Gemini Multimodal Bridge v1.0.0, featuring stable multi-layer AI integration, dynamic PDF processing, and enhanced multimodal capabilities.

## 📋 Quick Reference

### Core Commands

| Command | Purpose | Example |
|---------|---------|---------|
| `cgmb chat` | Natural Gemini interaction | `cgmb chat "latest AI trends"` |
| `cgmb c` | Short alias for chat | `cgmb c "explain quantum computing"` |
| `cgmb gemini` | Direct Gemini CLI access | `cgmb gemini "complex query"` |
| `cgmb generate-image` | Generate images with AI Studio | `cgmb generate-image "cute robot" -o robot.png` |
| `cgmb generate-audio` | Generate audio/speech | `cgmb generate-audio "Hello world" -v Puck` |
| `cgmb analyze` | Analyze documents (dynamic PDF processing) | `cgmb analyze document.pdf --type summary` |
| `cgmb multimodal` | Process multiple files | `cgmb multimodal *.png *.pdf --workflow analysis` |

### Authentication & Setup Commands

| Command | Purpose | Example |
|---------|---------|---------|
| `cgmb auth` | Manage authentication | `cgmb auth --interactive` |
| `cgmb auth-status` | Check auth status | `cgmb auth-status --verbose` |
| `cgmb verify` | Verify installation | `cgmb verify --fix` |
| `cgmb setup-mcp` | Setup Claude Code MCP | `cgmb setup-mcp --check` |

---

## 🎯 Natural Chat Interface (NEW)

### Basic Chat Usage

The most user-friendly way to interact with Gemini:

```bash
# Simple questions
cgmb chat "What is quantum computing?"
cgmb c "What is quantum computing?"  # Short alias

# Current information (automatic web search)
cgmb chat "What are the latest AI developments in 2025?"
cgmb c "Current stock market trends"

# Complex queries
cgmb chat "Compare React Native vs Flutter for enterprise apps"
```

**Features**:
- ✅ No need for `-p` flag
- ✅ Automatic web search when needed
- ✅ Natural language interface
- ✅ Smart error handling

---

## 🖼️ Image Generation

### Generate Images with AI Studio

```bash
# Basic image generation (automatic prompt sanitization)
cgmb generate-image "futuristic city skyline at sunset"

# Specify output file
cgmb generate-image "friendly robot assistant" --output robot.png
cgmb generate-image "friendly robot assistant" -o robot.png  # Short form

# Different art styles
cgmb generate-image "mountain landscape" --style photorealistic
cgmb generate-image "abstract art" --style artistic

# Automatic word conversion examples
cgmb generate-image "cute cat"  # → "friendly-looking cat"
cgmb generate-image "adorable puppy"  # → "appealing puppy"
cgmb generate-image "beautiful sunset"  # → "visually pleasing sunset"
```

**Options**:
- `-s, --style <style>`: Art style (photorealistic, cartoon, digital-art)
- `-o, --output <path>`: Save to specific file
- `--safe-mode`: Use safety prefixes (default: true)

**🔤 Automatic Prompt Sanitization**:
CGMB automatically converts problematic words:
- "cute" → "friendly-looking"
- "adorable" → "appealing"
- "beautiful" → "visually pleasing"
- "little" → "small-sized"

**✅ Best Practices**:
- Use specific descriptions: "orange tabby cat" instead of "cute cat"
- Add visual details: colors, patterns, settings
- Professional context: "reference photo", "educational illustration"

**Important Notes**:
- English prompts required (translate if needed)
- Files saved to `output/images/` by default
- Automatic safety prefixes prevent content policy issues
- If generation fails, try more specific descriptions

---

## 🎵 Audio Generation

### Generate Speech from Text

```bash
# Basic text-to-speech
cgmb generate-audio "Welcome to our presentation"

# Choose voice
cgmb generate-audio "Hello, this is Puck speaking" --voice Puck
cgmb generate-audio "Hello, this is Puck speaking" -v Puck  # Short form

# Save to specific file
cgmb generate-audio "Important announcement" --output announcement.wav
cgmb generate-audio "Important announcement" -o announcement.wav  # Short form

# Two-step generation with script
cgmb generate-audio "Create a 30-second podcast intro about AI" --script
```

**Options**:
- `-v, --voice <voice>`: Voice selection (Kore, Puck, etc.)
- `-o, --output <path>`: Output file path
- `--script`: Generate script first, then audio

**Available Voices**:
- Kore (default)
- Puck
- Additional voices supported by gemini-2.5-flash-preview-tts

---

## 📄 Document Analysis

### Analyze Documents with AI

```bash
# Basic document analysis
cgmb analyze report.pdf

# Custom analysis prompt
cgmb analyze research.pdf --prompt "Extract all statistical findings"

# Compare multiple documents
cgmb analyze doc1.pdf doc2.pdf --type compare

# Extract specific information
cgmb analyze contract.pdf --type extract --prompt "Find all payment terms"

# Custom analysis with specific questions
cgmb analyze whitepaper.pdf --prompt "Summarize the methodology section"
```

**Options**:
- `--type <type>`: Analysis type (summary, extract, compare, custom)
- `--prompt <prompt>`: Custom analysis instructions
- `--output <format>`: Output format (text, json, markdown)

---

## 🔄 Multimodal Processing

### Process Multiple Files Together

```bash
# Process mixed file types
cgmb multimodal image1.png document.pdf audio.mp3

# Specify workflow type
cgmb multimodal *.jpg --workflow conversion --output markdown

# Custom processing instructions
cgmb multimodal file1.png file2.pdf --prompt "Create a comprehensive report"

# Batch processing with options
cgmb multimodal images/*.png --workflow analysis --output-dir results/
```

**Options**:
- `--workflow <type>`: Processing workflow (analysis, conversion, extraction, generation)
- `--prompt <prompt>`: Custom instructions
- `--output <format>`: Output format
- `--output-dir <path>`: Output directory

**Supported File Types**:
- Images: PNG, JPG, JPEG, GIF, WEBP
- Documents: PDF, TXT, MD, DOC, DOCX
- Audio: MP3, WAV, M4A, OGG
- Data: JSON, CSV, XML

---

## 🔐 Authentication Management

### Interactive Setup

```bash
# Run interactive authentication wizard
cgmb auth --interactive

# Authenticate specific service
cgmb auth --service gemini --method oauth
cgmb auth --service aistudio --method apikey

# Check authentication status
cgmb auth-status
cgmb auth-status --verbose  # Detailed information
```

### Verify System

```bash
# Basic verification
cgmb verify

# Auto-fix authentication issues
cgmb verify --fix

# Check specific components
cgmb verify --check auth
cgmb verify --check layers
cgmb verify --check dependencies
```

---

## 🛠️ MCP Configuration

### Setup Claude Code Integration

```bash
# Check MCP configuration status
cgmb mcp-status

# Setup MCP integration
cgmb setup-mcp

# Dry run (preview changes)
cgmb setup-mcp --dry-run

# Check without making changes
cgmb setup-mcp --check

# Manual setup instructions
cgmb setup-mcp --manual
```

---

## 📁 File Management (NEW)

### Working with Generated Files

After generating content, you can manage files using:

```bash
# List all generated files
cgmb list-files

# List specific file types
cgmb list-files --type image
cgmb list-files --type audio
cgmb list-files --type document

# Get file information
cgmb file-info output/images/generated-image-2025-01-02.png

# Copy generated file
cgmb get-file output/images/generated-image-2025-01-02.png --output my-image.png
```

**Note**: Generated files are automatically saved to:
- Images: `output/images/`
- Audio: `output/audio/`
- Documents: `output/documents/`

---

## ⚡ Performance Options

### Global Options

Available for all commands:

```bash
# Verbose output
cgmb chat "query" --verbose
cgmb chat "query" -v  # Short form

# Debug mode
cgmb gemini "test" --debug
export CGMB_DEBUG=true  # Enable globally

# Custom timeout
cgmb analyze large-file.pdf --timeout 300000  # 5 minutes

# Disable caching
cgmb chat "query" --no-cache

# Specific model
cgmb gemini "query" --model gemini-2.5-pro
```

---

## 🌐 Web Search

Web search is automatic with Gemini - no special flags needed:

```bash
# These automatically trigger web search when beneficial
cgmb chat "latest news about AI"
cgmb gemini "current weather in Tokyo"
cgmb c "stock price of GOOGL today"

# Keywords that trigger web search:
# - latest, current, today, now, recent
# - news, weather, stock, price
# - trending, updated, breaking
```

---

## 🚨 Troubleshooting

### Common Issues

1. **"Command not found"**
   ```bash
   # Ensure global installation
   npm install -g claude-gemini-multimodal-bridge
   ```

2. **Authentication errors**
   ```bash
   # Run interactive setup
   cgmb auth --interactive
   
   # Check status
   cgmb auth-status --verbose
   ```

3. **Content policy errors**
   ```bash
   # CGMB automatically sanitizes prompts
   cgmb generate-image "cute cat"  # → "friendly-looking cat"
   
   # If still failing, try:
   cgmb generate-image "domestic cat in garden"
   cgmb generate-image "orange tabby cat sitting on grass"
   ```

4. **Timeout errors**
   ```bash
   # Increase timeout
   cgmb analyze large-file.pdf --timeout 300000
   ```

### Debug Mode

Enable detailed logging:

```bash
# For single command
cgmb chat "test" --debug

# Globally
export CGMB_DEBUG=true
export LOG_LEVEL=debug
```

---

## 📚 Examples

### Complete Workflow Example

```bash
# 1. Generate an image
cgmb generate-image "modern office workspace" -o office.png

# 2. Analyze the generated image
cgmb analyze office.png --prompt "Describe the design elements"

# 3. Generate audio description
cgmb generate-audio "A modern office workspace with minimalist design" -o description.wav

# 4. Create comprehensive report
cgmb multimodal office.png description.wav --workflow analysis --output report.md
```

### Batch Processing Example

```bash
# Process all images in a directory
cgmb multimodal images/*.jpg --workflow conversion --output markdown

# Analyze multiple documents
cgmb analyze docs/*.pdf --type compare --output comparison.json

# Generate images from a list
for prompt in "cat" "dog" "bird"; do
  cgmb generate-image "$prompt" -o "animal-$prompt.png"
done
```

---

## 🔗 Quick Links

- **NPM Package**: [npmjs.com/package/claude-gemini-multimodal-bridge](https://www.npmjs.com/package/claude-gemini-multimodal-bridge)
- **GitHub**: [github.com/goodaymmm/claude-gemini-multimodal-bridge](https://github.com/goodaymmm/claude-gemini-multimodal-bridge)
- **Issues**: [GitHub Issues](https://github.com/goodaymmm/claude-gemini-multimodal-bridge/issues)

---

## 📦 Package Information

**Current Status**: Ready for NPM publication
- ✅ genai v1.8.0 migration complete
- ✅ package-lock.json excluded from repository
- ✅ .npmignore configured for clean package distribution
- ✅ All dependencies optimized and conflicts resolved

**Development Setup**:
```bash
git clone <repository>
cd claude-gemini-multimodal-bridge
npm install  # Generates package-lock.json locally
npm run build
npm run dev
```

**Note**: package-lock.json is excluded from repository to prevent merge conflicts. Each environment generates its own lock file during npm install.

---

Last updated: 2025-07-02 | Version: 1.1.0 | genai migration complete