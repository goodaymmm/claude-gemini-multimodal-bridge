#!/bin/bash

# ===================================
# CGMB Setup Script
# ===================================

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Check Node.js version
check_node_version() {
    log_info "Checking Node.js version..."
    
    if ! command_exists node; then
        log_error "Node.js is not installed. Please install Node.js 18.0.0 or higher."
        exit 1
    fi
    
    local node_version=$(node --version | cut -d'v' -f2)
    local required_version="18.0.0"
    
    if [ "$(printf '%s\n' "$required_version" "$node_version" | sort -V | head -n1)" != "$required_version" ]; then
        log_error "Node.js version $node_version is too old. Required: $required_version or higher."
        exit 1
    fi
    
    log_success "Node.js version $node_version is compatible"
}

# Check npm version
check_npm() {
    log_info "Checking npm..."
    
    if ! command_exists npm; then
        log_error "npm is not installed. Please install npm."
        exit 1
    fi
    
    local npm_version=$(npm --version)
    log_success "npm version $npm_version is available"
}

# Install Claude Code CLI
install_claude_code() {
    log_info "Checking Claude Code CLI..."
    
    if command_exists claude; then
        log_success "Claude Code CLI is already installed"
        return 0
    fi
    
    log_warning "Claude Code CLI not found. Please install it manually:"
    echo "  npm install -g @anthropic-ai/claude-code"
    echo "  Or visit: https://docs.anthropic.com/claude/docs/claude-code"
    
    read -p "Have you installed Claude Code CLI? (y/n): " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        if command_exists claude; then
            log_success "Claude Code CLI verified"
        else
            log_error "Claude Code CLI still not found in PATH"
            exit 1
        fi
    else
        log_error "Claude Code CLI is required for CGMB to function"
        exit 1
    fi
}

# Install Gemini CLI
install_gemini_cli() {
    log_info "Checking Gemini CLI..."
    
    if command_exists gemini; then
        log_success "Gemini CLI is already installed"
        return 0
    fi
    
    log_info "Installing Gemini CLI..."
    
    if npm install -g @google/gemini-cli; then
        log_success "Gemini CLI installed successfully"
    else
        log_error "Failed to install Gemini CLI"
        exit 1
    fi
}

# Setup environment file
setup_environment() {
    log_info "Setting up environment configuration..."
    
    if [ ! -f .env ]; then
        if [ -f .env.example ]; then
            cp .env.example .env
            log_success "Created .env file from .env.example"
        else
            log_warning ".env.example not found, creating basic .env file"
            cat > .env << EOF
# Claude-Gemini Multimodal Bridge Configuration
GEMINI_API_KEY=your_gemini_api_key_here
CLAUDE_CODE_PATH=/usr/local/bin/claude
GEMINI_CLI_PATH=/usr/local/bin/gemini
LOG_LEVEL=info
ENABLE_CACHING=true
GEMINI_MODEL=gemini-2.5-flash
EOF
            log_success "Created basic .env file"
        fi
    else
        log_success ".env file already exists"
    fi
    
    log_warning "Please edit the .env file and add your API keys:"
    echo "  - GEMINI_API_KEY: Get from https://aistudio.google.com/"
    echo "  - Update paths if Claude Code or Gemini CLI are installed in non-standard locations"
}

# Create necessary directories
create_directories() {
    log_info "Creating necessary directories..."
    
    mkdir -p logs
    mkdir -p temp
    mkdir -p examples
    
    log_success "Created necessary directories"
}

# Install project dependencies
install_dependencies() {
    log_info "Installing project dependencies..."
    
    if [ -f package.json ]; then
        if npm install; then
            log_success "Project dependencies installed successfully"
        else
            log_error "Failed to install project dependencies"
            exit 1
        fi
    else
        log_warning "package.json not found. Skipping npm install."
    fi
}

# Build project if in development mode
build_project() {
    log_info "Building project..."
    
    if [ -f tsconfig.json ] && [ -d src ]; then
        if npm run build; then
            log_success "Project built successfully"
        else
            log_error "Failed to build project"
            exit 1
        fi
    else
        log_info "TypeScript project not detected, skipping build"
    fi
}

# Verify installation
verify_installation() {
    log_info "Verifying installation..."
    
    # Check if cgmb command is available
    if command_exists cgmb; then
        log_success "CGMB CLI is available"
    elif [ -f dist/cli.js ]; then
        log_success "CGMB built successfully (use: node dist/cli.js)"
    else
        log_warning "CGMB CLI not found, but setup completed"
    fi
    
    # Verify dependencies
    local checks_passed=0
    local total_checks=3
    
    if command_exists claude; then
        log_success "✓ Claude Code CLI"
        ((checks_passed++))
    else
        log_error "✗ Claude Code CLI"
    fi
    
    if command_exists gemini; then
        log_success "✓ Gemini CLI" 
        ((checks_passed++))
    else
        log_error "✗ Gemini CLI"
    fi
    
    if [ -f .env ]; then
        log_success "✓ Environment configuration"
        ((checks_passed++))
    else
        log_error "✗ Environment configuration"
    fi
    
    echo
    log_info "Setup verification: $checks_passed/$total_checks checks passed"
    
    if [ $checks_passed -eq $total_checks ]; then
        log_success "Setup completed successfully!"
    else
        log_warning "Setup completed with warnings. Please address the failed checks above."
    fi
}

# Show next steps
show_next_steps() {
    echo
    log_info "Next steps:"
    echo "1. Edit .env file and add your API keys:"
    echo "   - Get Gemini API key from: https://aistudio.google.com/"
    echo "2. Authenticate Gemini CLI:"
    echo "   gemini auth"
    echo "3. Verify your installation:"
    echo "   cgmb verify"
    echo "4. Start the CGMB server:"
    echo "   cgmb serve"
    echo "5. Read the documentation:"
    echo "   - README.md"
    echo "   - docs/USAGE.md"
    echo
}

# Main setup function
main() {
    echo "=================================================="
    echo "  Claude-Gemini Multimodal Bridge Setup"
    echo "=================================================="
    echo
    
    check_node_version
    check_npm
    install_claude_code
    install_gemini_cli
    install_dependencies
    setup_environment
    create_directories
    build_project
    verify_installation
    show_next_steps
    
    echo
    log_success "CGMB setup completed!"
}

# Run main function
main "$@"