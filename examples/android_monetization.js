#!/usr/bin/env node

/**
 * Real-world example: Android App Monetization Strategy Analysis
 * This demonstrates the enhanced CGMB capabilities for practical business questions
 */

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// CGMB CLI path
const cgmbPath = path.join(__dirname, '../dist/cli.js');

console.log('🚀 Android App Monetization Strategy Analysis');
console.log('=' .repeat(60));
console.log('This example demonstrates CGMB\'s enhanced capabilities for real business questions');
console.log('');

// The actual question from Error.md
const monetizationQuestion = `Androidアプリのマネタイズ戦略について最新のトレンドを含めて教えてください。特に2024-2025年の動向について詳しく説明してください。

具体的には以下の点について分析してください：
1. 広告収入モデルの最新動向
2. アプリ内購入（IAP）の効果的な実装方法
3. サブスクリプションモデルの成功事例
4. その他の収益化方法（アフィリエイト、スポンサーシップ等）
5. 2024-2025年の市場予測と新しいトレンド

最新の情報を検索機能を使って取得し、実践的なアドバイスを提供してください。`;

async function runMonetizationAnalysis() {
  console.log('📊 Step 1: Using enhanced Gemini CLI for search and grounding...');
  
  // Use the new direct Gemini CLI command
  const geminiProcess = spawn('node', [cgmbPath, 'gemini', '-p', monetizationQuestion, '--search'], {
    stdio: 'inherit',
    env: { ...process.env }
  });

  return new Promise((resolve, reject) => {
    geminiProcess.on('close', (code) => {
      if (code === 0) {
        console.log('\n✅ Gemini CLI analysis completed');
        console.log('\n' + '='.repeat(60));
        console.log('📈 Step 2: Creating monetization strategy visualization...');
        resolve();
      } else {
        console.error(`❌ Gemini CLI process failed with code ${code}`);
        reject(new Error(`Process failed with code ${code}`));
      }
    });

    geminiProcess.on('error', (error) => {
      console.error('❌ Failed to start Gemini CLI process:', error);
      reject(error);
    });
  });
}

async function createVisualization() {
  const visualPrompt = `Create a professional infographic showing the 'Adaptive Value Monetization (AVM)' strategy for Android apps. Include:

1) Three subscription tiers (Basic ¥300, Pro ¥800, Ultra ¥1500)
2) AI-driven personalization with dynamic pricing
3) Reward advertising system with user engagement metrics
4) Micro-transactions for premium features
5) Revenue structure pie chart (60% subscriptions, 25% ads, 15% IAP)

Use modern design with blue and green color scheme. Make it suitable for business presentations.`;

  console.log('🎨 Generating monetization strategy visualization with AI Studio...');
  
  const aiStudioProcess = spawn('node', [cgmbPath, 'aistudio', '-p', visualPrompt], {
    stdio: 'inherit',
    env: { ...process.env }
  });

  return new Promise((resolve, reject) => {
    aiStudioProcess.on('close', (code) => {
      if (code === 0) {
        console.log('\n✅ AI Studio visualization completed');
        console.log('\n' + '='.repeat(60));
        console.log('🔀 Step 3: Comprehensive analysis with intelligent routing...');
        resolve();
      } else {
        console.error(`❌ AI Studio process failed with code ${code}`);
        resolve(); // Continue even if visualization fails
      }
    });

    aiStudioProcess.on('error', (error) => {
      console.error('❌ Failed to start AI Studio process:', error);
      resolve(); // Continue even if visualization fails
    });
  });
}

async function comprehensiveAnalysis() {
  const comprehensivePrompt = `Based on the Android app monetization research, create a comprehensive business strategy document that includes:

1. Executive Summary
2. Current Market Analysis (2024-2025)
3. Recommended Monetization Mix
4. Implementation Timeline
5. ROI Projections
6. Risk Assessment
7. Action Items

Format as a professional business document with clear sections and actionable insights.`;

  console.log('📋 Creating comprehensive business strategy document...');
  
  const processCommand = spawn('node', [cgmbPath, 'process', '-p', comprehensivePrompt, '-w', 'generation', '--strategy', 'adaptive'], {
    stdio: 'inherit',
    env: { ...process.env }
  });

  return new Promise((resolve, reject) => {
    processCommand.on('close', (code) => {
      if (code === 0) {
        console.log('\n✅ Comprehensive analysis completed');
        resolve();
      } else {
        console.error(`❌ Process failed with code ${code}`);
        reject(new Error(`Process failed with code ${code}`));
      }
    });

    processCommand.on('error', (error) => {
      console.error('❌ Failed to start process:', error);
      reject(error);
    });
  });
}

async function main() {
  try {
    console.log('Starting Android app monetization strategy analysis...\n');
    
    await runMonetizationAnalysis();
    await createVisualization();
    await comprehensiveAnalysis();
    
    console.log('\n' + '🎉'.repeat(20));
    console.log('🎉 ANDROID MONETIZATION ANALYSIS COMPLETE! 🎉');
    console.log('🎉'.repeat(20));
    console.log('\nThis example demonstrated:');
    console.log('✅ Enhanced Gemini CLI integration with search capabilities');
    console.log('✅ AI Studio visualization generation');
    console.log('✅ Intelligent layer routing for complex analysis');
    console.log('✅ Real-world business question processing');
    console.log('✅ No more timeout issues or unnecessary steps!');
    console.log('\nCGMB is now ready for production use! 🚀');
    
  } catch (error) {
    console.error('\n❌ Analysis failed:', error.message);
    console.log('\n💡 This might indicate authentication or configuration issues.');
    console.log('Try running: cgmb verify');
    process.exit(1);
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { runMonetizationAnalysis, createVisualization, comprehensiveAnalysis };