// OCR benchmark: Tesseract (Tessel's setup) against PaddleOCR (doc-scanner) on doc-scanner's e2e scans.
// Usage: node scripts/ocr-bench.mjs <doc-scanner e2e --out dir> (after `npm run e2e -- --no-ui` there).
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createWorker } from 'tesseract.js';

const OUT = process.argv[2];
const norm = (s) => s.normalize('NFC').replace(/­/g, '').replace(/\s+/g, ' ').trim();
function lev(a, b) {
  let prev = new Uint32Array(b.length + 1).map((_, j) => j), cur = new Uint32Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}
const cer = (t, g) => { const a = [...norm(t)], b = [...norm(g)]; return a.length ? lev(a, b) / a.length : 0; };

const worker = await createWorker(['deu', 'eng'], 1, { langPath: join(process.cwd(), 'public/ocr/lang'), gzip: true, cacheMethod: 'none' });
const rows = [];
for (const id of readdirSync(OUT).sort()) {
  const dir = join(OUT, id);
  if (!existsSync(join(dir, 'scan.pdf')) || !existsSync(join(dir, 'truth.txt'))) continue;
  const truth = readFileSync(join(dir, 'truth.txt'), 'utf8');
  const res = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8'));
  // The page as Tessel would see it: render the PDF page at 300 dpi (images only; skip the PDF's own text layer).
  const img = join(dir, '_tess');
  mkdirSync(img, { recursive: true });
  execFileSync('pdftoppm', ['-r', '300', '-png', '-gray', join(dir, 'scan.pdf'), join(img, 'p')]);
  const pages = readdirSync(img).filter((f) => f.endsWith('.png')).sort();
  const t0 = Date.now();
  let text = '';
  for (const p of pages) text += (await worker.recognize(join(img, p))).data.text + '\n';
  const ms = Date.now() - t0;
  rows.push({ id, paddle: res.text?.cer, tess: cer(truth, text), tessMs: ms, paddleMs: res.timings?.ocr ?? res.ocrMs });
}
await worker.terminate();
const pct = (x) => (x == null ? '–' : `${(x * 100).toFixed(1)}%`);
console.log('| case | PaddleOCR CER | Tesseract CER | Tesseract ms |');
for (const r of rows) console.log(`| ${r.id} | ${pct(r.paddle)} | ${pct(r.tess)} | ${r.tessMs} |`);
const mean = (k) => rows.reduce((s, r) => s + (r[k] ?? 0), 0) / rows.length;
const median = (k) => { const v = rows.map((r) => r[k] ?? 0).sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };
console.log(`| mean | ${pct(mean('paddle'))} | ${pct(mean('tess'))} | |`);
console.log(`| median | ${pct(median('paddle'))} | ${pct(median('tess'))} | |`);
