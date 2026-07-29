#!/usr/bin/env node

/**
 * CGMB Post-install Script
 * Automatically installs required dependencies and sets up integrations
 */

const { execFileSync, execSync } = require('child_process');
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
// `which` does not exist on Windows outside a POSIX shell, so every probe used
// to report "missing" there and postinstall recommended installs that were
// already present.
function commandExists(command) {
  const lookup = process.platform === 'win32' ? 'where' : 'which';
  try {
    execSync(`${lookup} ${command}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Install package with error handling
// installPackage() lived here and did `spawn('npm', ['install','-g',...])` with
// no 'error' listener. On Windows npm is npm.cmd, which spawn cannot launch
// without a shell, so it raised ENOENT -- and an unhandled 'error' event took
// the whole postinstall down with it. That is what made `npm link` fail.
//
// Its only caller installed `aistudio-mcp-server` globally, which CGMB does not
// use: AIStudioLayer.resolveMCPServerPath() spawns the server bundled in this
// package at dist/mcp-servers/ai-studio-mcp-server.js. The remaining mentions of
// the external package are troubleshooting text. Both the function and the
// install went together.

// Check and install AI Studio MCP Server
function setupAIStudioMCP() {
  log('🔧 Checking the bundled AI Studio MCP Server...');

  // The server CGMB actually runs ships with this package. Nothing needs
  // installing; what matters is that the build produced it, because
  // AIStudioLayer spawns exactly this file.
  const bundled = path.join(__dirname, '..', 'dist', 'mcp-servers', 'ai-studio-mcp-server.js');

  if (fs.existsSync(bundled)) {
    log('✅ AI Studio MCP Server present', 'success');
    return true;
  }

  log('⚠️ AI Studio MCP Server is missing from this install', 'warning');
  log(`   Expected at: ${bundled}`, 'info');
  log('   Run `npm run build` in the package directory to produce it.', 'info');
  return false;
}

const MIN_AGY_VERSION = '1.1.7';

/** Read `agy --version`, or undefined when it cannot be determined. */
function agyVersion(agyPath) {
  try {
    const out = execFileSync(agyPath, ['--version'], {
      encoding: 'utf8',
      timeout: 10000,
      stdio: 'pipe',
      windowsHide: true,
    });
    return out.trim().split('\n')[0].trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve `agy` to a trusted absolute path, or undefined.
 *
 * Mirrors src/utils/processUtils.ts. This script cannot import it -- npm runs
 * postinstall before the TypeScript build exists -- so the check is duplicated
 * rather than skipped.
 *
 * Both `where` and a bare-name spawn can resolve inside the working directory
 * on Windows, so `npm install` alone would otherwise execute an agy.exe
 * committed to a repository, inheriting the postinstall environment.
 */
function resolveTrustedAgy() {
  const realpathOrSelf = target => {
    try {
      return fs.realpathSync(target);
    } catch {
      return target;
    }
  };

  const cwd = realpathOrSelf(path.resolve(process.cwd()));
  const isUntrusted = candidate => {
    const resolved = realpathOrSelf(path.resolve(candidate));
    const rel = path.relative(cwd, resolved);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };

  const helper = process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'where.exe')
    : '/usr/bin/which';

  try {
    const output = execFileSync(helper, ['agy'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: 'pipe',
      windowsHide: true,
    });

    for (const line of output.split('\n')) {
      const candidate = line.trim();
      if (candidate !== '' && !isUntrusted(candidate)) {
        return candidate;
      }
    }
  } catch {
    // fall through to undefined
  }

  return undefined;
}

/** Compare dotted versions: isVersionAtLeast('1.1.7', '1.1.7') === true */
function isVersionAtLeast(actual, minimum) {
  const toParts = v => v.trim().replace(/^v/i, '').split('.').map(p => parseInt(p, 10) || 0);
  const a = toParts(actual);
  const b = toParts(minimum);

  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) {
      return x > y;
    }
  }

  return true;
}

// Check for the Antigravity CLI (`agy`)
//
// Deliberately detect-and-instruct rather than auto-install. Google
// discontinued Gemini CLI for individual accounts on 2026-06-18 and `agy` is
// not distributed on npm -- the only supported install is a remote shell
// script. Piping that into a shell from a postinstall hook would execute
// remote code during `npm install` without the user ever seeing it, so we tell
// them what to run instead. Sign-in is interactive anyway, so an unattended
// install would not produce a working layer.
function setupAntigravityCLI() {
  log('🔧 Checking Antigravity CLI (agy)...');

  const installHint = process.platform === 'win32'
    ? 'irm https://antigravity.google/cli/install.ps1 | iex'
    : 'curl -fsSL https://antigravity.google/cli/install.sh | bash';

  // Existence and the version probe must agree on one verified path. Checking
  // with commandExists and then probing by bare name resolved twice, and the
  // second resolution had no trust check at all.
  const agyPath = resolveTrustedAgy();

  if (agyPath) {
    // Presence alone is not enough: builds before 1.1.7 print nothing when
    // stdout is not a terminal and still exit 0, so CGMB would silently
    // receive empty answers. Report that as a problem now rather than at
    // runtime.
    const version = agyVersion(agyPath);

    if (version && isVersionAtLeast(version, MIN_AGY_VERSION)) {
      log(`✅ Antigravity CLI (agy) ${version} found`, 'success');
      return true;
    }

    log(
      `⚠️ Antigravity CLI ${version ?? '(version unknown)'} is older than the required ${MIN_AGY_VERSION}`,
      'warning'
    );
    log('   Older builds emit nothing when stdout is not a terminal.', 'info');
    log('   Update with: agy update', 'info');
    return false;
  }

  log('⚠️ Antigravity CLI (agy) not found', 'warning');
  log('📋 The web-search layer needs it. Install and sign in:', 'info');
  log(`   1. ${installHint}`, 'info');
  log('   2. Run `agy` once and complete the Google sign-in', 'info');
  log('   Requires agy 1.1.7 or newer; docs: https://antigravity.google/docs/cli/install', 'info');

  return false;
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
# Path to the Antigravity CLI (agy). Leave unset to auto-detect.
# ANTIGRAVITY_CLI_PATH=

# Logging and performance
LOG_LEVEL=info
ENABLE_CACHING=true
# Antigravity model for the search layer - must match \`agy models\`
ANTIGRAVITY_MODEL=gemini-3.6-flash-low
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

// Detect Node.js environment
async function detectNodeEnvironment() {
  try {
    // Use the CLI shipped in this package, not whatever `where cgmb` finds.
    //
    // On Windows npm's global bin is cgmb.cmd, and the MCP configuration stores
    // this value as a script argument to node.exe -- producing
    // `node cgmb.cmd serve`, which fails with a SyntaxError. The check only
    // asserted the value was non-empty, so postinstall reported "configured"
    // for a configuration that could never start. __dirname is inside the
    // installed package, so dist/cli.js is unambiguous and directly runnable.
    const cgmbPath = path.join(__dirname, '..', 'dist', 'cli.js');
    const nodePath = process.execPath; // Current Node.js path

    if (!fs.existsSync(cgmbPath)) {
      throw new Error('dist/cli.js is not present; build the package first');
    }
    
    return {
      cgmbPath,
      nodePath,
      isNvm: cgmbPath.includes('.nvm'),
      isNodebrew: cgmbPath.includes('.nodebrew'),
      isVolta: cgmbPath.includes('.volta'),
      detected: true
    };
  } catch (error) {
    return { detected: false };
  }
}

// Setup MCP integration with environment detection
async function setupMCPIntegration() {
  log('🔧 Setting up Claude Code MCP integration...');
  
  // Skip MCP setup if CGMB is being started in serve mode to prevent Claude Code duplication
  if (process.env.CGMB_SERVE_MODE === 'true' || 
      process.env.CGMB_NO_CLAUDE_EXEC === 'true' ||
      process.argv.includes('serve')) {
    log('🔄 Serve mode detected, skipping MCP setup to prevent Claude Code duplication', 'info');
    log('💡 Run "cgmb setup-mcp" manually after server setup if needed', 'info');
    return true;
  }
  
  // Detect Node.js environment
  const env = await detectNodeEnvironment();
  
  if (env.detected && (env.isNvm || env.isNodebrew || env.isVolta)) {
    log('🔍 Detected Node.js version manager environment', 'info');
    log(`   Node.js path: ${env.nodePath}`, 'info');
    log(`   CGMB path: ${env.cgmbPath}`, 'info');
    
    // Set environment variables for MCP configuration
    process.env.CGMB_DETECTED_PATH = env.cgmbPath;
    process.env.CGMB_DETECTED_NODE_PATH = env.nodePath;
  }
  
  try {
    // Run the CLI that ships with THIS package, by absolute path.
    //
    // `execSync('cgmb setup-mcp --force')` resolved a bare name through a
    // shell, so npm's node_modules/.bin -- or the current directory on
    // Windows -- could supply a different `cgmb`, and `npm install` alone would
    // run it with this environment and permission to rewrite MCP config. The
    // fallback interpolated a cwd-derived path into an unquoted shell string
    // as well. __dirname is inside the installed package, so this is the copy
    // that was just installed.
    const cliPath = path.join(__dirname, '..', 'dist', 'cli.js');

    if (!fs.existsSync(cliPath)) {
      log('⚠️ CGMB is not built yet. Run "npm run build" then "cgmb setup-mcp"', 'warning');
      return false;
    }

    try {
      execFileSync(process.execPath, [cliPath, 'setup-mcp', '--force'], {
        stdio: 'inherit',
        windowsHide: true,
        env: {
          ...process.env,
          CGMB_MCP_SETUP_ONLY: 'true',
          CGMB_DETECTED_PATH: env.cgmbPath || '',
          CGMB_DETECTED_NODE_PATH: env.nodePath || ''
        }
      });

      log('✅ MCP integration configured', 'success');

      if (env.detected && (env.isNvm || env.isNodebrew || env.isVolta)) {
        log('✅ MCP configuration updated for your Node.js environment', 'success');
      }

      return true;
    } catch (setupError) {
      log(`⚠️ MCP setup did not complete: ${setupError.message}`, 'warning');
      log('   Run it manually with: cgmb setup-mcp', 'info');
      return false;
    }
  } catch (error) {
    log('⚠️ MCP integration setup failed. You can set it up later with: cgmb setup-mcp --force', 'warning');
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

/**
 * The major version package.json actually requires.
 *
 * Read rather than hardcoded, so the check and the declaration cannot drift --
 * which is exactly what had happened: engines said >=22, this script said v18.
 */
function requiredNodeMajor() {
  try {
    const declared = require('../package.json').engines?.node ?? '';
    const match = /(\d+)/.exec(declared);
    if (match) {
      return Number.parseInt(match[1], 10);
    }
  } catch {
    // Fall through to the conservative default below.
  }
  return 22;
}

/**
 * Numeric comparison of the running Node against the required major.
 *
 * Exported for tests. Takes the version as a parameter rather than reading
 * process.versions so the unsupported cases can be exercised without an
 * unsupported Node to run them on.
 */
function checkNodeVersion(version, requiredMajor) {
  const major = Number.parseInt(String(version).replace(/^v/i, '').split('.')[0], 10);
  return {
    ok: Number.isFinite(major) && major >= requiredMajor,
    major,
    required: requiredMajor,
  };
}

module.exports = { checkNodeVersion, requiredNodeMajor };

// Main setup function
async function main() {
  console.log('\n' + '='.repeat(60));
  log('🚀 CGMB Post-install Setup Starting...', 'info');
  console.log('='.repeat(60) + '\n');
  
  const results = {};
  
  // Check system requirements
  log('📋 Checking system requirements...');
  
  // Check Node.js version before anything writes configuration.
  //
  // This used to compare version strings with `>=`, against a hardcoded v18
  // while package.json requires 22. Both halves were wrong. The threshold let
  // an unsupported Node through, and the setup below then pinned *that* Node's
  // process.execPath into the user's Claude Code config -- so the install
  // reported success and the server failed later, at first use, for reasons
  // that pointed nowhere near the install. The string comparison was broken
  // independently: 'v9.0.0' >= 'v18.0.0' is true, because '9' > '1'.
  const nodeCheck = checkNodeVersion(process.versions.node, requiredNodeMajor());
  if (nodeCheck.ok) {
    log(`✅ Node.js v${process.versions.node} (meets requirement: v${nodeCheck.required}+)`, 'success');
  } else {
    log(`❌ Node.js v${process.versions.node} is too old. Required: v${nodeCheck.required}+`, 'error');
    log('   No configuration was written. Install a supported Node.js and reinstall CGMB.', 'error');
    process.exit(1);
  }

  // Setup components
  try {
    results['Claude Code CLI'] = checkClaudeCode();
    results['Antigravity CLI'] = setupAntigravityCLI();
    results['AI Studio MCP'] = setupAIStudioMCP();
    results['Environment Config'] = setupEnvironment();
    results['MCP Integration'] = await setupMCPIntegration();
    
    // Show completion summary
    showCompletionSummary(results);

    // The search layer cannot work without agy, so a missing or outdated
    // install is a setup failure -- the same verdict setup.sh and `cgmb setup`
    // already give it. Printing "Ready to use" and exiting 0 let npm and any
    // automation record a broken install as successful.
    if (!results['MCP Integration']) {
      log('', 'info');
      log('Setup incomplete: MCP integration was not configured.', 'error');
      log('Run it manually with: cgmb setup-mcp', 'info');
      process.exitCode = 1;
    }

    if (!results['Antigravity CLI']) {
      log('', 'info');
      log('Setup incomplete: the Antigravity CLI is missing or older than 1.1.7.', 'error');
      log('The web-search layer will not work until it is installed and signed in.', 'info');
      process.exitCode = 1;
    }
    
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

// Only run the installer when executed as a script.
//
// Without this guard, `require()`ing the file to test its version check ran the
// whole setup -- npm installs and all.
if (require.main === module) {
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
}