import { describe, expect, it } from 'vitest';
import {
  ctcDecode,
  detectionBoxes,
  detectionSize,
  lineWords,
  readingOrder,
  recognitionInput,
  recognitionWidth,
  REC_HEIGHT,
} from '../engine/ocr/paddle';
import { buildPdf } from '../engine/pdf/writer';
import { fill } from './helpers';

describe('detection', () => {
  it('sizes the detector input to multiples of 32 within the limit', () => {
    expect(detectionSize(2480, 3508, 1280)).toEqual({ width: 896, height: 1280 });
    expect(detectionSize(100, 50, 1280)).toEqual({ width: 96, height: 64 });
  });

  it('turns the probability map into grown, ordered boxes', () => {
    const w = 200;
    const h = 100;
    const prob = new Float32Array(w * h);
    const paint = (x0: number, y0: number, x1: number, y1: number, p: number) => {
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) prob[y * w + x] = p;
    };
    paint(110, 20, 180, 30, 0.9); // second word on line 1
    paint(10, 20, 90, 30, 0.9); // first word on line 1
    paint(10, 60, 150, 70, 0.9); // line 2
    paint(10, 85, 40, 95, 0.4); // above threshold, but too unsure
    const boxes = detectionBoxes(prob, w, h);
    expect(boxes).toHaveLength(3);
    expect(boxes[0].x0).toBeLessThan(10);
    expect(boxes[1].x0).toBeGreaterThan(100);
    expect(boxes[2].y0).toBeGreaterThan(50);
    // Grown beyond the kernel on every side.
    expect(boxes[0].y0).toBeLessThan(20);
    expect(boxes[0].y1).toBeGreaterThan(30);
  });

  it('follows a tilted line and ignores a blob touching its end', () => {
    const w = 400;
    const h = 120;
    const prob = new Float32Array(w * h);
    // A line 10 px tall that drops 20 px over 300 px.
    for (let x = 60; x < 360; x++) {
      const top = Math.round(40 + ((x - 60) * 20) / 300);
      for (let y = top; y < top + 10; y++) prob[y * w + x] = 0.9;
    }
    // A smudge touching the line's left end, three times as tall.
    for (let y = 40; y < 75; y++) for (let x = 40; x < 66; x++) prob[y * w + x] = 0.9;
    const [box] = detectionBoxes(prob, w, h);
    expect(box.yr! - box.yl!).toBeGreaterThan(15);
    // Height comes from the line (10 px, grown), not the smudge (35 px).
    expect(box.height!).toBeLessThan(30);
    // The smudge is trimmed off the start.
    expect(box.x0).toBeGreaterThan(45);
  });

  it('centres lines in edge coordinates, like the crop that samples them', () => {
    const w = 200;
    const h = 60;
    const prob = new Float32Array(w * h);
    // Rows 20..29 are pixels spanning y = 20 to 30: centre 25, not 24.5.
    for (let y = 20; y < 30; y++) for (let x = 40; x < 160; x++) prob[y * w + x] = 0.9;
    const [box] = detectionBoxes(prob, w, h);
    expect(box.yl).toBeCloseTo(25, 5);
    expect(box.yr).toBeCloseTo(25, 5);
    expect((box.y0 + box.y1) / 2).toBeCloseTo(25, 5);
    expect((box.x0 + box.x1) / 2).toBeCloseTo(100, 5);
  });

  it('orders boxes the same whatever order they come in', () => {
    const box = (x0: number, y0: number, x1: number, y1: number) => ({ x0, y0, x1, y1, score: 1 });
    const boxes = [
      box(10, 0, 60, 100), // tall, centre 50: a large heading or a stamp
      box(100, 40, 150, 50), // small, centre 45: too far above to share its line
      box(200, 60, 250, 70), // small, centre 65: too far below
      box(100, 46, 140, 54), // small, centre 50: on the tall box's line
      box(300, 190, 350, 200),
    ];
    const key = (list: { x0: number; y0: number }[]) =>
      list.map((b) => `${b.x0},${b.y0}`).join(' ');
    const expected = key(readingOrder(boxes));
    // Every rotation and its reverse: a consistent order does not depend on input order.
    for (let k = 0; k < boxes.length; k++) {
      const rotated = [...boxes.slice(k), ...boxes.slice(0, k)];
      expect(key(readingOrder(rotated))).toBe(expected);
      expect(key(readingOrder(rotated.reverse()))).toBe(expected);
    }
    // A small box only shares a line with what is within half its own height.
    expect(expected).toBe('100,40 10,0 100,46 200,60 300,190');
  });
});

