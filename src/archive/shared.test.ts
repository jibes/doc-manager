import { describe, expect, it } from 'vitest';

import type { DocRecord } from '@/storage/types';
import { changesFor, docKey, merge, parseState, record, serializeState, type DeviceState } from './shared';

const doc = (over: Partial<DocRecord>): DocRecord => ({ id: 'd', title: 'Rechnung', fileName: 'r.pdf', bytes: 1, pageCount: 9, coverAspect: 1.4, addedAt: 100, bookmarks: [], ...over });

describe('shared reading', () => {
  it('identifies a document by what later edits keep', async () => {
    const body = new TextEncoder().encode('%PDF-1.7\n1 0 obj<<>>endobj\nstartxref\n9\n%%EOF\n');
    const appended = new Uint8Array([...body, ...new TextEncoder().encode('2 0 obj<</Title(x)>>endobj\nstartxref\n50\n%%EOF\n')]);
    expect(await docKey(appended.buffer)).toBe(await docKey(body.buffer));
    expect(await docKey(new TextEncoder().encode('%PDF-1.7\nother\n%%EOF').buffer)).not.toBe(await docKey(body.buffer));
  });

  it('stamps what changed on this device; values first shared keep their own time', () => {
    const first = record({}, [{ key: 'k', doc: doc({ position: { page: 3, offset: 0 }, openedAt: 500, reading: { since: 200 } }) }], 1000);
    expect(first.k).toEqual({ title: 'Rechnung', position: { v: { page: 3, offset: 0 }, at: 500 }, reading: { v: { since: 200 }, at: 200 } });
    // Not on the list, no bookmarks, at the start: nothing to tell the other devices yet.
    expect(record({}, [{ key: 'k', doc: doc({ position: { page: 0, offset: 0 }, openedAt: 900 }) }], 1000).k).toEqual({ title: 'Rechnung' });
    const later = record(first, [{ key: 'k', doc: doc({ position: { page: 4, offset: 0.5 }, openedAt: 500, reading: { since: 200 } }) }], 2000);
    expect(later.k.position).toEqual({ v: { page: 4, offset: 0.5 }, at: 2000 });
    expect(later.k.reading?.at).toBe(200);
    // Taken off the list here: that is news.
    expect(record(later, [{ key: 'k', doc: doc({ position: { page: 4, offset: 0.5 } }) }], 3000).k.reading).toEqual({ v: null, at: 3000 });
  });

  it('takes the newest of each value over all devices', () => {
    const a: DeviceState = { device: 'a', docs: { k: { title: 'R', position: { v: { page: 2, offset: 0 }, at: 10 }, bookmarks: { v: [1], at: 50 } } } };
    const b: DeviceState = { device: 'b', docs: { k: { title: 'R', position: { v: { page: 7, offset: 0 }, at: 20 }, bookmarks: { v: [], at: 5 }, reading: { v: { since: 3 }, at: 3 } } } };
    const m = merge([a, b]);
    expect(m.k.position?.v.page).toBe(7);
    expect(m.k.bookmarks?.v).toEqual([1]);
    expect(changesFor(doc({ position: { page: 2, offset: 0 }, bookmarks: [1] }), m.k)).toEqual({ position: { page: 7, offset: 0 }, reading: { since: 3 } });
    expect(changesFor(doc({ position: { page: 7, offset: 0 }, bookmarks: [1], reading: { since: 3 } }), m.k)).toBeNull();
  });

  it('a list removal travels too', () => {
    const m = merge([{ device: 'a', docs: { k: { title: '', reading: { v: null, at: 9 } } } }]);
    expect(changesFor(doc({ reading: { since: 1 } }), m.k)).toEqual({ reading: undefined });
  });

  it('stored states round-trip and drop what they cannot read', () => {
    const s: DeviceState = { device: 'a', docs: { k: { title: 'R', position: { v: { page: 1, offset: 0.2 }, at: 1 }, bookmarks: { v: [2], at: 1 } } } };
    expect(parseState(serializeState(s), 'a')).toEqual(s);
    expect(parseState('{"docs":{"k":{"position":{"v":"x","at":1},"bookmarks":{"v":[1,"x"],"at":2}}}}', 'b')).toEqual({ device: 'b', docs: { k: { title: '', bookmarks: { v: [1], at: 2 } } } });
    expect(parseState('nope', 'a')).toBeNull();
  });
});
