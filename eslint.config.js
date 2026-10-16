// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  { ignores: ['.expo/*', 'dist/*', 'public/engine/*', 'public/ocr/*', 'shell/android/**', 'e2e/out/*'] },
  // core: what any document app would share (engine, text view, OCR, storage, folders, design, strings). It knows
  // nothing of Tessel's documents: paper (the archive, inbox, scanner, screens) builds on it, never the other way.
  {
    files: ['src/core/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ group: ['@/paper/*', '@/app/*', '**/paper/**', '**/app/**'], message: 'core must not depend on paper or the screens.' }] }],
    },
  },
]);
