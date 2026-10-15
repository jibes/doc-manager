import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { linkTarget, openBook, CHARS_PER_PAGE } from './index';
import { readPackage, resolvePath } from './epub';
import { imageSize } from './image';

const load = (f: string) => openBook(new Uint8Array(readFileSync(`e2e/fixtures/${f}`)));

describe('openBook (EPUB 3)', () => {
  const book = load('book.epub');

  it('reads metadata, cover and the nav table of contents', () => {
    expect(book.title).toBe('Harbour Notes');
    expect(book.author).toBe('Ada Quay');
    expect(book.cover).toBe('OEBPS/images/cover.png');
    expect(book.images[book.cover!].bytes.length).toBeGreaterThan(100);
    expect(book.toc.map((e) => [e.title, e.depth])).toEqual([
      ['The Harbour', 0],
      ['The Quarry', 0],
      ['At dusk', 1],
      ['Notes', 0],
    ]);
  });

  it('turns chapter markup into blocks with inline formatting', () => {
    const kinds = book.blocks.slice(0, 12).map((b) => b.kind);
    expect(kinds.slice(0, 2)).toEqual(['h1', 'p']);
    expect(book.blocks[0].text).toBe('Chapter One\nThe Harbour');
    const first = book.blocks[1];
    expect(first.runs?.find((r) => r.em)?.text).toBe('the tide');
    expect(first.runs?.find((r) => r.strong)?.text).toBe('very');
    const ref = first.runs?.find((r) => r.sup);
    expect(ref?.href).toBe('OEBPS/text/notes.xhtml#n1');
    expect(kinds).toContain('quote');
    expect(book.blocks.filter((b) => b.kind === 'li').map((b) => b.marker)).toEqual(['1.', '2.', '3.']);
    expect(kinds).toContain('rule');
    const fig = book.blocks.find((b) => b.kind === 'figure')!;
    expect(fig).toMatchObject({ src: 'OEBPS/images/map.png', text: 'Map of the harbour', imgW: 800, imgH: 450 });
    expect(book.blocks.find((b) => b.kind === 'caption')?.text).toBe('Figure 1. The harbour at low tide.');
    expect(book.blocks.some((b) => b.text === 'Boat · Crates' && b.runs?.every((r) => r.strong || r.text === ' · '))).toBe(true);
    expect(book.blocks.find((b) => b.kind === 'code')?.text).toBe('ledger  12\ncrates   7');
    expect(book.blocks.some((b) => b.text.includes(' See'))).toBe(true);
  });

  it('skips non-linear items and resolves links and footnotes', () => {
    expect(book.blocks.some((b) => b.text === 'Contents')).toBe(false);
    const note = linkTarget(book, 'OEBPS/text/notes.xhtml#n1')!;
    expect(book.blocks[note].text).toMatch(/^1\. The first ferry leaves/);
    expect(linkTarget(book, 'https://example.org/harbour')).toBeNull();
    const dusk = book.toc.find((e) => e.title === 'At dusk')!;
    expect(book.blocks[dusk.block].text).toBe('At dusk');
  });

  it('paginates by text amount, starting each chapter on a new page', () => {
    expect(book.pageCount).toBeGreaterThan(10);
    const quarry = book.toc.find((e) => e.title === 'The Quarry')!;
    expect(book.blocks[quarry.block - 1].page).toBeLessThan(quarry.page);
    expect(book.blocks[quarry.block].y).toBe(0);
    for (let i = 1; i < book.blocks.length; i++) {
      const [a, b] = [book.blocks[i - 1], book.blocks[i]];
      expect(b.page > a.page || (b.page === a.page && b.y > a.y)).toBe(true);
    }
    expect(book.blocks.every((b) => b.y >= 0 && b.y < 1)).toBe(true);
    expect(CHARS_PER_PAGE).toBe(1800);
  });
});

describe('openBook (EPUB 2)', () => {
  it('reads the NCX contents and the meta cover', () => {
    const book = load('book2.epub');
    expect(book.title).toBe('Two Chapters');
    expect(book.toc.map((e) => e.title)).toEqual(['Arrival', 'Departure']);
    expect(book.cover).toBe('cover.jpg');
    expect(imageSize(book.images['cover.jpg'].bytes)).toEqual({ w: 500, h: 750 });
  });

  it('reads the date and subjects for the index (a full date only, subjects once)', () => {
    const three = readPackage(new Uint8Array(readFileSync('e2e/fixtures/book.epub')));
    expect([three.date, three.subjects]).toEqual(['2019-04-02', ['Harbours', 'Travel']]);
    const two = readPackage(new Uint8Array(readFileSync('e2e/fixtures/book2.epub')));
    expect([two.date, two.subjects]).toEqual([undefined, []]);
  });

  it('rejects files that are not EPUBs', () => {
    expect(() => openBook(new Uint8Array([1, 2, 3]))).toThrow(/epub: Not a ZIP/);
  });
});

describe('resolvePath', () => {
  it('joins relative paths and keeps fragments', () => {
    expect(resolvePath('OEBPS/text/ch1.xhtml', '../images/a%20b.png')).toBe('OEBPS/images/a b.png');
    expect(resolvePath('OEBPS/text/ch1.xhtml', '#n1')).toBe('OEBPS/text/ch1.xhtml#n1');
    expect(resolvePath('OEBPS/content.opf', 'text/ch1.xhtml#x')).toBe('OEBPS/text/ch1.xhtml#x');
    expect(resolvePath('content.opf', 'c1.html')).toBe('c1.html');
  });
});
