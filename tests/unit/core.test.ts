import { CGMBServer } from '../../src/core/CGMBServer';
import { LayerManager } from '../../src/core/LayerManager';

describe('Core Components', () => {
  describe('CGMBServer', () => {
    it('should initialize without errors', async () => {
      const server = new CGMBServer();
      expect(server).toBeDefined();
    });

    it('should be instantiable', () => {
      const server = new CGMBServer();
      expect(server).toBeDefined();
      expect(server).toBeInstanceOf(CGMBServer);
    });
  });

  describe('LayerManager', () => {
    it('should initialize with default config', () => {
      const defaultConfig = {
        gemini: { api_key: '', model: 'gemini-2.5-pro', timeout: 60000, max_tokens: 16384, temperature: 0.2 },
        claude: { code_path: '/usr/local/bin/claude', timeout: 300000 },
        aistudio: { enabled: true, max_files: 10, max_file_size: 100 },
        cache: { enabled: true, ttl: 3600 },
        logging: { level: 'info' as const },
      };
      
      const manager = new LayerManager(defaultConfig);
      expect(manager).toBeDefined();
    });
  });
});