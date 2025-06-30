#!/usr/bin/env node

/**
 * CGMB Post-install Script
 * Automatically installs required dependencies and sets up integrations
 */

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Color codes for console output
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m'
};

// Logging functions
function log(message, level = 'info') {
  const timestamp = new Date().toISOString().substring(11, 19);
  const prefix = {
    info: `${colors.blue}[INFO]${colors.reset}`,
    success: `${colors.green}[SUCCESS]${colors.reset}`,
    warning: `${colors.yellow}[WARNING]${colors.reset}`,
    error: `${colors.red}[ERROR]${colors.reset}`
  };
  
  console.log(`${timestamp} ${prefix[level]} ${message}`);
}

// Check if command exists
function commandExists(command) {
  try {
    execSync(`which ${command}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Install package with error handling
async function installPackage(packageName, description) {
  log(`Installing ${description}...`);
  
  return new Promise((resolve) => {
    const child = spawn('npm', ['install', '-g', packageName], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    let output = '';
    let errorOutput = '';
    
    child.stdout.on('data', (data) => {
      output += data.toString();
    });
    
    child.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });
    
    child.on('close', (code) => {
      if (code === 0) {
        log(`✅ ${description} installed successfully`, 'success');
        resolve(true);
      } else {
        // Check if it's just a warning (package already exists)
        if (errorOutput.includes('EEXIST') || errorOutput.includes('already exists')) {
          log(`✅ ${description} already installed`, 'success');
          resolve(true);
        } else {
          log(`⚠️ Failed to install ${description}: ${errorOutput.trim()}`, 'warning');
          log(`📋 You can install it manually: npm install -g ${packageName}`, 'info');
          resolve(false);
        }
      }
    });
    
    // Handle installation timeout (60 seconds)
    setTimeout(() => {
      child.kill('SIGTERM');
      log(`⏰ Installation of ${description} timed out`, 'warning');
      log(`📋 You can install it manually: npm install -g ${packageName}`, 'info');
      resolve(false);
    }, 60000);
  });
}

// Check and install AI Studio MCP Server
async function setupAIStudioMCP() {
  log('🔧 Setting up AI Studio MCP Server...');
  
  // Check if aistudio-mcp-server is available
  if (commandExists('aistudio-mcp-server')) {
    log('✅ AI Studio MCP Server already available', 'success');
    return true;
  }
  
  // Try to find it in node_modules
  const possiblePaths = [
    path.join(process.cwd(), 'node_modules', '.bin', 'aistudio-mcp-server'),
    path.join(__dirname, '..', 'node_modules', '.bin', 'aistudio-mcp-server')
  ];
  
  for (const testPath of possiblePaths) {
    if (fs.existsSync(testPath)) {
      log('✅ AI Studio MCP Server found in project dependencies', 'success');
      return true;
    }
  }
  
  // Install globally
  log('📦 AI Studio MCP Server not found, attempting installation...');
  const success = await installPackage('aistudio-mcp-server', 'AI Studio MCP Server');
  
  if (!success) {
    log('💡 AI Studio MCP Server installation failed. This is optional for basic functionality.', 'warning');
    log('   You can install it later with: npm install -g aistudio-mcp-server', 'info');
  }
  
  return success;
}

// Check and install Gemini CLI
async function setupGeminiCLI() {
  log('🔧 Checking Gemini CLI...');
  
  if (commandExists('gemini')) {
    log('✅ Gemini CLI already installed', 'success');
    return true;
  }
  
  log('📦 Gemini CLI not found, attempting installation...');
  const success = await installPackage('@google/gemini-cli', 'Gemini CLI');
  
  if (!success) {
    log('💡 Gemini CLI installation failed. You can install it later:', 'warning');
    log('   npm install -g @google/gemini-cli', 'info');
  }
  
  return success;
}

// Check Claude Code CLI
function checkClaudeCode() {
  log('🔧 Checking Claude Code CLI...');
  
  if (commandExists('claude')) {
    log('✅ Claude Code CLI found', 'success');
    return true;
  }
  
  log('⚠️ Claude Code CLI not found', 'warning');
  log('📋 Please install Claude Code CLI:', 'info');
  log('   npm install -g @anthropic-ai/claude-code', 'info');
  log('   Or visit: https://docs.anthropic.com/claude/docs/claude-code', 'info');
  
  return false;
}

// Setup environment file
function setupEnvironment() {
  log('🔧 Setting up environment configuration...');
  
  const envPath = path.join(process.cwd(), '.env');
  const envExamplePath = path.join(process.cwd(), '.env.example');
  
  if (fs.existsSync(envPath)) {
    log('✅ .env file already exists', 'success');
    return true;
  }
  
  let envContent = '';
  
  if (fs.existsSync(envExamplePath)) {
    envContent = fs.readFileSync(envExamplePath, 'utf8');
    log('📄 Using .env.example as template', 'info');
  } else {
    envContent = `# Claude-Gemini Multimodal Bridge Configuration
# Get your API key from: https://aistudio.google.com/app/apikey

GEMINI_API_KEY=your_gemini_api_key_here
AI_STUDIO_API_KEY=\${GEMINI_API_KEY}

# Optional: Customize paths if needed
CLAUDE_CODE_PATH=/usr/local/bin/claude
GEMINI_CLI_PATH=/usr/local/bin/gemini

# Logging and performance
LOG_LEVEL=info
ENABLE_CACHING=true
GEMINI_MODEL=gemini-2.0-flash-exp
`;
    log('📄 Creating basic .env template', 'info');
  }
  
  try {
    fs.writeFileSync(envPath, envContent, 'utf8');
    log('✅ Created .env file', 'success');
    log('📝 Please edit .env and add your API keys', 'info');
    return true;
  } catch (error) {
    log(`❌ Failed to create .env file: ${error.message}`, 'error');
    return false;
  }
}

// Setup MCP integration
async function setupMCPIntegration() {
  log('🔧 Setting up Claude Code MCP integration...');
  
  try {
    // Try to run cgmb setup-mcp
    const cgmbPath = path.join(process.cwd(), 'dist', 'cli.js');
    
    if (fs.existsSync(cgmbPath)) {
      execSync(`node ${cgmbPath} setup-mcp`, { stdio: 'inherit' });
      log('✅ MCP integration configured', 'success');
      return true;
    } else {
      log('⚠️ CGMB not built yet. Run "npm run build" then "cgmb setup-mcp"', 'warning');
      return false;
    }
  } catch (error) {
    log('⚠️ MCP integration setup failed. You can set it up later with: cgmb setup-mcp', 'warning');
    return false;
  }
}

// Show completion summary
function showCompletionSummary(results) {
  console.log('\n' + '='.repeat(60));
  log('🎉 CGMB Post-install Setup Complete!', 'success');
  console.log('='.repeat(60));
  
  // Summary of what was installed
  console.log('\n📊 Installation Summary:');
  Object.entries(results).forEach(([component, success]) => {
    const status = success ? '✅' : '❌';
    console.log(`   ${status} ${component}`);
  });
  
  console.log('\n📋 Next Steps:');
  console.log('1. Edit .env file and add your API keys:');
  console.log('   - Get Gemini API key: https://aistudio.google.com/app/apikey');
  console.log('2. Build the project (if in development):');
  console.log('   npm run build');
  console.log('3. Verify installation:');
  console.log('   cgmb verify');
  console.log('4. Set up authentication:');
  console.log('   cgmb auth --interactive');
  
  if (!results['MCP Integration']) {
    console.log('5. Set up Claude Code MCP integration:');
    console.log('   cgmb setup-mcp');
  }
  
  console.log('\n💡 For help and documentation:');
  console.log('   cgmb --help');
  console.log('   cgmb setup-guide');
  
  console.log('\n🚀 Ready to use CGMB!');
}

// Main setup function
async function main() {
  console.log('\n' + '='.repeat(60));
  log('🚀 CGMB Post-install Setup Starting...', 'info');
  console.log('='.repeat(60) + '\n');
  
  const results = {};
  
  // Check system requirements
  log('📋 Checking system requirements...');
  
  // Check Node.js version
  const nodeVersion = process.version;
  const requiredNodeVersion = 'v18.0.0';
  if (nodeVersion >= requiredNodeVersion) {
    log(`✅ Node.js ${nodeVersion} (meets requirement: ${requiredNodeVersion}+)`, 'success');
  } else {
    log(`❌ Node.js ${nodeVersion} is too old. Required: ${requiredNodeVersion}+`, 'error');
    process.exit(1);
  }
  
  // Setup components
  try {
    results['Claude Code CLI'] = checkClaudeCode();
    results['Gemini CLI'] = await setupGeminiCLI();
    results['AI Studio MCP'] = await setupAIStudioMCP();
    results['Environment Config'] = setupEnvironment();
    results['MCP Integration'] = await setupMCPIntegration();
    
    // Show completion summary
    showCompletionSummary(results);
    
  } catch (error) {
    log(`❌ Setup failed with error: ${error.message}`, 'error');
    log('🔧 You can complete setup manually using:', 'info');
    log('   cgmb auth --interactive', 'info');
    log('   cgmb setup-mcp', 'info');
    process.exit(1);
  }
}

// Handle process termination
process.on('SIGINT', () => {
  log('\n⚠️ Setup interrupted by user', 'warning');
  log('🔧 You can complete setup later with:', 'info');
  log('   cgmb auth --interactive', 'info');
  process.exit(1);
});

process.on('SIGTERM', () => {
  log('\n⚠️ Setup terminated', 'warning');
  process.exit(1);
});

// Skip postinstall in CI environments
if (process.env.CI || process.env.CONTINUOUS_INTEGRATION) {
  log('🔄 CI environment detected, skipping interactive setup', 'info');
  process.exit(0);
}

// Skip postinstall during npm publish
if (process.env.npm_lifecycle_event === 'prepublish' || process.env.npm_lifecycle_event === 'prepare') {
  log('📦 Publish process detected, skipping setup', 'info');
  process.exit(0);
}

// Run main setup
main().catch((error) => {
  log(`❌ Unexpected error: ${error.message}`, 'error');
  process.exit(1);
});