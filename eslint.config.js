// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  { ignores: ['.expo/*', 'dist/*', 'public/engine/*', 'public/ocr/*', 'shell/android/**', 'shell/desktop/www/**', 'shell/desktop/node_modules/**', 'shell/desktop/dist/**', 'e2e/out/*'] },
  // The desktop app's main process and preload run in Node (CommonJS).
  { files: ['shell/desktop/*.js'], languageOptions: { globals: { __dirname: 'readonly', process: 'readonly', require: 'readonly' } } },
  // Its own packages (electron, playwright-core) are installed in shell/desktop only, by the Desktop workflow.
  { files: ['shell/desktop/*.js', 'shell/desktop/*.mjs'], rules: { 'import/no-unresolved': 'off' } },
  // core: what any document app would share (engine, text view, OCR, storage, folders, design, strings). It knows
  // nothing of Tessel's documents: paper (the archive, inbox, scanner, screens) builds on it, never the other way.
  {
    files: ['src/core/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ group: ['@/paper/*', '@/app/*', '**/paper/**', '**/app/**'], message: 'core must not depend on paper or the screens.' }] }],
    },
  },
]);
