import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';
import sonarjs from 'eslint-plugin-sonarjs';
import importPlugin from 'eslint-plugin-import-x';

export default tseslint.config(
  {
    ignores: ['dist/', 'node_modules/', 'coverage/', '*.config.*'],
  },

  eslint.configs.recommended,

  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // ── Code complexity & structure ──────────────────────────────
  //
  // Thresholds: SonarQube "A" grade / Clean Code standards.
  // All rules are errors — violations block commits.
  //
  {
    plugins: { sonarjs },
    rules: {
      "sonarjs/cognitive-complexity": ["error", 15],
      "complexity": ["error", 15],
      "max-depth": ["error", 4],
      "max-params": ["error", 4],
      "max-lines-per-function": ["error", { max: 50, skipBlankLines: true, skipComments: true }],
      "max-nested-callbacks": ["error", 3],
      "max-lines": ["error", 300],
      'sonarjs/no-collapsible-if': 'error',
      'sonarjs/no-nested-switch': 'error',
      'sonarjs/no-nested-conditional': 'error',
      'max-classes-per-file': ['error', 1],
      'sonarjs/no-duplicate-string': ['error', { threshold: 4 }],
      'sonarjs/no-identical-functions': 'error',
      'sonarjs/no-duplicated-branches': 'error',
      'sonarjs/no-identical-expressions': 'error',
      'sonarjs/no-identical-conditions': 'error',
    },
  },

  // ── Import hygiene ────────────────────────────────────────
  {
    plugins: { 'import-x': importPlugin },
    rules: {
      'import-x/no-cycle': ['error', { ignoreExternal: true }],
    },
  },

  // ── TypeScript-specific rules ──────────────────────────────
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',

      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      '@typescript-eslint/explicit-function-return-type': [
        'error',
        { allowExpressions: true, allowTypedFunctionExpressions: true },
      ],

      '@typescript-eslint/prefer-nullish-coalescing': 'error',
      '@typescript-eslint/prefer-optional-chain': 'error',

      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],

      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: true }],

      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true, allowNever: true },
      ],

      '@typescript-eslint/no-non-null-assertion': 'error',

      '@typescript-eslint/consistent-type-assertions': [
        'error',
        { assertionStyle: 'as', objectLiteralTypeAssertions: 'allow-as-parameter' },
      ],

      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/no-base-to-string': 'error',
      '@typescript-eslint/restrict-plus-operands': 'error',
      '@typescript-eslint/no-invalid-void-type': ['error', { allowInGenericTypeArguments: true }],
    },
  },

  // ── Relaxed rules for test files ──────────────────────────
  //
  // Tests need flexibility for mocks, type casts, and data builders.
  // Structural limits (function length, file length) still enforced
  // but with higher thresholds.
  //
  {
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/unbound-method': 'off',

      'max-lines-per-function': ['error', { max: 80, skipBlankLines: true, skipComments: true }],
      'max-lines': ['error', { max: 600, skipBlankLines: true, skipComments: true }],
      'max-params': 'off',
      'sonarjs/no-duplicate-string': 'off',
      'sonarjs/no-identical-functions': 'off',
    },
  },

  {
    files: ['src/api/client.ts', 'src/convert/md-to-note.ts', 'src/engine/engine.ts', 'src/engine/helpers-dryrun.ts', 'src/execute/executor.ts', 'src/metadata/store.ts', 'src/scan/cloud-cache.ts', 'src/tools/diagnose-commands.ts'],
    rules: {
      'max-lines': 'off',
    },
  },

  eslintConfigPrettier,
);
