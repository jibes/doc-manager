import { deflateSync, inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { pageSizePoints } from '../engine/pdf/paper';
import { pngPredict } from '../engine/pdf/predict';
import { buildPdf } from '../engine/pdf/writer';

/** Reverse PNG row filters, as a PDF reader does for /Predictor 15. */
function unpredict(data: Uint8Array, width: number, height: number, channels: number): Uint8Array {
  const stride = width * channels;
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const type = data[y * (stride + 1)];
    for (let i = 0; i < stride; i++) {
      const raw = data[y * (stride + 1) + 1 + i];
      const a = i >= channels ? out[y * stride + i - channels] : 0;
      const b = y > 0 ? out[(y - 1) * stride + i] : 0;
      const c = y > 0 && i >= channels ? out[(y - 1) * stride + i - channels] : 0;
      let p = 0;
      if (type === 1) p = a;
      else if (type === 2) p = b;
      else if (type === 3) p = (a + b) >> 1;
      else if (type === 4) {
        const e = a + b - c;
        const pa = Math.abs(e - a);
        const pb = Math.abs(e - b);
        const pc = Math.abs(e - c);
        p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + i] = (raw + p) & 0xff;
    }
  }
  return out;
}

describe('pngPredict', () => {
  it('round-trips exactly', () => {
    const w = 300;
    const h = 200;
    const samples = new Uint8Array(w * h * 3).fill(255);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const d = Math.abs(((x + y) % 40) - 20);
        if (d < 3) samples.fill(d * 80, (y * w + x) * 3, (y * w + x) * 3 + 3);
      }
    }
    expect(unpredict(pngPredict(samples, w, h, 3), w, h, 3)).toEqual(samples);
  });

  it('wins on smooth tones, which is what it is for', () => {
    const w = 256;
    const h = 256;
    const samples = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++)
        samples[y * w + x] = (x * 0.7 + y * 0.3 + Math.sin(x / 9) * 6) & 0xff;
    }
    expect(deflateSync(pngPredict(samples, w, h, 1)).length).toBeLessThan(
      deflateSync(samples).length,
    );
  });
});

describe('buildPdf', () => {
  async function parse(blob: Blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return { bytes, text: Buffer.from(bytes).toString('latin1') };
  }

  it('writes a structurally valid multi-page PDF', async () => {
    const gray = new Uint8Array(4 * 3).fill(200);
    const predicted = pngPredict(gray, 4, 3, 1);
    const pdf = buildPdf(
      [
        {
          pixelWidth: 4,
          pixelHeight: 3,
          width: 595.28,
          height: 841.89,
          image: {
            kind: 'flate',
            bytes: new Uint8Array(deflateSync(predicted)),
            components: 1,
            predictor: true,
          },
        },
        {
          pixelWidth: 2,
          pixelHeight: 2,
          width: 612,
          height: 792,
          image: { kind: 'jpeg', bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), components: 3 },
        },
      ],
      { title: 'Rechnung März', created: new Date(2026, 9, 10, 14, 30) },
    );
    const { text } = await parse(pdf);

    expect(text.startsWith('%PDF-1.7\n')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(text).toContain('/Count 2');
    expect(text).toContain('/MediaBox [0 0 595.28 841.89]');
    expect(text).toContain('/MediaBox [0 0 612 792]');
    expect(text).toContain('/DCTDecode');
    expect(text).toContain(
      '/DecodeParms << /Predictor 15 /Colors 1 /BitsPerComponent 8 /Columns 4 >>',
    );
    expect(text).toContain('/CreationDate (D:20261010143000');

    // Every xref entry points at the start of its object.
    const startxref = Number(/startxref\n(\d+)/.exec(text)![1]);
    const rows = text.slice(startxref).split('\n');
    const count = Number(rows[1].split(' ')[1]);
    for (let id = 1; id < count; id++) {
      const offset = Number(rows[2 + id].slice(0, 10));
      expect(text.startsWith(`${id} 0 obj`, offset)).toBe(true);
    }
    expect(text).toContain(`/Size ${count}`);

    // Stream lengths are honest: the gray image inflates back to its pixels.
    const match = /\/Length (\d+) >>\nstream\n/.exec(text.slice(text.indexOf('/FlateDecode')))!;
    const start = text.indexOf('/FlateDecode') + match.index + match[0].length;
    const stream = (await parse(pdf)).bytes.subarray(start, start + Number(match[1]));
    expect(unpredict(inflateSync(stream), 4, 3, 1)).toEqual(gray);
  });

  it('encodes the title as UTF-16 so any language survives', async () => {
    const pdf = buildPdf(
      [
        {
          pixelWidth: 1,
          pixelHeight: 1,
          width: 72,
          height: 72,
          image: { kind: 'jpeg', bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), components: 3 },
        },
      ],
      { title: 'Ä' },
    );
    expect((await parse(pdf)).text).toContain('/Title <FEFF00C4>');
  });

  it('refuses an empty document', () => {
    expect(() => buildPdf([])).toThrow();
  });
});

describe('pageSizePoints', () => {
  it('recognises A4, Letter and Legal in either orientation', () => {
    expect(pageSizePoints(2480, 3508)).toMatchObject({ format: 'A4', width: 595.28 });
    expect(pageSizePoints(3508, 2480)).toMatchObject({ format: 'A4', width: 841.89 });
    expect(pageSizePoints(2550, 3300)).toMatchObject({ format: 'Letter', height: 792 });
    expect(pageSizePoints(2550, 4200)).toMatchObject({ format: 'Legal' });
  });

  it('sizes an ID-1 card and a till receipt from their shape', () => {
    const mm = (pt: number) => (pt / 72) * 25.4;
    const card = pageSizePoints(3000, 1892);
    expect(card.format).toBeNull();
    expect(card.basis).toBe('card');
    expect(mm(card.width)).toBeCloseTo(85.6, 1);
    expect(mm(card.height)).toBeCloseTo(53.98, 1);
    const receipt = pageSizePoints(600, 1260);
    expect(receipt.basis).toBe('receipt');
    expect(mm(receipt.width)).toBeCloseTo(80, 1);
    expect(mm(receipt.height)).toBeCloseTo(168, 0);
  });

  it('fits other shapes into A4 rather than inventing a resolution', () => {
    const square = pageSizePoints(2000, 2000);
    expect(square).toMatchObject({ format: null, basis: 'fit' });
    expect(square.width).toBeCloseTo(595.28);
    expect(square.height).toBeCloseTo(595.28);
    const wide = pageSizePoints(3000, 2000);
    expect(wide.width).toBeCloseTo(841.89);
    expect(wide.height).toBeCloseTo(561.26, 1);
  });

  it('claims no format for a crop whose shape is unknown', () => {
    // A 4:3 photo inset is within 3.5% of Letter, but it is not a Letter page.
    const guess = pageSizePoints(2903, 3871, { known: false });
    expect(guess).toMatchObject({ format: null, basis: 'fit' });
    expect(pageSizePoints(2480, 3508, { known: false }).format).toBeNull();
  });
});
