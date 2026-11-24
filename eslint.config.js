import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      'plan/**',
      'bench/artifacts/**',
      '**/*.tsbuildinfo',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['**/*.test.ts', '**/*.bench.ts', 'bench/**/*.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    files: ['**/cli.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    // Self-contained Node E2E/packaging scripts; UI waitForFunction callbacks
    // also run in a browser context, so node and browser globals are in scope.
    files: ['**/e2e/**/*.mjs', 'scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        performance: 'readonly',
        setTimeout: 'readonly',
        document: 'readonly',
        AbortController: 'readonly',
        TextDecoder: 'readonly',
        WebSocket: 'readonly',
        PerformanceObserver: 'readonly',
        requestAnimationFrame: 'readonly',
      },
    },
    rules: {
      'no-console': 'off',
    },
  },
);
