import { AuthVerifier } from '../../src/auth/AuthVerifier';
import { AuthStateManager } from '../../src/auth/AuthStateManager';
describe('Authentication Components', () => {
    describe('AuthVerifier', () => {
        it('should initialize without errors', () => {
            const verifier = new AuthVerifier();
            expect(verifier).toBeDefined();
        });
    });
    describe('AuthStateManager', () => {
        it('should initialize without errors', () => {
            const manager = new AuthStateManager();
            expect(manager).toBeDefined();
        });
    });
});
