import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  // The scanner's imaging tests process real-size photos: slow on CI runners.
  test: { include: ['src/**/*.test.ts'], testTimeout: 90_000 },
});
