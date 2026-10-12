/** Markdown summary of an e2e run (see run.mjs). */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const pct = (v, d = 1) =>
  v === undefined || v === null || Number.isNaN(v) ? '–' : `${(v * 100).toFixed(d)}%`;
const num = (v, d = 1) =>
  v === undefined || v === null || Number.isNaN(v) ? '–' : Number(v).toFixed(d);
const kb = (b) => (b ? `${Math.round(b / 1024)}` : '–');

/** Problems worth a look, by threshold. */
export function flags(r) {
  const out = [];
  const d = r.detection;
  if (!d.found) out.push('no detection (manual crop)');
  else if (Math.max(...d.cornerErr) > 10)
    out.push(`corner err ${Math.max(...d.cornerErr).toFixed(0)}px`);
  // The crop's corner order turns the page by `shift`; auto-orientation turns it back by `turn`.
  const turn = r.output.turn ?? 0;
  const net = (d.shift - turn + 4) % 4;
  if (net)
    out.push(
      `output rotated ${net * 90}° (${turn ? `auto-turned ${turn * 90}°` : 'not auto-oriented'})`,
    );
  else if (turn) out.push(`auto-turned ${turn * 90}°`);
  if (Math.abs(r.output.aspectErr) > 0.02) out.push(`aspect ${pct(r.output.aspectErr)}`);
  if (r.truth.format !== r.output.format)
    out.push(`format ${r.output.format ?? 'none'}≠${r.truth.format ?? 'none'}`);
  if (!r.truth.format) {
    const [w, h] = r.output.pageMm;
    const tw = d.shift % 2 ? r.truth.heightMm : r.truth.widthMm;
    const err = w / tw - 1;
    if (Math.abs(err) > 0.1)
      out.push(
        `physical size ${Math.round(w)}×${Math.round(h)}mm vs ${Math.round(r.truth.widthMm)}×${Math.round(r.truth.heightMm)}`,
      );
  }
  if (d.blurred !== d.expectBlurred) out.push(d.blurred ? 'false blur flag' : 'blur not flagged');
  const m = r.filters.document?.metrics;
  if (m) {
    if (m.inkRecall < 0.95) out.push(`ink recall ${pct(m.inkRecall)}`);
    if (m.spurious > 0.02) out.push(`spurious ink ${pct(m.spurious)}`);
    if (m.white < 0.99) out.push(`paper white ${pct(m.white)}`);
    if (m.weight > 1.25 || m.weight < 0.8) out.push(`stroke weight ×${num(m.weight, 2)}`);
    for (const [k, v] of Object.entries(m.colours))
      if (v < 0.8) out.push(`colour ${k} ${pct(v, 0)}`);
    for (const [k, v] of Object.entries(m.tints))
      if (v < 180) out.push(`tint ${k} dark (${v.toFixed(0)})`);
    if (m.textTinted > 0.02) out.push(`text coloured ${pct(m.textTinted)}`);
  }
  if (r.filters.bw?.binary !== undefined && r.filters.bw.binary < 0.999)
    out.push(`B&W not binary (${pct(r.filters.bw.binary, 2)})`);
  if (r.pdfCheck && !r.pdfCheck.valid) out.push('PDF invalid');
  if (r.text) {
    if (r.text.cer > 0.05) out.push(`CER ${pct(r.text.cer)}`);
    if (r.text.special) {
      const lost = Object.entries(r.text.special)
        .filter(([, [t, g]]) => g < t)
        .map(([c, [t, g]]) => `${c} ${g}/${t}`);
      if (lost.length) out.push(`chars lost: ${lost.join(' ')}`);
    }
  }
  return out;
}

