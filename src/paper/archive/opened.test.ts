import { describe, expect, it, vi } from 'vitest';

vi.mock('@/core/lib/folders', () => ({ folders: { supported: false } }));
vi.mock('@/paper/state/prefs', () => ({ usePrefs: { getState: () => ({ archive: null }) } }));

import { latest, parseOpened, serializeOpened } from './opened';

describe('opened on other devices', () => {
  it('takes the latest time for each document over every device', () => {
    const merged = latest([new Map([['a', 5], ['b', 1]]), new Map([['a', 3], ['c', 7]])]);
    expect(Object.fromEntries(merged)).toEqual({ a: 5, b: 1, c: 7 });
  });
  it('reads a broken or foreign file as nothing, and keeps only numbers', () => {
    expect(parseOpened('not json').size).toBe(0);
    expect(Object.fromEntries(parseOpened('{"v":1,"opened":{"a":5,"b":"x"}}'))).toEqual({ a: 5 });
  });
  it('writes the most recent 500 only', () => {
    const many = new Map(Array.from({ length: 600 }, (_, i) => [`k${i}`, i] as [string, number]));
    const kept = parseOpened(serializeOpened(many));
    expect(kept.size).toBe(500);
    expect(kept.has('k599') && !kept.has('k0')).toBe(true);
  });
});
