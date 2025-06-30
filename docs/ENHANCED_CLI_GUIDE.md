# CGMB Enhanced CLI Guide

## 🚀 Overview

This guide covers the enhanced CLI commands that resolve the issues identified in Error.md, Error2.md, and Error3.md. CGMB now provides seamless, direct access to all AI layers without unnecessary intermediate steps.

## 📋 Quick Reference

### Core Commands

| Command | Purpose | Example |
|---------|---------|---------|
| `cgmb test` | Enhanced multimodal testing | `cgmb test -p "analyze this" -f document.pdf` |
| `cgmb gemini` | Direct Gemini CLI access | `cgmb gemini -p "latest AI trends" --search` |
| `cgmb aistudio` | Direct AI Studio processing | `cgmb aistudio -p "create infographic" -f image1.png` |
| `cgmb process` | Intelligent layer routing | `cgmb process -p "comprehensive analysis" -w analysis` |
| `cgmb verify` | System verification | `cgmb verify --fix` |

---

## 🔍 Enhanced Commands

### 1. Enhanced Test Command

**Fixed Issue**: Previously only performed initialization without actual processing (Error.md lines 114-122)

```bash
# Text-only processing
cgmb test -p "Analyze Android app monetization strategies for 2024-2025"

# File processing  
cgmb test -f project_document.pdf -p "Extract key insights and recommendations"

# Custom timeout
cgmb test -p "Complex analysis task" --timeout 180000
```

**Key Improvements**:
- ✅ Actual multimodal processing (not just initialization)
- ✅ Real results returned with processing details
- ✅ No more timeout issues
- ✅ Support for both text and file inputs

### 2. Direct Gemini CLI Command

**Fixed Issue**: Eliminated "unknown command 'gemini-chat'" errors (Error.md lines 1-2)

```bash
# Basic search query
cgmb gemini -p "What are the latest trends in mobile development?"

# With search/grounding enabled
cgmb gemini -p "2024年のAI技術動向について教えてください" --search

# File analysis
cgmb gemini -p "Analyze this project plan" -f project.txt

# Custom model
cgmb gemini -p "Technical analysis" -m gemini-2.5-pro
```

**Key Improvements**:
- ✅ No more "unknown command" errors
- ✅ Direct Gemini CLI integration
- ✅ Search and grounding functionality
- ✅ File processing support
- ✅ Proper command syntax

### 3. Direct AI Studio Command  

**Fixed Issue**: Resolved aistudio-mcp-server dependency failures (Error3.md lines 73-76)

```bash
# Image/content generation
cgmb aistudio -p "Create a business infographic showing revenue trends"

# Multi-file processing
cgmb aistudio -p "Analyze these documents" -f doc1.pdf doc2.txt image1.png

# Custom model selection
cgmb aistudio -p "Generate technical diagram" -m gemini-2.0-flash-exp
```

**Key Improvements**:
- ✅ No more aistudio-mcp-server dependency issues
- ✅ Direct AI Studio API integration
- ✅ Multi-file processing
- ✅ Faster response times
- ✅ Fallback mode for reliability

### 4. Intelligent Processing Command

**New Feature**: Automated layer routing for optimal results

```bash
# Adaptive processing (recommended)
cgmb process -p "Create comprehensive market analysis" -f data.csv --strategy adaptive

# Workflow-specific processing
cgmb process -p "Extract insights" -w extraction -f document.pdf

# Layer-priority processing
cgmb process -p "Generate summary" --strategy claude-first -f report.txt

# Multiple files with analysis workflow
cgmb process -p "Compare these documents" -f doc1.pdf doc2.txt -w analysis
```

**Workflow Types**:
- `analysis` - Document and content analysis
- `generation` - Content creation and synthesis  
- `conversion` - Format conversion and transformation
- `extraction` - Data extraction and structuring

**Processing Strategies**:
- `adaptive` - Intelligent layer selection (recommended)
- `claude-first` - Prioritize Claude Code for reasoning
- `gemini-first` - Prioritize Gemini CLI for search/grounding
- `aistudio-first` - Prioritize AI Studio for multimodal

---

## 🔧 System Commands

### Enhanced Verification

```bash
# Basic system check
cgmb verify

# Auto-fix authentication issues
cgmb verify --fix

# Check authentication status
cgmb auth-status --verbose

# Detect CLI tool paths
cgmb detect-paths --fix
```

### Setup and Configuration

```bash
# Initial setup
cgmb setup

# MCP integration setup
cgmb setup-mcp

# Check MCP status
cgmb mcp-status

# Interactive authentication
cgmb auth --interactive
```

### Monitoring and Diagnostics

