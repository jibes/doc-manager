// Renders the Tessel mark (a page tessellated into four tiles; the accent tile carries the page's folded corner).
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';

const INK = '#1B1A17';
const ACCENT = '#2F4F86';

// bg: tile colour or null for transparent; scale: mark height relative to canvas.
const mark = (size, { bg = '#ECE8DF', scale = 0.56, mono = false } = {}) => {
  const h = size * scale;
  const w = h * 0.78; // portrait, like a page
  const gap = h * 0.06;
  const r = h * 0.05;
  const tile = (c, o = 1, fold = false) =>
    `<div style="background:${c};opacity:${o};border-radius:${r}px;${fold ? `clip-path:polygon(0 0,62% 0,100% 30%,100% 100%,0 100%)` : ''}"></div>`;
  const ink = mono ? '#000' : INK;
  return `<!doctype html><html><head><style>
html,body{margin:0;width:${size}px;height:${size}px;background:${bg ?? 'transparent'}}
.wrap{width:100%;height:100%;display:flex;align-items:center;justify-content:center}
.grid{width:${w}px;height:${h}px;display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;gap:${gap}px}
</style></head><body><div class="wrap"><div class="grid">
${tile(ink)}${tile(mono ? '#000' : ACCENT, 1, true)}${tile(ink)}${tile(ink, mono ? 1 : 0.35)}
</div></div></body></html>`;
};

const targets = [
  ['assets/images/icon.png', 1024, {}],
  ['assets/images/splash-icon.png', 512, { bg: null, scale: 0.7 }],
  ['assets/images/favicon.png', 64, { scale: 0.72 }],
  ['assets/images/android-icon-foreground.png', 432, { bg: null, scale: 0.4 }],
  ['assets/images/android-icon-monochrome.png', 432, { bg: null, scale: 0.4, mono: true }],
  ['public/icons/icon-192.png', 192, {}],
  ['public/icons/icon-512.png', 512, {}],
  ['public/icons/icon-maskable-512.png', 512, { scale: 0.46 }],
];

const preinstalled = process.env.CHROMIUM ?? '/opt/pw-browsers/chromium';
const browser = await chromium.launch(existsSync(preinstalled) ? { executablePath: preinstalled } : {});
for (const [path, size, opts] of targets) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(mark(size, opts));
  await page.screenshot({ path, omitBackground: opts.bg === null });
  await page.close();
  console.log(path);
}
await browser.close();
