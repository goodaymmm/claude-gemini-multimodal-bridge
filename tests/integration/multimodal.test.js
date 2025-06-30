import { MultimodalProcess } from '../../src/tools/multimodalProcess';
describe('Multimodal Integration Tests', () => {
    let processor;
    beforeEach(() => {
        processor = new MultimodalProcess();
    });
    it('should process text-only requests', async () => {
        const result = await processor.processMultimodal({
            prompt: 'Test prompt for processing',
            files: [],
            workflow: 'analysis',
            options: {}
        });
        expect(result).toBeDefined();
        expect(result.success).toBeDefined();
    });
    it('should get supported formats', () => {
        const formats = processor.getSupportedFormats();
        expect(formats).toBeDefined();
        expect(formats.images).toContain('.png');
        expect(formats.documents).toContain('.pdf');
    });
    it('should check processing limits', () => {
        const limits = processor.getProcessingLimits();
        expect(limits.maxFiles).toBeGreaterThan(0);
        expect(limits.maxFileSize).toBeGreaterThan(0);
    });
});
