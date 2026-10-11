// Finalises `expo export -p web` output for static hosting under EXPO_BASE_URL:
// prefixes our hand-written absolute links in index.html and adds a 404.html SPA fallback.
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const base = (process.env.EXPO_BASE_URL ?? '').replace(/\/$/, '');
const file = 'dist/index.html';
const html = readFileSync(file, 'utf8')
  .replaceAll('href="/manifest.webmanifest"', `href="${base}/manifest.webmanifest"`)
  .replaceAll('href="/icons/', `href="${base}/icons/`)
  .replaceAll("register('/sw.js')", `register('${base}/sw.js')`);
writeFileSync(file, html);
copyFileSync(file, 'dist/404.html');
writeFileSync('dist/.nojekyll', '');
console.log(`postexport: base="${base || '/'}"`);
