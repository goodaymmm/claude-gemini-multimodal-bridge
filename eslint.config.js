import { ESLint } from 'eslint';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

export default [
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        project: './tsconfig.json'
      }
    },
    plugins: {
      '@typescript-eslint': tsPlugin
    },
    rules: {
      // TypeScript specific rules
      // varsIgnorePattern matches argsIgnorePattern: a leading underscore is
      // how this codebase already marks a binding it keeps deliberately
      // (destructuring a shape it does not consume, a value held for a
      // debugger). Without it, _timestamp and _priority were errors despite
      // being written that way on purpose.
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
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
      '@typescript-eslint/prefer-nullish-coalescing': ['error', {
        ignorePrimitives: { string: true, number: true },
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
];