// Bundles the PDFium worker + wasm and the scanner workers + ONNX Runtime into public/engine, and copies the on-device OCR
// (Tesseract, LSTM builds + English/German models) into public/ocr. Served as static assets on web.
import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const out = 'public/engine';
mkdirSync(out, { recursive: true });

await build({
  entryPoints: ['src/core/engine/pdfium/worker.ts'],
  outfile: join(out, 'pdfium-worker.js'),
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: process.argv.includes('--minify'),
  conditions: ['browser'],
  logLevel: 'warning',
});

// Search: the index of every document's text, built and searched away from the screen.
await build({
  entryPoints: ['src/paper/archive/searchWorker.ts'],
  outfile: join(out, 'search-worker.js'),
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: process.argv.includes('--minify'),
  conditions: ['browser'],
  logLevel: 'warning',
});

const wasm = join(dirname(require.resolve('@embedpdf/pdfium/pdfium.wasm')), 'pdfium.wasm');
copyFileSync(wasm, join(out, 'pdfium.wasm'));

// Scanner: image processing, page detection and OCR (PaddleOCR) workers, with ONNX Runtime's wasm. The models are in public/models.
await build({
  entryPoints: ['processor', 'detector', 'ocr'].map((name) => ({ in: `src/paper/scan/engine/worker/${name}.worker.ts`, out: `scan-${name}` })),
  outdir: out,
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: process.argv.includes('--minify'),
  conditions: ['browser'],
  logLevel: 'warning',
});
copyFileSync(require.resolve('onnxruntime-web/ort-wasm-simd-threaded.wasm'), join(out, 'ort-wasm-simd-threaded.wasm'));
console.log('engine → public/engine');

// OCR is loaded only when a reader asks to recognize a scanned PDF; self-hosted so no page image or request leaves the app's origin.
const ocr = 'public/ocr';
mkdirSync(join(ocr, 'lang'), { recursive: true });
const pkg = (name) => dirname(require.resolve(`${name}/package.json`));
for (const f of ['tesseract.min.js', 'worker.min.js']) copyFileSync(join(pkg('tesseract.js'), 'dist', f), join(ocr, f));
for (const v of ['lstm', 'simd-lstm', 'relaxedsimd-lstm']) {
  const f = `tesseract-core-${v}.wasm.js`;
  copyFileSync(join(pkg('tesseract.js-core'), f), join(ocr, f));
}
for (const lang of ['eng', 'deu']) {
  const f = `${lang}.traineddata.gz`;
  copyFileSync(join(pkg(`@tesseract.js-data/${lang}`), '4.0.0_best_int', f), join(ocr, 'lang', f));
}
// Licences travel with the redistributed code (Apache-2.0); the models are Apache-2.0 from tesseract-ocr/tessdata.
copyFileSync(join(pkg('tesseract.js'), 'LICENSE.md'), join(ocr, 'LICENSE-tesseract.js.md'));
copyFileSync(join(pkg('tesseract.js-core'), 'LICENSE'), join(ocr, 'LICENSE-tesseract-core.txt'));
for (const f of ['tesseract.min.js.LICENSE.txt', 'worker.min.js.LICENSE.txt']) copyFileSync(join(pkg('tesseract.js'), 'dist', f), join(ocr, f));
console.log('ocr → public/ocr');
