import { describe, expect, it } from 'vitest';

import type { TextLine } from '@/engine/types';
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
const filler = 'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor';

describe('buildReflow', () => {
  it('removes running headers and page numbers but keeps body text', () => {
    const pages = [0, 1, 2, 3].map((i) => [
      line('Annual Report 2026', 0.04, { size: 8 }),
      ...para(0.15, [filler, filler, 'end of paragraph.']),
      line(String(i + 1), 0.95, { size: 8 }),
    ]);
    const { blocks } = buildReflow(pages);
    const text = blocks.map((b) => b.text).join('\n');
    expect(text).not.toContain('Annual Report');
    expect(text).not.toMatch(/^\d+$/m);
    expect(blocks.filter((b) => b.kind === 'p')).toHaveLength(4);
  });

  it('rejoins hyphenated words and wrapped lines', () => {
    const { blocks } = buildReflow([[...para(0.1, ['The quick brown fox jumps over the laz-', 'y dog and keeps running far away.'], {}), ...para(0.2, [filler, filler, 'done.'])]]);
    expect(blocks[0].text).toBe('The quick brown fox jumps over the lazy dog and keeps running far away.');
  });

  it('keeps hyphens that are not line-end word splits', () => {
    const { blocks } = buildReflow([[...para(0.1, ['A well-known fact that spans the whole measure of this line', 'Continues here with Capital start and more words.']), ...para(0.2, [filler, filler, 'done.'])]]);
    expect(blocks[0].text).toContain('well-known');
  });

  it('carries a paragraph across a page break', () => {
    const { blocks } = buildReflow([
      [...para(0.1, [filler, filler]), ...para(0.8, [filler, 'this sentence continues on'])],
      [...para(0.1, ['the next page and ends here.', filler, 'end.'])],
    ]);
    const joined = blocks.find((b) => b.text.includes('continues on the next page'));
    expect(joined?.page).toBe(0);
  });

  it('detects headings by size and splits paragraphs on larger gaps', () => {
    const { blocks } = buildReflow([
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
    const { blocks } = buildReflow([
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
    const { blocks } = buildReflow([[...para(0.1, [filler, filler, 'intro:']), ...para(0.17, ['• First point', '• Second point', '2) Third point'])]]);
    const items = blocks.filter((b) => b.kind === 'li');
    expect(items.map((b) => [b.marker, b.text])).toEqual([
      ['•', 'First point'],
      ['•', 'Second point'],
      ['2)', 'Third point'],
    ]);
  });

  it('uses structure tags when present', () => {
    const { blocks, tagged } = buildReflow([
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
    const { blocks } = buildReflow([lines.slice(0, 45), lines.slice(45, 90), lines.slice(90, 135), lines.slice(135)]);
    expect(blocks.length).toBeGreaterThanOrEqual(3);
  });

  it('reports scanned documents as having no text', () => {
    expect(buildReflow([[], [line('3', 0.95)], []]).status).toBe('no-text');
  });

  it('maps page positions to blocks', () => {
    const { blocks } = buildReflow([[...para(0.1, [filler, 'a.']), ...para(0.5, [filler, 'b.'])], [...para(0.1, [filler, 'c.'])]]);
    expect(blockAt(blocks, 0, 0.3)).toBe(0);
    expect(blockAt(blocks, 0, 0.6)).toBe(1);
    expect(blockAt(blocks, 1, 0)).toBe(1);
    expect(blockAt(blocks, 1, 0.2)).toBe(2);
  });
});
