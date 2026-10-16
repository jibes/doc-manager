import { describe, expect, it } from 'vitest';

import type { DocHandle } from '@/core/engine/types';
import { anyPageWithoutText, pagesWithoutText } from './searchable';

/** A document whose pages have this text (a scanned page: none). */
const doc = (pages: string[]) => {
  const asked: number[] = [];
  const handle = { pageCount: pages.length, pageText: async (p: number) => (asked.push(p), [{ text: pages[p] }]) } as unknown as DocHandle;
  return { handle, asked };
};
const typed = 'A page of typed text, long enough to count.';

describe('pages without text', () => {
  it('finds scanned pages after typed ones, stopping at the first', async () => {
    const { handle, asked } = doc([typed, typed, '', typed, '']);
    expect(await pagesWithoutText(handle, 1)).toEqual([]);
    expect(await anyPageWithoutText(handle, 200)).toBe(true);
    expect(asked.slice(1)).toEqual([0, 1, 2]);
  });

  it('counts a stray page number as no text, and looks only as far as asked', async () => {
    expect(await anyPageWithoutText(doc([typed, '12']).handle, 200)).toBe(true);
    expect(await anyPageWithoutText(doc([typed, typed, '']).handle, 2)).toBe(false);
  });

  it('stops when the document is closed', async () => {
    const { handle, asked } = doc([typed, typed, '']);
    expect(await anyPageWithoutText(handle, 200, () => asked.length >= 1)).toBe(false);
  });
});
