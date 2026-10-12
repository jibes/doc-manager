#!/usr/bin/env node
/**
 * Scan quality harness: synthetic phone photos of synthetic documents with known corners and text, run
 * through the scanner's real workers (detection, processing, OCR) and PDF export in Chromium.
 *
 *   npm run test:scan                         # all cases, with OCR
 *   npm run test:scan -- --only invoice,german
 *   npm run test:scan -- --no-ocr             # detection and filters only (much faster)
 *
 * Options:
 *   --only a,b        only these cases (e2e/scan/scene.ts CASES)
 *   --no-ocr          no text layer or OCR metrics
 *   --no-clean-ocr    skip the OCR baseline on the clean printed page
 *   --max-cer N       fail when the mean character error rate over the cases with text exceeds N (e.g. 0.1)
 *   --out DIR         artifacts and report.md (default e2e/out/scan)
 *   --baseline DIR    add a before/after table against DIR/results.json
 *   --merge           keep other cases' results already in OUT/results.json (with --only)
 *   --report-only     rewrite report.md from OUT/results.json
 *
 * Needs `npm run engine` (workers, wasm), Chromium (PW_CHROMIUM, default /opt/pw-browsers/chromium)
 * and poppler-utils (pdfinfo, pdftotext, pdfimages, pdftoppm).
 */
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { writeReport } from './report.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const OUT = resolve(value('--out', join(root, 'e2e/out/scan')));
const ONLY = value('--only', '').split(',').filter(Boolean);
const OCR = !flag('--no-ocr');
const CLEAN_OCR = OCR && !flag('--no-clean-ocr');
const MAX_CER = Number(value('--max-cer', 'NaN'));
const BASELINE = value('--baseline', '');
const loadBaseline = () => (BASELINE ? JSON.parse(readFileSync(join(BASELINE, 'results.json'), 'utf8')) : null);

/* -------------------------------------------------------------- server ---- */

const SITE = join(OUT, '_site');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.txt': 'text/plain' };

/** The harness page, bundled with the app's scanner code, next to the built workers and the models. */
async function buildSite() {
  if (!existsSync(join(root, 'public/engine/scan-ocr.js'))) throw new Error('Run `npm run engine` first.');
  mkdirSync(SITE, { recursive: true });
  await build({
    entryPoints: [join(here, 'harness.ts')],
    outfile: join(SITE, 'harness.js'),
    bundle: true,
    format: 'esm',
    target: 'es2022',
    alias: { '@': join(root, 'src') },
    define: { 'process.env.EXPO_BASE_URL': '""' },
    logLevel: 'warning',
  });
  writeFileSync(
    join(SITE, 'harness.html'),
    '<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><title>Scan harness</title><p id="status">loading…</p>' +
      '<script type="module">import "./harness.js"; document.getElementById("status").textContent = "ready";</script>',
  );
}

