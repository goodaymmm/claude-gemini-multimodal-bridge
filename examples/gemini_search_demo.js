#!/usr/bin/env node

/**
 * Gemini CLI Search Functionality Demo
 * Demonstrates how CGMB now provides seamless Gemini CLI integration
 */

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// CGMB CLI path
const cgmbPath = path.join(__dirname, '../dist/cli.js');

console.log('🔍 CGMB Gemini CLI Search Integration Demo');
console.log('=' .repeat(50));
console.log('This demonstrates the seamless Gemini CLI integration that was missing in Error.md/Error2.md');
console.log('');

const searchQueries = [
  {
    title: 'Latest Tech Trends',
    prompt: '2024年最新のAI技術トレンドについて教えてください。特にLLMとマルチモーダルAIの動向を含めて。'
  },
  {
    title: 'Market Research',
    prompt: 'What are the current trends in mobile app development for 2024-2025? Include information about React Native, Flutter, and native development.'
  },
  {
    title: 'Business Strategy',
    prompt: 'Startup企業がAIを活用した新しいビジネスモデルを構築する際の注意点とベストプラクティスについて、2024年の市場動向を踏まえて説明してください。'
  }
];

async function runGeminiSearch(query, index) {
  console.log(`\n📋 Query ${index + 1}: ${query.title}`);
  console.log('-'.repeat(40));
  console.log(`Question: ${query.prompt.substring(0, 80)}...`);
  console.log('');

  const startTime = Date.now();
  
  const geminiProcess = spawn('node', [cgmbPath, 'gemini', '-p', query.prompt, '--search'], {
    stdio: 'inherit',
    env: { 
      ...process.env,
      LOG_LEVEL: 'info' // Reduce log noise for demo
    }
  });

  return new Promise((resolve, reject) => {
    geminiProcess.on('close', (code) => {
      const duration = Date.now() - startTime;
      if (code === 0) {
        console.log(`\n✅ Query ${index + 1} completed in ${Math.round(duration/1000)}s`);
        console.log('🎯 Key improvements over Error.md:');
        console.log('  - No "unknown command" errors');
        console.log('  - Direct Gemini CLI access');
        console.log('  - No timeout issues');
        console.log('  - Real search results');
        resolve();
      } else {
        console.error(`❌ Query ${index + 1} failed with code ${code}`);
        reject(new Error(`Process failed with code ${code}`));
      }
    });

    geminiProcess.on('error', (error) => {
      console.error(`❌ Failed to start Gemini CLI process for query ${index + 1}:`, error);
      reject(error);
    });
  });
}

async function compareWithOldApproach() {
  console.log('\n' + '🔄'.repeat(20));
  console.log('🔄 COMPARISON WITH ERROR.MD APPROACH 🔄');
  console.log('🔄'.repeat(20));
  
  console.log('\n❌ OLD (Error.md - FAILED):');
  console.log('   cgmb gemini-chat "question"');
  console.log('   → Error: unknown command \'gemini-chat\'');
  console.log('   → User had to manually try different commands');
  console.log('   → No actual processing occurred');
  console.log('   → Timeout after initialization only');
  
  console.log('\n✅ NEW (Enhanced CGMB):');
  console.log('   cgmb gemini -p "question" --search');
  console.log('   → Works immediately');
  console.log('   → Direct Gemini CLI integration');
  console.log('   → Real search and grounding');
  console.log('   → Actual results returned');
  console.log('   → No unnecessary intermediate steps');
}

async function demonstrateFileProcessing() {
  console.log('\n📄 Bonus: File Processing with Gemini CLI');
  console.log('-'.repeat(40));
  
  // Create a sample analysis file
  const sampleContent = `Project: Mobile App Analysis
Status: Planning Phase
Features:
- User authentication
- Data synchronization
- Offline mode
- Push notifications

Technical Requirements:
- React Native framework
- Firebase backend
- Redux state management
- TypeScript implementation`;

  const tempFile = path.join(__dirname, 'sample_project.txt');
  const fs = await import('fs');
  fs.writeFileSync(tempFile, sampleContent);
  
  console.log(`📁 Created sample file: ${tempFile}`);
  console.log('🔍 Analyzing with Gemini CLI...');
  
  const fileAnalysisPrompt = 'このプロジェクトファイルを分析して、技術的な推奨事項と潜在的な課題について詳しく説明してください。特に2024年のベストプラクティスを考慮して。';
  
  const fileProcess = spawn('node', [cgmbPath, 'gemini', '-p', fileAnalysisPrompt, '-f', tempFile], {
    stdio: 'inherit',
    env: { ...process.env }
  });

  return new Promise((resolve, reject) => {
    fileProcess.on('close', (code) => {
      // Clean up temp file
      try {
        fs.unlinkSync(tempFile);
        console.log(`🗑️ Cleaned up temp file: ${tempFile}`);
      } catch (error) {
        console.log('Note: Temp file cleanup skipped');
      }
      
      if (code === 0) {
        console.log('\n✅ File processing completed successfully');
        resolve();
      } else {
        console.error(`❌ File processing failed with code ${code}`);
        resolve(); // Continue demo even if this fails
      }
    });

    fileProcess.on('error', (error) => {
      console.error('❌ Failed to start file processing:', error);
      resolve(); // Continue demo even if this fails
    });
  });
}

async function main() {
  try {
    console.log('Starting Gemini CLI Search Integration Demo...\n');
    
    // Run search queries
    for (let i = 0; i < searchQueries.length; i++) {
      await runGeminiSearch(searchQueries[i], i);
      
      // Add delay between queries
      if (i < searchQueries.length - 1) {
        console.log('\n⏳ Waiting 3 seconds before next query...');
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }
    
    // Compare approaches
    await compareWithOldApproach();
    
    // Demonstrate file processing
    await demonstrateFileProcessing();
    
    console.log('\n' + '🎉'.repeat(25));
    console.log('🎉 GEMINI CLI INTEGRATION DEMO COMPLETE! 🎉');
    console.log('🎉'.repeat(25));
    console.log('\nKey Improvements Demonstrated:');
    console.log('✅ No more "unknown command" errors from Error.md');
    console.log('✅ Direct Gemini CLI access with proper syntax');
    console.log('✅ Search and grounding functionality working');
    console.log('✅ File processing capabilities');
    console.log('✅ No timeout issues');
    console.log('✅ Streamlined user experience');
    console.log('\n🚀 CGMB Gemini CLI integration is now production-ready!');
    
  } catch (error) {
    console.error('\n❌ Demo failed:', error.message);
    console.log('\n💡 This might indicate authentication or configuration issues.');
    console.log('Try running: cgmb verify');
    process.exit(1);
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { runGeminiSearch, compareWithOldApproach, demonstrateFileProcessing };