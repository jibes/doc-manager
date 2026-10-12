// Finalises `expo export -p web` output for static hosting under EXPO_BASE_URL:
// prefixes our hand-written absolute links in index.html and adds a 404.html SPA fallback.
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const base = (process.env.EXPO_BASE_URL ?? '').replace(/\/$/, '');
// dist for the website; the Android app bundles its own export (OUT_DIR, base "").
const out = process.env.OUT_DIR ?? 'dist';
const file = `${out}/index.html`;
const html = readFileSync(file, 'utf8')
  .replaceAll('href="/manifest.webmanifest"', `href="${base}/manifest.webmanifest"`)
  .replaceAll('href="/icons/', `href="${base}/icons/`)
  .replaceAll("register('/sw.js')", `register('${base}/sw.js')`);
writeFileSync(file, html);
copyFileSync(file, `${out}/404.html`);
writeFileSync(`${out}/.nojekyll`, '');
console.log(`postexport: base="${base || '/'}"`);