describe('recognition', () => {
  it('buckets widths so input shapes repeat', () => {
    expect(recognitionWidth(100)).toBe(160);
    expect(recognitionWidth(161)).toBe(224);
    expect(recognitionWidth(5000)).toBe(2400);
    for (const w of [50, 300, 700, 1500]) expect(recognitionWidth(w)).toBeGreaterThanOrEqual(w);
  });

  it('crops, scales to 48 px and pads with mid-grey like PaddleOCR', () => {
    const img = fill(400, 100, [0, 0, 0]);
    const input = recognitionInput(img, { x0: 0, y0: 0, x1: 192, y1: 48, score: 1 });
    expect(input.textWidth).toBe(192);
    expect(input.width).toBe(224);
    expect(input.tensor.length).toBe(3 * REC_HEIGHT * 224);
    expect(input.tensor[0]).toBeCloseTo(-1); // black text area
    expect(input.tensor[223]).toBe(0); // padding is 0 after scaling
  });

  it('decodes CTC output, collapsing repeats and blanks', () => {
    const dict = ['a', 'b', 'c'];
    const classes = dict.length + 2; // blank, a, b, c, space
    // a a _ b space c c
    const path = [1, 1, 0, 2, 4, 3, 3];
    const probs = new Float32Array(path.length * classes);
    path.forEach((c, t) => (probs[t * classes + c] = 0.9));
    const line = ctcDecode(probs, path.length, classes, dict);
    expect(line.text).toBe('ab c');
    expect(line.steps).toEqual([0, 3, 4, 5]);
    expect(line.confidence).toBeCloseTo(0.9);
  });

  it('decodes characters outside the BMP as one character each', () => {
    const dict = ['a', '𝑢', 'b'];
    const classes = dict.length + 2;
    // a 𝑢 space b
    const path = [1, 2, 4, 3];
    const probs = new Float32Array(path.length * classes);
    path.forEach((c, t) => (probs[t * classes + c] = 0.9));
    const line = ctcDecode(probs, path.length, classes, dict);
    expect(line.text).toBe('a𝑢 b');
    expect(line.steps).toEqual([0, 1, 2, 3]);

    const box = { x0: 0, y0: 0, x1: 400, y1: 20, score: 1 };
    const words = lineWords(line, box, 4);
    expect(words.map((w) => w.text)).toEqual(['a𝑢', 'b']);
    for (const w of words) {
      for (const v of [w.x0, w.y0, w.x1, w.y1]) expect(Number.isFinite(v)).toBe(true);
    }
    // 'b' was read at step 3 of 4, the last quarter of the line.
    expect(words[1].x0).toBeGreaterThanOrEqual(300 - 50);
    expect(words[0].x1).toBeLessThanOrEqual(words[1].x0);
  });

  it('splits a line into words placed where they were read', () => {
    const line = { text: 'Hallo Welt', confidence: 0.95, steps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] };
    const box = { x0: 100, y0: 10, x1: 300, y1: 40, score: 1 };
    const words = lineWords(line, box, 10);
    expect(words.map((w) => w.text)).toEqual(['Hallo', 'Welt']);
    expect(words[0].x0).toBeGreaterThanOrEqual(100);
    expect(words[0].x1).toBeLessThan(words[1].x0);
    expect(words[1].x1).toBeLessThanOrEqual(300);
  });
});

