// Finalises `expo export -p web` output for static hosting under EXPO_BASE_URL:
// prefixes our hand-written absolute links in index.html, preloads the fonts, and adds a 404.html SPA fallback.
import { copyFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';

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
  .replace("var base = '';", `var base = '${base}';`)
  .replace('</head>', `${fonts}</head>`);
writeFileSync(file, html);
copyFileSync(file, `${out}/404.html`);
// The offline cache is this build's own (see public/sw.js): named by the version and when it was built, and holding
// every file of the build (the code, fonts, icons and images the first screen needs), fetched when it installs.
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const sw = `${out}/sw.js`;
const files = (dir) => (existsSync(`${out}/${dir}`) ? readdirSync(`${out}/${dir}`, { recursive: true }).map((f) => `${dir}/${String(f).replaceAll('\\', '/')}`).filter((f) => statSync(`${out}/${f}`).isFile()) : []);
const build = [...files('_expo'), ...files('assets'), ...files('icons')];
if (existsSync(sw)) {
  const stamped = readFileSync(sw, 'utf8')
    .replace("const CACHE = 'tessel-dev';", `const CACHE = 'tessel-${version}-${Date.now().toString(36)}';`)
    .replace('const BUILD = [];', `const BUILD = ${JSON.stringify(build)};`);
  if (!build.length || stamped.includes('const BUILD = [];')) throw new Error('postexport: the build list did not go into sw.js');
  writeFileSync(sw, stamped);
}
writeFileSync(`${out}/.nojekyll`, '');
console.log(`postexport: base="${base || '/'}"`);
