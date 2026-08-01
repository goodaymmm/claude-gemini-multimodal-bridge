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
      // A warning, not an error, and the 130 that remain are deliberate.
      //
      // They sit almost entirely at two kinds of boundary. The larger one is
      // external SDK surface -- @google/genai responses, MCP payloads, winston
      // metadata -- where the vendor's own types are `any` or absent, and
      // writing a local interface would assert a shape nobody guarantees; the
      // check that matters there is the runtime one, and those exist. The
      // second is the task objects that travel between layers: they are
      // caller-supplied, they carry an index signature by design, and every
      // consumer narrows before use.
      //
      // What is not acceptable is a new `any` used to silence a type error in
      // code we own. `Record<string, any>` was swept to `Record<string,
      // unknown>` where it type-checked as a drop-in; the one site that did not
      // was left alone rather than cast around.
      //
      // Raising this to 'error' would mean 130 suppression comments, which is
      // the same information with more noise. It stays a warning so the count
      // is visible and a rise in it is a question worth asking.
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