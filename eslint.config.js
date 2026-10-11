import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

// ESLint 10 + typescript-eslint 8.
//
// The rule set is deliberately the hand-picked list below and nothing else:
// no `eslint:recommended`, no `tseslint.configs.recommended`. Extending a
// preset would switch on dozens of rules this config never had, so the
// upgrade would stop being a like-for-like move. `tseslint.configs.base`
// only registers the parser and the `@typescript-eslint` plugin.
//
// Several options below restate what typescript-eslint 6 did by default.
// They are spelled out because typescript-eslint 8 changed those defaults,
// and leaving them implicit would silently change what this config checks.
export default defineConfig([
  {
    files: ['**/*.ts', '**/*.tsx'],
    extends: [tseslint.configs.base],
    languageOptions: {
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      }
    },
    rules: {
      // TypeScript specific rules
      // varsIgnorePattern matches argsIgnorePattern: a leading underscore is
      // how this codebase already marks a binding it keeps deliberately
      // (destructuring a shape it does not consume, a value held for a
      // debugger). Without it, _timestamp and _priority were errors despite
      // being written that way on purpose.
      //
      // caughtErrors: 'none' is the typescript-eslint 6 default. Version 8
      // (following ESLint 9's core rule) changed the default to 'all', which
      // reports every `catch (error)` whose binding goes unused.
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'none',
      }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-non-null-assertion': 'warn',

      // Primitives are exempt because `||` is the correct operator there.
      //
      // This is a CLI that prints a lot of fallbacks: `email || 'N/A'`,
      // `error || 'Unknown error'`. An empty string is exactly the case those
      // want to replace, and `??` would print the blank instead -- a
      // regression, not a fix. 111 of the 157 reports were that shape.
      //
      // Objects, arrays and unions stay covered, which is where the rule earns
      // its keep. `boolean` is deliberately NOT exempt: swallowing an explicit
      // `false` is a real bug, so those few sites get read individually.
      //
      // ignoreConditionalTests: false keeps `if (a || b)` and `while (a || b)`
      // checked, as typescript-eslint 6 did; version 8 flipped the default
      // to true, which would quietly stop checking those.
      //
      // ignoreIfStatements: true keeps out a check typescript-eslint 6 did not
      // have: version 8 also reports `if (!x) { x = y; }` as `x ??= y`. Four
      // sites match (the three memoised get*LayerAsync() promises in
      // LayerManager and CapabilityDetector.isLayerAvailable). Turning it on is
      // a separate decision from the upgrade, not part of it.
      '@typescript-eslint/prefer-nullish-coalescing': ['error', {
        ignorePrimitives: { string: true, number: true },
        ignoreConditionalTests: false,
        ignoreIfStatements: true,
      }],
      '@typescript-eslint/prefer-optional-chain': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      
      // General rules
      'no-console': 'off', // Allow console for CLI tool
      'prefer-const': 'error',
      'no-var': 'error',
      'eqeqeq': 'error',
      'curly': 'error',
      
      // Import rules
      'sort-imports': ['error', {
        ignoreCase: true,
        ignoreDeclarationSort: true
      }]
    }
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module'
    },
    rules: {
      'no-console': 'off',
      'prefer-const': 'error',
      'no-var': 'error'
    }
  },
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'coverage/**',
      'output/**',
      'logs/**',
      'temp/**',
      'tmp/**',
      '*.js',
      '.cgmb-cache/**',
      'test-files/**',
      'examples/output/**',
      'scripts/*.cjs',
      'scripts/*.js'
    ]
  }
]);