describe('reading order', () => {
  const box = (x0: number, y0: number, x1: number, y1: number, score = 1) => ({ x0, y0, x1, y1, score });
  const order = (boxes: ReturnType<typeof box>[], names: string[]) => readingOrder(boxes).map((b) => names[boxes.indexOf(b)]);

  it('reads two columns of text one after the other', () => {
    // Left column at lines 0, 30, 60, 90; right column, in smaller type, at 15, 40, 65.
    const boxes = [box(0, 0, 200, 20), box(0, 30, 200, 50), box(0, 60, 200, 80), box(0, 90, 200, 110), box(300, 15, 500, 29), box(300, 40, 500, 54), box(300, 65, 500, 79)];
    expect(order(boxes, ['L1', 'L2', 'L3', 'L4', 'R1', 'R2', 'R3'])).toEqual(['L1', 'L2', 'L3', 'L4', 'R1', 'R2', 'R3']);
  });

  it('reads two typeset columns down, even with their lines level', () => {
    const boxes: ReturnType<typeof box>[] = [];
    for (let i = 0; i < 6; i++) boxes.push(box(100, 100 + i * 40, 900, 125 + i * 40), box(960, 100 + i * 40, 1760, 125 + i * 40));
    const names = boxes.map((_, i) => `${i % 2 ? 'R' : 'L'}${i >> 1}`);
    expect(order(boxes, names)).toEqual(['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'R0', 'R1', 'R2', 'R3', 'R4', 'R5']);
  });

  it("reads a form's labels and values across, row by row", () => {
    const boxes = [box(0, 0, 100, 20), box(300, 0, 400, 20), box(0, 30, 100, 50), box(300, 31, 400, 51), box(0, 60, 100, 80), box(300, 59, 400, 79)];
    expect(order(boxes, ['Datum', 'd', 'Zahlbar', 'z', 'Kunde', 'k'])).toEqual(['Datum', 'd', 'Zahlbar', 'z', 'Kunde', 'k']);
  });

  it('reads a table with several cells per row across', () => {
    const names = ['Item', 'Qty', 'Price', 'Thing', '1', '20.00', 'Other', '2', '5.00'];
    const boxes = [
      box(0, 0, 150, 22), box(300, -3, 340, 17), box(400, -3, 460, 17),
      box(0, 30, 150, 50), box(300, 30, 310, 50), box(400, 30, 460, 50),
      box(0, 60, 150, 80), box(300, 60, 310, 80), box(400, 60, 450, 80),
    ];
    expect(order(boxes, names)).toEqual(names);
  });

  it("reads an invoice's long descriptions and their amounts across, row by row", () => {
    const boxes: ReturnType<typeof box>[] = [];
    for (let r = 0; r < 6; r++) boxes.push(box(100, 500 + r * 45, 480 + (r % 2) * 20, 530 + r * 45), box(700, 500 + r * 45, 780, 530 + r * 45));
    const names = boxes.map((_, i) => `${i % 2 ? 'amount' : 'item'}${i >> 1}`);
    expect(order(boxes, names)).toEqual(names);
  });

  it('reads a band across the page before the columns under it', () => {
    const boxes = [box(0, 0, 500, 20), box(0, 60, 200, 80), box(0, 90, 200, 110), box(0, 120, 200, 140), box(300, 70, 500, 84), box(300, 95, 500, 109)];
    expect(order(boxes, ['Title', 'L1', 'L2', 'L3', 'R1', 'R2'])).toEqual(['Title', 'L1', 'L2', 'L3', 'R1', 'R2']);
  });
});

describe('searchable PDF', () => {
  it('writes an invisible, positioned text layer with WinAnsi text', async () => {
    const pdf = buildPdf([
      {
        pixelWidth: 1000,
        pixelHeight: 1414,
        width: 595.28,
        height: 841.89,
        image: { kind: 'jpeg', bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), components: 3 },
        words: [
          { text: 'Grüße', x0: 100, y0: 100, x1: 220, y1: 130 },
          { text: '(1)', x0: 240, y0: 100, x1: 280, y1: 130 },
          { text: '€5', x0: 300, y0: 100, x1: 340, y1: 130 },
        ],
      },
    ]);
    const text = Buffer.from(await pdf.arrayBuffer()).toString('latin1');
    expect(text).toContain('/BaseFont /Helvetica /Encoding /WinAnsiEncoding');
    expect(text).toContain('/Font << /F0 4 0 R >>');
    expect(text).toContain(' BT 3 Tr'); // render mode 3: invisible
    expect(text).toContain('(Gr\\374\\337e ) Tj'); // ü ß as WinAnsi octal, a space before the next word
    expect(text).toContain('(\\(1\\) ) Tj'); // parentheses escaped
    expect(text).toContain('(\\2005) Tj'); // € is 0x80 in WinAnsi; the line's last word has no space
    expect(text).toMatch(/\d+(\.\d+)? Tz 1 0 0 1 [\d.]+ [\d.]+ Tm/);
  });

  const page = (words: { text: string; x0: number; y0: number; x1: number; y1: number }[]) => ({
    pixelWidth: 1000,
    pixelHeight: 1000,
    width: 500,
    height: 500,
    image: {
      kind: 'jpeg' as const,
      bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      components: 3 as const,
    },
    words,
  });
  const pdfText = async (blob: Blob) => Buffer.from(await blob.arrayBuffer()).toString('latin1');
  /** Each drawn word: font size, horizontal scale, and the string operand. */
  const drawn = (text: string) =>
    [
      ...text.matchAll(/\/F0 ([\d.]+) Tf ([\d.]+) Tz 1 0 0 1 [\d.]+ [\d.]+ Tm (\(.*?[^\\]\)) Tj/g),
    ].map((m) => ({ size: Number(m[1]), scale: Number(m[2]), string: m[3] }));

  it('separates words on a line with real spaces, not between lines', async () => {
    const text = await pdfText(
      buildPdf([
        page([
          { text: 'Zahlbar', x0: 0, y0: 0, x1: 70, y1: 20 },
          { text: 'bis', x0: 74, y0: 1, x1: 100, y1: 21 },
          { text: 'Datum', x0: 0, y0: 30, x1: 50, y1: 50 },
        ]),
      ]),
    );
    expect(drawn(text).map((d) => d.string)).toEqual(['(Zahlbar )', '(bis)', '(Datum)']);
    // The scale fits the word itself to its box, as when it is drawn alone; the space reaches past it.
    const alone = drawn(await pdfText(buildPdf([page([{ text: 'Zahlbar', x0: 0, y0: 0, x1: 70, y1: 20 }])])));
    expect(drawn(text)[0].scale).toBe(alone[0].scale);
  });

  it('escapes backslashes in words', async () => {
    const text = await pdfText(buildPdf([page([{ text: 'a\\b', x0: 0, y0: 0, x1: 50, y1: 20 }])]));
    expect(text).toContain('(a\\\\b) Tj');
  });

  it('writes typographic quotes and dashes as their WinAnsi bytes, at their own widths', async () => {
    const text = await pdfText(
      buildPdf([
        page([
          { text: '“Hi”–…', x0: 0, y0: 0, x1: 100, y1: 20 },
          { text: '’', x0: 0, y0: 100, x1: 10, y1: 120 },
        ]),
      ]),
    );
    expect(text).toContain('(\\223Hi\\224\\226\\205) Tj');
    expect(text).not.toContain('?');
    // The right single quote is 222/1000 em wide in Helvetica: the scale
    // stretches exactly that to the 5 pt wide box.
    const [, quote] = drawn(text);
    expect((quote.size * quote.scale * 0.222) / 100).toBeCloseTo(5, 1);
  });

  it('skips words with boxes that are not finite numbers', async () => {
    const text = await pdfText(
      buildPdf([
        page([
          { text: 'nan', x0: NaN, y0: 0, x1: 50, y1: 20 },
          { text: 'tall', x0: 0, y0: 0, x1: 50, y1: NaN },
          { text: 'inf', x0: 0, y0: -Infinity, x1: 50, y1: 20 },
          { text: 'ok', x0: 0, y0: 0, x1: 50, y1: 20 },
        ]),
      ]),
    );
    expect(text).not.toMatch(/NaN|Infinity/);
    expect(drawn(text).map((d) => d.string)).toEqual(['(ok)']);
  });

  it('sizes each word to its own line height', async () => {
    const text = await pdfText(
      buildPdf([
        page([
          { text: 'Title', x0: 0, y0: 0, x1: 300, y1: 80 },
          { text: 'body', x0: 0, y0: 100, x1: 80, y1: 120 },
        ]),
      ]),
    );
    const [title, body] = drawn(text);
    // 80 px and 20 px at half a point per pixel, 0.75 of the line.
    expect(title.size).toBeCloseTo(30);
    expect(body.size).toBeCloseTo(7.5);
  });

  it('leaves pages without words image-only', async () => {
    const pdf = buildPdf([
      {
        pixelWidth: 10,
        pixelHeight: 10,
        width: 72,
        height: 72,
        image: { kind: 'jpeg', bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), components: 3 },
      },
    ]);
    const text = Buffer.from(await pdf.arrayBuffer()).toString('latin1');
    expect(text).not.toContain('BT');
  });
});
