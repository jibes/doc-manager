/* eslint-disable import/first -- the mocks come before the module they replace */
import { describe, expect, it, vi } from 'vitest';

// A worker in memory: answers every request at once, a search with its hits first; records what it was told.
type Msg = { id: number; type: string; target?: number };
const sent: Msg[] = [];
const fake = { onmessage: null as ((e: { data: unknown }) => void) | null, onerror: null, onmessageerror: null, terminate: vi.fn(), postMessage: vi.fn() };
fake.postMessage.mockImplementation((msg: Msg) => {
  sent.push(msg);
  const reply = (data: unknown) => queueMicrotask(() => fake.onmessage?.({ data }));
  if (msg.type === 'cancel') return reply({ id: msg.target, ok: false, error: 'aborted' });
  if (msg.type === 'open') return reply({ id: msg.id, ok: true, result: { doc: 1, pageCount: 1, pageSizes: [{ width: 1, height: 1 }], metadata: {}, hasForm: false, signed: false } });
  if (msg.type === 'search') reply({ id: msg.id, progress: [{ page: 0, rects: [], text: 'hit' }] });
  reply({ id: msg.id, ok: true, result: null });
});
vi.mock('@/core/lib/shell', () => ({ takeEarlyWorker: () => fake }));
vi.mock('@/core/lib/base', () => ({ BASE: '' }));
vi.mock('@/core/lib/log', () => ({ log: { debug() {}, warn() {}, error() {} }, logging: () => false, brief: () => '' }));
vi.mock('@/core/lib/bytes', () => ({ fingerprint: () => 'fp' }));

import { engine } from './index.web';

describe('the engine client', () => {
  it('answers calls made with a signal, and lets the listener go once answered', async () => {
    const handle = await engine.open({ kind: 'bytes', bytes: new ArrayBuffer(8) });
    const ctrl = new AbortController();
    const add = vi.spyOn(ctrl.signal, 'addEventListener');
    const remove = vi.spyOn(ctrl.signal, 'removeEventListener');
    const hits: unknown[] = [];
    await handle.search('x', (h) => hits.push(...h), ctrl.signal);
    expect(hits).toHaveLength(1);
    await Promise.resolve();
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('fails a cancelled call as an abort', async () => {
    const handle = await engine.open({ kind: 'bytes', bytes: new ArrayBuffer(8) });
    const ctrl = new AbortController();
    // Not answered until cancelled.
    fake.postMessage.mockImplementationOnce((msg: Msg) => sent.push(msg));
    const pending = handle.search('x', () => {}, ctrl.signal);
    ctrl.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(sent.at(-1)).toMatchObject({ type: 'cancel' });
  });
});
