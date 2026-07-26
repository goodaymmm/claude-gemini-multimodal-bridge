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

# Check for the Antigravity CLI (agy)
#
# agy is not on npm: the only supported install is a remote shell script, and
# sign-in is interactive. Running the installer unattended from here would
# execute remote code the user never saw and still leave an unauthenticated
# CLI, so print the command and let them run it.
check_antigravity_cli() {
    log_info "Checking Antigravity CLI (agy)..."

    if command_exists agy; then
        log_success "Antigravity CLI (agy) is already installed"
        return 0
    fi

    log_warning "Antigravity CLI (agy) not found - the web-search layer needs it"
    echo "  1. curl -fsSL https://antigravity.google/cli/install.sh | bash"
    echo "  2. Run 'agy' once and complete the Google sign-in"
    echo "  Requires agy 1.1.7 or newer"
    echo "  Docs: https://antigravity.google/docs/cli/install"
    return 1
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
AI_STUDIO_API_KEY=your_ai_studio_api_key_here
CLAUDE_CODE_PATH=/usr/local/bin/claude
# Path to the Antigravity CLI (agy). Leave unset to auto-detect.
# ANTIGRAVITY_CLI_PATH=
LOG_LEVEL=info
ENABLE_CACHING=true
# Antigravity model for the search layer - must match \`agy models\`
ANTIGRAVITY_MODEL=gemini-3.6-flash-low
EOF
            log_success "Created basic .env file"
        fi
    else
        log_success ".env file already exists"
    fi
    
    log_warning "Please edit the .env file and add your API keys:"
    echo "  - AI_STUDIO_API_KEY: Get from https://aistudio.google.com/app/apikey"
    echo "  - Update paths if Claude Code or the Antigravity CLI are installed in non-standard locations"
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
    
    if command_exists agy; then
        log_success "✓ Antigravity CLI (agy)"
        ((checks_passed++))
    else
        log_error "✗ Antigravity CLI (agy)"
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
    echo "   - Get an AI Studio API key from: https://aistudio.google.com/app/apikey"
    echo "2. Sign in to the Antigravity CLI:"
    echo "   agy          # run once, then complete the Google sign-in"
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
    check_antigravity_cli || true
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