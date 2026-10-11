// Renders the Quire mark (folded sheet + serif Q) into every icon size the platforms need.
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const font = readFileSync('node_modules/@expo-google-fonts/newsreader/600SemiBold/Newsreader_600SemiBold.ttf').toString('base64');

// bg: tile colour or null for transparent; scale: mark size relative to canvas.
const mark = (size, { bg = '#ECE8DF', scale = 0.62, mono = false } = {}) => `<!doctype html><html><head><style>
@font-face { font-family: N; src: url(data:font/ttf;base64,${font}); }
html,body { margin:0; width:${size}px; height:${size}px; background:${bg ?? 'transparent'}; }
.wrap { width:100%; height:100%; display:flex; align-items:center; justify-content:center;
  filter:${mono ? 'none' : `drop-shadow(0 ${size * 0.018}px ${size * 0.03}px rgba(60,48,30,0.24))`}; }
.sheet { position:relative; width:${size * scale * 0.78}px; height:${size * scale}px; background:${mono ? '#000' : '#FFFFFF'};
  border-radius:${size * 0.018}px; transform:rotate(-4deg);
  clip-path: polygon(0 0, 78% 0, 100% 17%, 100% 100%, 0 100%); }
.fold { position:absolute; right:0; top:0; width:22%; height:17%; background:${mono ? 'transparent' : '#E3DED3'};
  clip-path: polygon(0 0, 0 100%, 100% 100%); }
.q { position:absolute; left:0; right:0; top:15%; text-align:center; font-family:N; font-size:${size * scale * 0.6}px;
  line-height:1; color:${mono ? 'transparent' : '#1B1A17'}; }
.rule { position:absolute; left:22%; right:22%; bottom:15%; height:${Math.max(1, size * 0.012)}px; background:${mono ? 'transparent' : '#2F4F86'}; border-radius:9px; }
</style></head><body><div class="wrap"><div class="sheet"><div class="fold"></div><div class="q">Q</div><div class="rule"></div></div></div></body></html>`;

const targets = [
  ['assets/images/icon.png', 1024, {}],
  ['assets/images/splash-icon.png', 512, { bg: null, scale: 0.8 }],
  ['assets/images/favicon.png', 64, { scale: 0.86 }],
  ['assets/images/android-icon-foreground.png', 432, { bg: null, scale: 0.46 }],
  ['assets/images/android-icon-monochrome.png', 432, { bg: null, scale: 0.46, mono: true }],
  ['public/icons/icon-192.png', 192, {}],
  ['public/icons/icon-512.png', 512, {}],
  ['public/icons/icon-maskable-512.png', 512, { scale: 0.5 }],
];

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium' });
for (const [path, size, opts] of targets) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(mark(size, opts));
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path, omitBackground: opts.bg === null });
  await page.close();
  console.log(path);
}
await browser.close();
