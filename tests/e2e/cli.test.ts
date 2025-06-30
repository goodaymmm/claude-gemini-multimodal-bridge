import { execSync } from 'child_process';
import path from 'path';

describe('CLI End-to-End Tests', () => {
  const CLI_PATH = path.join(__dirname, '../../dist/cli.js');

  it('should show help when no arguments provided', () => {
    const output = execSync(`node ${CLI_PATH} --help`, { encoding: 'utf8' });
    expect(output).toContain('Claude-Gemini Multimodal Bridge');
    expect(output).toContain('serve');
    expect(output).toContain('verify');
  });

  it('should show version information', () => {
    const output = execSync(`node ${CLI_PATH} --version`, { encoding: 'utf8' });
    expect(output).toContain('1.0.0');
  });

  it('should show system information', () => {
    const output = execSync(`node ${CLI_PATH} info`, { 
      encoding: 'utf8',
      timeout: 30000 
    });
    expect(output).toContain('CGMB System Information');
    expect(output).toContain('Version: 1.0.0');
  });
});