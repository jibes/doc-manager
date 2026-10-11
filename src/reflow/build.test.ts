import { describe, expect, it } from 'vitest';

import type { Graphic, TextLine } from '@/engine/types';
import { blockAt, buildReflow } from './build';

/** A body line at a given vertical position (0..1), 11pt, full measure. */
const line = (text: string, y: number, o: Partial<TextLine> = {}): TextLine => ({
  text,
  rect: { x: 0.12, y, w: 0.76, h: 0.014 },
  size: 11,
  bold: false,
  italic: false,
  hyphen: false,
  ...o,
});
const STEP = 0.02;
const para = (start: number, texts: string[], o: Partial<TextLine> = {}) => texts.map((t, i) => line(t, start + i * STEP, o));
const reflow = (pages: TextLine[][], graphics: Graphic[][] = []) => buildReflow(pages.map((lines, i) => ({ lines, graphics: graphics[i] ?? [] })));
const filler = 'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor';

describe('buildReflow', () => {
  it('removes running headers and page numbers but keeps body text', () => {
    const pages = [0, 1, 2, 3].map((i) => [
      line('Annual Report 2026', 0.04, { size: 8 }),
      ...para(0.15, [filler, filler, 'end of paragraph.']),
      line(String(i + 1), 0.95, { size: 8 }),
    ]);
    const { blocks } = reflow(pages);
    const text = blocks.map((b) => b.text).join('\n');
    expect(text).not.toContain('Annual Report');
    expect(text).not.toMatch(/^\d+$/m);
    expect(blocks.filter((b) => b.kind === 'p')).toHaveLength(4);
  });

  it('rejoins hyphenated words and wrapped lines', () => {
    const { blocks } = reflow([[...para(0.1, ['The quick brown fox jumps over the laz-', 'y dog and keeps running far away.'], {}), ...para(0.2, [filler, filler, 'done.'])]]);
    expect(blocks[0].text).toBe('The quick brown fox jumps over the lazy dog and keeps running far away.');
  });

  it('keeps hyphens that are not line-end word splits', () => {
    const { blocks } = reflow([[...para(0.1, ['A well-known fact that spans the whole measure of this line', 'Continues here with Capital start and more words.']), ...para(0.2, [filler, filler, 'done.'])]]);
    expect(blocks[0].text).toContain('well-known');
  });

  it('carries a paragraph across a page break', () => {
    const { blocks } = reflow([
      [...para(0.1, [filler, filler]), ...para(0.8, [filler, 'this sentence continues on'])],
      [...para(0.1, ['the next page and ends here.', filler, 'end.'])],
    ]);
    const joined = blocks.find((b) => b.text.includes('continues on the next page'));
    expect(joined?.page).toBe(0);
  });

  it('detects headings by size and splits paragraphs on larger gaps', () => {
    const { blocks } = reflow([
      [
        line('Big Title', 0.05, { size: 24 }),
        line('Section heading', 0.1, { size: 15 }),
        ...para(0.14, [filler, filler, 'first paragraph ends.']),
        ...para(0.24, [filler, filler, 'second paragraph ends.']),
      ],
    ]);
    expect(blocks.map((b) => b.kind)).toEqual(['h1', 'h2', 'p', 'p']);
  });

  it('treats long large-type text as a lead paragraph and splits off a following bold heading', () => {
    const lead = { size: 13 };
    const { blocks } = reflow([
      [
        line('CHAPTER 1', 0.03, { size: 8, bold: true }),
        line('Opening files', 0.05, { size: 26, bold: true }),
        ...para(0.1, ['Every PDF you open lands in Recent, newest first. Nothing leaves your', 'device.'], lead),
        line('Ways to open', 0.16, { size: 13, bold: true }),
        ...para(0.2, [filler, filler, 'body ends.']),
      ],
    ]);
    expect(blocks.map((b) => [b.kind, b.text.slice(0, 12)])).toEqual([
      ['label', 'CHAPTER 1'],
      ['h1', 'Opening file'],
      ['p', 'Every PDF yo'],
      ['h2', 'Ways to open'],
      ['p', 'Lorem ipsum '],
    ]);
  });

  it('turns bulleted lines into list items with markers', () => {
    const { blocks } = reflow([[...para(0.1, [filler, filler, 'intro:']), ...para(0.17, ['• First point', '• Second point', '2) Third point'])]]);
    const items = blocks.filter((b) => b.kind === 'li');
    expect(items.map((b) => [b.marker, b.text])).toEqual([
      ['•', 'First point'],
      ['•', 'Second point'],
      ['2)', 'Third point'],
    ]);
  });

  it('uses structure tags when present', () => {
    const { blocks, tagged } = reflow([
      [
        line('Report', 0.05, { role: 'H1', sid: 1, size: 11 }),
        ...para(0.1, [filler, 'one.'], { role: 'P', sid: 2 }),
        ...para(0.14, [filler, 'two.'], { role: 'P', sid: 3 }),
        line('item', 0.2, { role: 'LI', sid: 4 }),
      ],
    ]);
    expect(tagged).toBe(true);
    expect(blocks.map((b) => b.kind)).toEqual(['h1', 'p', 'p', 'li']);
  });

  it('splits runaway paragraphs so they stay renderable', () => {
    const lines = Array.from({ length: 150 }, (_, i) => line(filler, 0.05 + (i % 45) * STEP));
    const { blocks } = reflow([lines.slice(0, 45), lines.slice(45, 90), lines.slice(90, 135), lines.slice(135)]);
    expect(blocks.length).toBeGreaterThanOrEqual(3);
  });

  it('reports scanned documents as having no text', () => {
    expect(reflow([[], [line('3', 0.95)], []]).status).toBe('no-text');
  });

  it('maps page positions to blocks', () => {
    const { blocks } = reflow([[...para(0.1, [filler, 'a.']), ...para(0.5, [filler, 'b.'])], [...para(0.1, [filler, 'c.'])]]);
    expect(blockAt(blocks, 0, 0.3)).toBe(0);
    expect(blockAt(blocks, 0, 0.6)).toBe(1);
    expect(blockAt(blocks, 1, 0)).toBe(1);
    expect(blockAt(blocks, 1, 0.2)).toBe(2);
  });

  it('reads two columns column by column and joins a paragraph across the column break', () => {
    const col = (x: number, label: string, i: number, o: Partial<TextLine> = {}) =>
      line(`${label}${i} ${filler.slice(0, 40)}`, 0.2 + i * STEP, { rect: { x, y: 0.2 + i * STEP, w: 0.4, h: 0.014 }, ...o });
    const left = Array.from({ length: 20 }, (_, i) => col(0.08, 'L', i));
    const right = Array.from({ length: 20 }, (_, i) =>
      i === 4 ? { ...col(0.52, 'R', i), text: 'R4 end of first.', rect: { x: 0.52, y: 0.28, w: 0.2, h: 0.014 } } : col(0.52, 'R', i),
    );
    right[19].text += '.';
    // Worst case: the PDF interleaves the columns row by row.
    const title = line('A Two Column Paper', 0.08, { size: 20, rect: { x: 0.08, y: 0.08, w: 0.84, h: 0.03 } });
    const { blocks } = reflow([[title, ...left.flatMap((l, i) => [l, right[i]])]]);
    expect(blocks.map((b) => b.kind)).toEqual(['h1', 'p', 'p']);
    const first = blocks[1].text;
    expect(first.startsWith('L0')).toBe(true);
    expect(first.indexOf('L19')).toBeLessThan(first.indexOf('R0'));
    expect(first.endsWith('end of first.')).toBe(true);
    expect(blocks[2].text.startsWith('R5')).toBe(true);
    expect(blockAt(blocks, 0, 0.25)).toBe(1);
  });

  it('places figures inline with their caption and resumes the interrupted paragraph', () => {
    const page = [
      ...para(0.1, [filler, filler, 'and the sentence goes on']),
      line('Axis label', 0.3, { size: 7, rect: { x: 0.3, y: 0.3, w: 0.1, h: 0.01 } }),
      line('Figure 1: A chart of things.', 0.47, { size: 9 }),
      line('to finish after the figure.', 0.5),
      ...para(0.56, ['Another paragraph starts here', filler, 'done.']),
    ];
    const { blocks } = reflow([page], [[{ rect: { x: 0.2, y: 0.25, w: 0.6, h: 0.2 }, image: true, parts: 1 }]]);
    expect(blocks.map((b) => b.kind)).toEqual(['p', 'figure', 'caption', 'p']);
    expect(blocks[0].text.endsWith('goes on to finish after the figure.')).toBe(true);
    expect(blocks[1].text).toBe('Axis label');
    expect(blocks[1].rect!.y).toBeLessThanOrEqual(0.25);
    expect(blocks[2].text).toBe('Figure 1: A chart of things.');
  });

  it('ignores logos in the margins and drawings repeated on every page', () => {
    const pages = [0, 1, 2, 3].map(() => [...para(0.15, [filler, filler, 'end of paragraph.'])]);
    const logo: Graphic = { rect: { x: 0.1, y: 0.02, w: 0.15, h: 0.05 }, image: true, parts: 1 };
    const stamp: Graphic = { rect: { x: 0.6, y: 0.5, w: 0.3, h: 0.2 }, image: true, parts: 1 };
    const { blocks } = reflow(pages, pages.map(() => [logo, stamp]));
    expect(blocks.some((b) => b.kind === 'figure')).toBe(false);
  });

  it('keeps tables as drawn instead of flattening their cells into text', () => {
    const row = (y: number, cells: string[]) => cells.map((c, i) => line(c, y, { rect: { x: 0.12 + i * 0.28, y, w: 0.1, h: 0.014 } }));
    const page = [
      ...para(0.1, [filler, filler, 'see the table below.']),
      ...row(0.3, ['Name', 'Size', 'Year']),
      ...row(0.32, ['Alpha', '12 kg', '2019']),
      ...row(0.34, ['Beta', '7 kg', '2021']),
      ...row(0.36, ['Gamma', '31 kg', '2024']),
      ...para(0.45, ['After the table', filler, 'done.']),
    ];
    const { blocks } = reflow([page]);
    expect(blocks.map((b) => b.kind)).toEqual(['p', 'figure', 'p']);
    expect(blocks[1].table).toBe(true);
    expect(blocks[1].text).toContain('Beta · 7 kg · 2021');
    expect(blocks.filter((b) => b.kind === 'p').map((b) => b.text).join(' ')).not.toContain('Gamma');
  });

  it('keeps tagged tables as drawn', () => {
    const page = [
      line('Intro paragraph with enough words to count.', 0.1, { role: 'P', sid: 1 }),
      line('Cell A', 0.2, { role: 'TD', sid: 2, rect: { x: 0.1, y: 0.2, w: 0.2, h: 0.014 } }),
      line('Cell B', 0.2, { role: 'TD', sid: 3, rect: { x: 0.4, y: 0.2, w: 0.2, h: 0.014 } }),
      line('Closing paragraph with enough words to count.', 0.3, { role: 'P', sid: 4 }),
    ];
    const { blocks } = reflow([page]);
    expect(blocks.map((b) => b.kind)).toEqual(['p', 'figure', 'p']);
  });
});
