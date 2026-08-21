// @ts-check
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'src/generated/**'],
  },
  {
    files: ['src/**/*.ts'],
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2023,
        sourceType: 'module',
      },
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        globalThis: 'readonly',
      },
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      'no-trailing-spaces': ['error', { ignoreComments: true }],
      // argsIgnorePattern alone covers function parameters only. The other two
      // cover `const { sub: _sub, ...withoutSub } = claims` - dropping a key by
      // destructuring, which is the idiom the specs use to build
      // missing-claim fixtures. ignoreRestSiblings is true in the plugin's
      // recommended defaults; spreading them and then overriding this rule
      // wholesale is what turned it off.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
];