```bash
# System information
cgmb info --env

# API quota status
cgmb quota-status --detailed

# Setup guide
cgmb setup-guide
```

---

## 📊 Real-World Examples

### 1. Business Analysis (Error.md Example - Fixed)

**Problem**: Original command failed with "unknown command 'gemini-chat'"

**Solution**:
```bash
# Now works perfectly
cgmb gemini -p "Androidアプリのマネタイズ戦略について最新のトレンドを含めて教えてください。特に2024-2025年の動向について詳しく説明してください。" --search
```

### 2. Image Generation (Error3.md Example - Fixed)

**Problem**: aistudio-mcp-server verification failed, command timed out

**Solution**:
```bash
# Now works with direct API integration
cgmb aistudio -p "Create a professional infographic showing the 'Adaptive Value Monetization (AVM)' strategy for Android apps. Include subscription tiers, AI-driven personalization, reward advertising, micro-transactions, and revenue structure pie chart."
```

### 3. Multi-Step Workflow

**Problem**: Manual coordination between different tools

**Solution**:
```bash
# Automated multi-layer processing
cgmb process -p "Analyze market trends, create visualization, and generate business recommendations" -w generation --strategy adaptive
```

---

## 🚨 Error Resolution Guide

### Common Issues and Solutions

#### 1. "Unknown command" errors
**Before**: `cgmb gemini-chat "question"` ❌  
**After**: `cgmb gemini -p "question"` ✅

#### 2. Timeout issues
**Before**: Commands hung during initialization  
**After**: Actual processing with configurable timeouts using `--timeout`

#### 3. MCP dependency failures
**Before**: aistudio-mcp-server required and often failed  
**After**: Direct API integration with fallback modes

#### 4. Authentication problems
**Before**: Manual troubleshooting required  
**After**: Use `cgmb verify --fix` for automated resolution

---

## 📈 Performance Comparisons

| Operation | Before (Error.md) | After (Enhanced) |
|-----------|-------------------|-------------------|
| Gemini CLI access | ❌ Failed | ✅ Direct integration |
| AI Studio processing | ❌ Timeout | ✅ Fast processing |
| Multi-file analysis | ❌ Not supported | ✅ Fully supported |
| Error recovery | ❌ Manual intervention | ✅ Automated fallbacks |
| User experience | ❌ Frustrating | ✅ Seamless |

---

## 🎯 Best Practices

### 1. Command Selection

- **Simple text questions**: Use `cgmb gemini`
- **Image/document analysis**: Use `cgmb aistudio`  
- **Complex multi-step tasks**: Use `cgmb process`
- **Testing and validation**: Use `cgmb test`

### 2. Error Handling

- Always run `cgmb verify` before important operations
- Use `--timeout` for long-running tasks
- Check `cgmb auth-status` if authentication errors occur
- Use `cgmb info` to debug environment issues

### 3. Performance Optimization

- Use `--strategy adaptive` for best results
- Specify appropriate workflow types (`-w analysis|generation|conversion|extraction`)
- Monitor quota usage with `cgmb quota-status`
- Use file processing for better context

---

## 🔗 Integration Examples

### Example Scripts

See the `examples/` directory for complete demonstrations:

- `examples/android_monetization.js` - Business analysis workflow
- `examples/gemini_search_demo.js` - Gemini CLI integration
- `examples/aistudio_image_demo.js` - AI Studio processing

### Running Examples

```bash
# Make examples executable
chmod +x examples/*.js

# Run Android monetization analysis
node examples/android_monetization.js

# Test Gemini CLI integration
node examples/gemini_search_demo.js

# Demonstrate AI Studio capabilities
node examples/aistudio_image_demo.js
```

---

## 📞 Support and Troubleshooting

### Quick Diagnostics

```bash
# Full system check
cgmb verify

# Check all dependencies
./scripts/verify-dependencies.sh

# Test basic functionality
cgmb test -p "Hello, CGMB!"
```

### Common Solutions

1. **Authentication issues**: `cgmb auth --interactive`
2. **Path problems**: `cgmb detect-paths --fix`
3. **MCP not working**: `cgmb setup-mcp`
4. **Performance issues**: `cgmb quota-status --detailed`

### Getting Help

```bash
# Command help
cgmb --help
cgmb <command> --help

# System information
cgmb info

# Setup guidance
cgmb setup-guide
```

---

**Document Version**: 1.0.0  
**Last Updated**: 2025-06-30  
**Compatibility**: CGMB v1.0.0+

This guide demonstrates how CGMB has evolved from the problematic state shown in Error.md/Error2.md/Error3.md to a production-ready, user-friendly multimodal AI integration platform.