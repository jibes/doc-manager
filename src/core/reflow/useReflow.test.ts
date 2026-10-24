import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DocHandle, PageLayout, TextLine } from '@/core/engine/types';

const saved = new Map<number, TextLine[]>();
const read = vi.fn<(page: number) => Promise<TextLine[]>>();

vi.mock('@/core/ocr', () => ({
  ocrAvailable: true,
  createRecognizer: async () => ({ page: (_: DocHandle, page: number) => read(page), close: () => {} }),
}));
vi.mock('@/core/storage', () => ({
  repo: {
    loadOcr: async (_: string, n: number) => Array.from({ length: n }, (_, i) => saved.get(i)),
    saveOcr: async (_: string, page: number, lines: TextLine[]) => void saved.set(page, lines),
  },
}));

const { recognizeText, watchReflow } = await import('./useReflow');

const text = (s: string, y = 0.3): TextLine => ({ text: s, rect: { x: 0.1, y, w: 0.8, h: 0.015 }, size: 10, bold: false, italic: false, hyphen: false });
const scan: PageLayout = { lines: [], graphics: [{ rect: { x: 0, y: 0, w: 1, h: 1 }, image: true, parts: 1 }] };
const handle = (layouts: PageLayout[]) =>
  ({ pageCount: layouts.length, pageSizes: layouts.map(() => ({ width: 595, height: 842 })), layout: async (ps: number[]) => ps.map((p) => layouts[p]) }) as unknown as DocHandle;
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => {
  for (let i = 0; i < 20; i++) await tick();
};

beforeEach(() => {
  saved.clear();
  read.mockReset();
});

describe('text recognition in the text view', () => {
  it('saves nothing for pages it could not read once the document closed, and resumes there', async () => {
    const h = handle([scan, scan, scan]);
    const view = watchReflow(h, 'a', () => {});
    await settle();
    read.mockImplementation(async (p) => {
      if (p === 0) return [text('Erste Seite mit genug Text, um gelesen zu werden.')];
      throw new Error('Document closed');
    });
    recognizeText(h);
    await settle();
    expect([...saved.keys()]).toEqual([0]);
    view.stop();
    // Watching again picks up the pages left unread.
    read.mockImplementation(async (p) => [text(`Seite ${p + 1} mit genug Text, um gelesen zu werden.`)]);
    watchReflow(h, 'a', () => {});
    await settle();
    expect([...saved.keys()].sort()).toEqual([0, 1, 2]);
  });

  it('stops before the next page when no view is watching', async () => {
    const h = handle([scan, scan, scan]);
    const view = watchReflow(h, 'b', () => {});
    await settle();
    read.mockImplementation(async (p) => {
      if (p === 0) view.stop();
      return [text(`Seite ${p + 1} mit genug Text, um gelesen zu werden.`)];
    });
    recognizeText(h);
    await settle();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('marks a page it could not read as failed, leaves it unsaved and reads the rest', async () => {
    const h = handle([scan, scan, scan]);
    const view = watchReflow(h, 'c', () => {});
    await settle();
    read.mockImplementation(async (p) => {
      if (p === 1) throw new Error('too large');
      return [text(`Seite ${p + 1} mit genug Text, um gelesen zu werden.`)];
    });
    recognizeText(h);
    await settle();
    expect([...saved.keys()].sort()).toEqual([0, 2]);
    const s = view.state();
    expect(s.status === 'ready' && s.ocr).toMatchObject({ running: false, failed: true, done: 3 });
  });

  it('offers recognition for the scanned pages after a typed cover and reads only those', async () => {
    const cover: PageLayout = { lines: [text('Fax cover sheet from the office of Muster AG, 3 pages')], graphics: [] };
    const h = handle([cover, scan, scan]);
    const view = watchReflow(h, 'd', () => {});
    await settle();
    const s = view.state();
    expect(s.status === 'ready' && s.reflow.status).toBe('ok');
    expect(s.status === 'ready' && s.canOcr).toBe(true);
    read.mockImplementation(async (p) => [text(`Gescannte Seite ${p + 1} mit genug Text zum Lesen.`)]);
    recognizeText(h);
    await settle();
    expect(read.mock.calls.map(([p]) => p)).toEqual([1, 2]);
    const after = view.state();
    expect(after.status === 'ready' && after.reflow.blocks.map((b) => b.text).join('\n')).toMatch(/Fax cover[\s\S]*Seite 2[\s\S]*Seite 3/);
  });
});
