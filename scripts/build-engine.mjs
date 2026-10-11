// Bundles the PDFium worker + wasm into public/engine (served as static assets on web).
import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const out = 'public/engine';
mkdirSync(out, { recursive: true });

await build({
  entryPoints: ['src/engine/pdfium/worker.ts'],
  outfile: join(out, 'pdfium-worker.js'),
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: process.argv.includes('--minify'),
  conditions: ['browser'],
  logLevel: 'warning',
});

const wasm = join(dirname(require.resolve('@embedpdf/pdfium/pdfium.wasm')), 'pdfium.wasm');
copyFileSync(wasm, join(out, 'pdfium.wasm'));
console.log('engine → public/engine');