export function writeReport(dir, results, meta = {}, baseline = null) {
  const ok = results.filter((r) => !r.error);
  const L = [];
  L.push('# Tessel scan quality report', '');
  L.push(
    `Generated ${meta.date ?? new Date().toISOString()} by \`npm run test:scan\` at commit ${meta.commit ?? '?'}${meta.dirty ? ' (src modified)' : ''}. ${ok.length} cases, ${results.length - ok.length} failed.`,
    '',
  );
  L.push(
    'Synthetic phone photos (e2e/scan/scene.ts) of synthetic documents (e2e/scan/corpus.ts) with known corners and text,',
    'run through the real detector, processor and OCR workers and `exportPdf`. Ink metrics compare the Document filter output',
    'against the printed page mapped exactly into the output frame (so detection error does not count as lost ink).',
    '"true crop" = Document filter on the true corners (filter quality alone). CER from `pdftotext` of the saved PDF;',
    '"clean CER" = the same OCR on the perfect printed page (the OCR model\'s own ceiling).',
    '',
  );
  L.push('## Summary', '');
  L.push(
    '| case | det conf | corner err max px | aspect err | PDF page | blur (score) | ink recall | true-crop recall | spurious | weight | paper white | colours kept (min) | tints min luma | PDF KB | CER | clean CER | words in order | flags |',
  );
  L.push('|' + ' --- |'.repeat(18));
  for (const r of results) {
    if (r.error) {
      L.push(
        `| ${r.id} | FAILED: ${r.error.replace(/\|/g, '/').slice(0, 120)} |` + ' |'.repeat(16),
      );
      continue;
    }
    const d = r.detection;
    const m = r.filters.document?.metrics ?? {};
    const colours = Object.values(m.colours ?? {}).filter((v) => !Number.isNaN(v));
    const tints = Object.values(m.tints ?? {}).filter((v) => !Number.isNaN(v));
    const page = r.output.format
      ? `${r.output.format}${r.output.pageMm[0] > r.output.pageMm[1] ? ' L' : ''}`
      : `${Math.round(r.output.pageMm[0])}×${Math.round(r.output.pageMm[1])}mm`;
    L.push(
      `| ${r.id} | ${d.found ? num(d.confidence, 2) : '**none**'} | ${num(Math.max(...d.cornerErr), 1)} | ${pct(r.output.aspectErr)} | ${page} | ${d.blurred ? '**blurred**' : 'sharp'} (${num(d.sharpness, 2)}) | ${pct(m.inkRecall)} | ${pct(r.truthCrop.inkRecall)} | ${pct(m.spurious, 2)} | ${num(m.weight, 2)} | ${pct(m.white, 2)} | ${colours.length ? pct(Math.min(...colours), 0) : '–'} | ${tints.length ? num(Math.min(...tints), 0) : '–'} | ${kb(r.pdf?.bytes)} | ${r.text ? pct(r.text.cer) : '–'} | ${r.ocrClean ? pct(r.ocrClean.cer) : '–'} | ${r.text ? pct(r.text.words.ordered, 0) : '–'} | ${flags(r).join('; ')} |`,
    );
  }
  L.push('', '## Per filter: encoded image size (KB) and encode time (ms)', '');
  L.push(
    '| case | document | bw | gray | color | original | B&W binary | Gray-filter white | detect ms | PDF export ms (encode + OCR + write) |',
  );
  L.push('|' + ' --- |'.repeat(10));
  for (const r of ok) {
    const f = r.filters;
    const cell = (k) => (f[k] ? `${kb(f[k].bytes)} / ${f[k].ms}` : '–');
    L.push(
      `| ${r.id} | ${cell('document')} | ${cell('bw')} | ${cell('gray')} | ${cell('color')} | ${cell('original')} | ${pct(f.bw?.binary, 2)} | ${pct(f.gray?.metrics?.white, 1)} | ${r.timings.detect} | ${r.pdf?.ms ?? '–'} |`,
    );
  }
  const colourRows = ok.filter(
    (r) => Object.keys(r.filters.document?.metrics?.colours ?? {}).length,
  );
  if (colourRows.length) {
    L.push('', '## Colour regions kept in colour by the Document filter (same hue, saturated)', '');
    for (const r of colourRows) {
      const c = r.filters.document.metrics.colours;
      const t = r.filters.document.metrics.tints;
      L.push(
        `- **${r.id}**: ${Object.entries(c)
          .map(([k, v]) => `${k} ${pct(v, 0)}`)
          .join(', ')}` +
          (Object.keys(t).length
            ? `; tints (mean luma): ${Object.entries(t)
                .map(([k, v]) => `${k} ${num(v, 0)}`)
                .join(', ')}`
            : ''),
      );
    }
  }
  const specials = ok.filter((r) => r.text?.special);
  if (specials.length) {
    L.push('', '## Special characters (truth count → found in PDF text)', '');
    for (const r of specials) {
      L.push(
        `- **${r.id}**: ${Object.entries(r.text.special)
          .map(([c, [t, g]]) => `${c} ${t}→${g}`)
          .join(', ')}`,
      );
    }
  }
  const colourCases = ok.filter((r) =>
    Object.values(r.trueCropFilters ?? r.filters).some((f) => f.colour),
  );
  if (colourCases.length) {
    L.push('', '## Colour and photo pages, per filter (on the true crop)', '');
    L.push(
      'Every filter is rendered from the true corners here, so filter behaviour is measured even where detection failed',
      '(see the summary table for detection). Artifacts: `<case>/filters_truecrop_side_by_side.jpg`.',
      'text contrast = luma around dark text minus luma of the text (255 = black on white; < 60 hard to read);',
      'reversed = luma of white/light text minus its dark ground (negative = the light text is lost or darker than its ground).',
      'grounds: output mean RGB (truth RGB) and share of exact white. photos: luma correlation with the print / share posterised to pure black-white / share of non-white photo pixels hollowed to white.',
      'CER and "over colour" (share of words printed over colour that OCR found) are from OCR of that filter\'s output; the PDF uses Document.',
      '',
    );
    L.push(
      '| case | filter | text contrast | reversed | ink recall | colours kept (min) | grounds: out (truth) white% | photos corr/posterised/hollow | CER | over colour |',
    );
    L.push('|' + ' --- |'.repeat(10));
    for (const r of colourCases) {
      for (const [name, f] of Object.entries(r.trueCropFilters ?? r.filters)) {
        const c = f.colour;
        if (!c) continue;
        const m = f.metrics ?? {};
        const cols = Object.values(m.colours ?? {}).filter((v) => !Number.isNaN(v));
        const grounds = Object.entries(c.grounds)
          .map(([k, g]) => `${k} ${g.out.join(',')} (${g.truth.join(',')}) ${pct(g.white, 0)}`)
          .join('; ');
        const photos = Object.entries(c.photos)
          .map(([k, p]) => `${k} ${num(p.corr, 2)}/${pct(p.extremes, 0)}/${pct(p.hollow, 0)}`)
          .join('; ');
        L.push(
          `| ${r.id} | ${name} | ${num(c.textContrast, 0)} | ${num(c.reversedContrast, 0)} | ${pct(m.inkRecall)} | ${cols.length ? pct(Math.min(...cols), 0) : '–'} | ${grounds || '–'} | ${photos || '–'} | ${f.text ? pct(f.text.cer) : '–'} | ${f.text?.zoneRecall !== undefined ? pct(f.text.zoneRecall, 0) : '–'} |`,
        );
      }
    }
  }
  if (baseline) {
    const before = new Map(baseline.results.filter((r) => !r.error).map((r) => [r.id, r]));
    L.push('', `## Before / after (baseline: commit ${baseline.meta?.commit ?? '?'})`, '');
    L.push(
      '| case | corner err max px before → after | CER before → after | ink recall before → after | paper white before → after |',
    );
    L.push('|' + ' --- |'.repeat(5));
    for (const r of ok) {
      const b = before.get(r.id);
      if (!b) continue;
      const ce = (x) => num(Math.max(...x.detection.cornerErr), 1);
      L.push(
        `| ${r.id} | ${ce(b)} → ${ce(r)} | ${b.text ? pct(b.text.cer) : '–'} → ${r.text ? pct(r.text.cer) : '–'} | ${pct(b.filters.document?.metrics?.inkRecall)} → ${pct(r.filters.document?.metrics?.inkRecall)} | ${pct(b.filters.document?.metrics?.white, 2)} → ${pct(r.filters.document?.metrics?.white, 2)} |`,
      );
    }
  }
  L.push('', '## Artifacts', '');
  L.push(
    'Per case in `<case>/`: `photo.jpg` (input), `side_by_side.jpg` (photo with true quad green / detected red, Original, Document, truth),',
    '`out_document.png` (full resolution, as in the PDF), `out_{bw,gray,color,original}.jpg`, `diff_truthcrop.png` / `diff_detail.png`',
    '(black = kept text, red = lost text, blue = ink where nothing was printed, grey = non-white), `scan.pdf`, `pdftotext.txt`, `truth.txt`,',
    '`ocr_clean.txt` and `ocr_clean_boxes.png` (OCR on the perfect page), `result.json` (all metrics). Colour cases also have',
    '`filters_side_by_side.jpg` (photo | every filter | printed page) and `ocr_<filter>.txt`.',
  );
  writeFileSync(join(dir, 'report.md'), L.join('\n') + '\n');
}