function serve() {
  const mounts = [
    ['/engine/', join(root, 'public/engine')],
    ['/models/', join(root, 'public/models')],
    ['/', SITE],
  ];
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const [prefix, dir] = mounts.find(([p]) => path.startsWith(p));
    const file = join(dir, path.slice(prefix.length));
    if (!file.startsWith(dir) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

/* ----------------------------------------------------------------- pdf ---- */

function run(cmd, args) {
  try {
    const stdout = execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, stdout, stderr: '' };
  } catch (e) {
    return { ok: false, stdout: e.stdout?.toString() ?? '', stderr: e.stderr?.toString() ?? String(e) };
  }
}

function inspectPdf(path) {
  const info = run('pdfinfo', [path]);
  const pages = Number(/Pages:\s+(\d+)/.exec(info.stdout)?.[1] ?? 0);
  const size = /Page size:\s+([\d.]+) x ([\d.]+) pts/.exec(info.stdout);
  const text = run('pdftotext', ['-enc', 'UTF-8', path, '-']);
  const raw = run('pdftotext', ['-raw', '-enc', 'UTF-8', path, '-']);
  const images = run('pdfimages', ['-list', path]);
  const render = run('pdftoppm', ['-r', '10', '-singlefile', '-png', path, path.replace(/\.pdf$/, '_render')]);
  return {
    valid: info.ok && pages > 0 && render.ok && !/error/i.test(info.stderr + render.stderr),
    errors: (info.stderr + text.stderr + render.stderr).trim().slice(0, 500),
    pages,
    pageMm: size ? [(+size[1] / 72) * 25.4, (+size[2] / 72) * 25.4] : null,
    text: text.stdout.replace(/\f/g, '\n'),
    rawText: raw.stdout.replace(/\f/g, '\n'),
    images: images.stdout
      .split('\n')
      .slice(2)
      .filter(Boolean)
      .map((l) => l.trim().split(/\s+/).slice(3, 9).join(' ')),
  };
}

/* --------------------------------------------------------------- cases ---- */

function save(dir, files) {
  mkdirSync(dir, { recursive: true });
  for (const [name, b64] of Object.entries(files)) writeFileSync(join(dir, name), Buffer.from(b64, 'base64'));
}

async function openHarness(browser, url) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error(`  [pageerror] ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') console.error(`  [console] ${m.text()}`);
  });
  await page.goto(url);
  await page.waitForFunction(() => document.getElementById('status')?.textContent === 'ready', null, { timeout: 120_000 });
  return page;
}

async function runCase(browser, url, id) {
  const page = await openHarness(browser, url);
  try {
    const result = await page.evaluate(
      ({ id, ocr, cleanOcr }) => window.e2e.runCase(id, { ocr, cleanOcr, filters: window.e2e.FILTERS }),
      { id, ocr: OCR, cleanOcr: CLEAN_OCR },
    );
    const dir = join(OUT, id);
    rmSync(dir, { recursive: true, force: true });
    save(dir, result.files);
    delete result.files;
    const pdf = inspectPdf(join(dir, 'scan.pdf'));
    writeFileSync(join(dir, 'pdftotext.txt'), pdf.text);
    writeFileSync(join(dir, 'truth.txt'), result.truth.text);
    if (result.ocrClean) writeFileSync(join(dir, 'ocr_clean.txt'), result.ocrClean.text);
    result.pdfCheck = { ...pdf, text: undefined, rawText: undefined };
    if (OCR) {
      const metrics = (truth, got, special, zone) =>
        page.evaluate(({ truth, got, special, zone }) => window.e2e.textMetrics(truth, got, special, zone), { truth, got, special, zone });
      const zone = result.truth.zoneText || undefined;
      result.text = await metrics(result.truth.text, pdf.text, result.truth.special, zone);
      for (const [prefix, set] of [
        ['', result.filters],
        ['truecrop_', result.trueCropFilters ?? {}],
      ])
        for (const [name, f] of Object.entries(set)) {
          if (f.ocrText === undefined) continue;
          writeFileSync(join(dir, `ocr_${prefix}${name}.txt`), f.ocrText);
          f.text = await metrics(result.truth.text, f.ocrText, undefined, zone);
          delete f.ocrText;
        }
      result.textRaw = await metrics(result.truth.text, pdf.rawText);
    }
    if (result.ocrClean) delete result.ocrClean.text;
    writeFileSync(join(dir, 'result.json'), JSON.stringify(result, null, 2));
    return result;
  } finally {
    await page.close();
  }
}

/* ---------------------------------------------------------------- main ---- */

async function main() {
  mkdirSync(OUT, { recursive: true });
  if (flag('--report-only')) {
    const { meta, results } = JSON.parse(readFileSync(join(OUT, 'results.json'), 'utf8'));
    writeReport(OUT, results, meta, loadBaseline());
    console.log(`Report: ${join(OUT, 'report.md')}`);
    return;
  }
  await buildSite();
  const server = await serve();
  const url = `http://127.0.0.1:${server.address().port}/harness.html`;
  const browser = await chromium.launch({
    // Else Playwright's own Chromium (`npx playwright-core install chromium`).
    executablePath: process.env.PW_CHROMIUM ?? (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined),
    args: ['--js-flags=--max-old-space-size=8192'],
  });
  let results = [];
  try {
    const page = await openHarness(browser, url);
    const cases = await page.evaluate(() => window.e2e.listCases());
    await page.close();
    for (const id of cases.map((c) => c.id).filter((id) => !ONLY.length || ONLY.includes(id))) {
      const t0 = Date.now();
      process.stdout.write(`${id.padEnd(16)} `);
      try {
        const r = await runCase(browser, url, id);
        results.push(r);
        console.log(
          `corner ${Math.max(...r.detection.cornerErr).toFixed(1)}px  ink ${(r.truthCrop.inkRecall * 100).toFixed(1)}%  white ${(r.truthCrop.white * 100).toFixed(1)}%` +
            (r.text ? `  CER ${(r.text.cer * 100).toFixed(1)}%` : '') +
            `  ${((Date.now() - t0) / 1000).toFixed(0)}s`,
        );
      } catch (error) {
        console.log(`FAILED: ${error?.message ?? error}`);
        results.push({ id, error: String(error?.message ?? error) });
      }
    }
  } finally {
    await browser.close();
    server.close();
  }
  const meta = {
    commit: run('git', ['-C', root, 'rev-parse', '--short', 'HEAD']).stdout.trim(),
    dirty: run('git', ['-C', root, 'status', '--porcelain', '--', 'src/scan']).stdout.trim() !== '',
    date: new Date().toISOString(),
  };
  if (flag('--merge') && existsSync(join(OUT, 'results.json'))) {
    const old = JSON.parse(readFileSync(join(OUT, 'results.json'), 'utf8'));
    const fresh = new Set(results.map((r) => r.id));
    const order = old.results.map((r) => r.id);
    results = [...old.results.filter((r) => !fresh.has(r.id)), ...results].sort(
      (a, b) => (order.indexOf(a.id) + 1 || 1e9) - (order.indexOf(b.id) + 1 || 1e9),
    );
  }
  writeFileSync(join(OUT, 'results.json'), JSON.stringify({ meta, results }, null, 2));
  writeReport(OUT, results, meta, loadBaseline());
  console.log(`\nReport: ${join(OUT, 'report.md')}`);

  const failed = results.filter((r) => r.error);
  const read = results.filter((r) => r.text);
  const mean = read.reduce((sum, r) => sum + r.text.cer, 0) / (read.length || 1);
  if (read.length) console.log(`Mean CER ${(mean * 100).toFixed(1)}% over ${read.length} cases`);
  if (failed.length) {
    console.error(`${failed.length} case(s) failed: ${failed.map((r) => r.id).join(', ')}`);
    process.exitCode = 1;
  }
  if (mean > MAX_CER) {
    console.error(`Mean CER ${(mean * 100).toFixed(1)}% is above the limit of ${(MAX_CER * 100).toFixed(1)}%`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
