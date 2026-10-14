// Finalises `expo export -p web` output for static hosting under EXPO_BASE_URL:
// prefixes our hand-written absolute links in index.html, preloads the fonts, and adds a 404.html SPA fallback.
import { copyFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';

const base = (process.env.EXPO_BASE_URL ?? '').replace(/\/$/, '');
// dist for the website; the Android app bundles its own export (OUT_DIR, base "").
const out = process.env.OUT_DIR ?? 'dist';
const file = `${out}/index.html`;
// The fonts are fetched while the app's code loads, not after it ran (the first screen waits for them).
const fonts = readdirSync(`${out}/assets`, { recursive: true })
  .map(String)
  .filter((f) => f.endsWith('.ttf'))
  .map((f) => `<link rel="preload" as="font" type="font/ttf" crossorigin href="${base}/assets/${f.replaceAll('\\', '/')}">`)
  .join('');
const html = readFileSync(file, 'utf8')
  .replaceAll('href="/manifest.webmanifest"', `href="${base}/manifest.webmanifest"`)
  .replaceAll('href="/icons/', `href="${base}/icons/`)
  .replaceAll("register('/sw.js')", `register('${base}/sw.js')`)
  .replace('</head>', `${fonts}</head>`);
writeFileSync(file, html);
copyFileSync(file, `${out}/404.html`);
writeFileSync(`${out}/.nojekyll`, '');
console.log(`postexport: base="${base || '/'}"`);
