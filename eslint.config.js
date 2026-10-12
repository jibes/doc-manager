// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([expoConfig, { ignores: ['.expo/*', 'dist/*', 'public/engine/*', 'public/ocr/*', 'shell/android/**', 'e2e/out/*'] }]);
