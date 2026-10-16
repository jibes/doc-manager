import { describe, expect, it, vi } from 'vitest';
import type { PageSpec } from '../engine/pipeline';
import { dropRenders, getRender, putRender, renderKey } from '../renderCache';
import type { Page } from '../types';

function page(id: string): Page {
  return {
    id,
    source: new Blob([id]),
    width: 10,
    height: 10,
    spec: { quad: null } as unknown as PageSpec,
    detected: null,
    sharpness: null,
  };
}

function bitmap() {
  return { width: 2, height: 2, close: vi.fn() } as unknown as ImageBitmap;
}

describe('render cache', () => {
  it('closes and drops the renders of a removed photo only', () => {
    const gone = page('gone');
    const kept = page('kept');
    const small = bitmap();
    const large = bitmap();
    const other = bitmap();
    putRender(renderKey(gone, 100, false), small);
    putRender(renderKey(gone, 500, true), large);
    putRender(renderKey(kept, 100, false), other);

    dropRenders(gone.source);
    expect(getRender(renderKey(gone, 100, false))).toBeNull();
    expect(getRender(renderKey(gone, 500, true))).toBeNull();
    expect(small.close).toHaveBeenCalled();
    expect(large.close).toHaveBeenCalled();
    expect(getRender(renderKey(kept, 100, false))).toBe(other);
    expect(other.close).not.toHaveBeenCalled();
  });
});
