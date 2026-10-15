import { describe, expect, it } from 'vitest';

import { sameBytes, startsWith } from './bytes';

const buf = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

describe('bytes', () => {
  it('tells a file from its later revision', () => {
    expect(startsWith(buf('%PDF-1.7 a %%EOF b %%EOF'), buf('%PDF-1.7 a %%EOF'))).toBe(true);
    expect(startsWith(buf('%PDF-1.7 a %%EOF'), buf('%PDF-1.7 a %%EOF b %%EOF'))).toBe(false);
    expect(startsWith(buf('%PDF-1.7 x %%EOF b'), buf('%PDF-1.7 a %%EOF'))).toBe(false);
    expect(sameBytes(buf('abc'), buf('abc'))).toBe(true);
    expect(sameBytes(buf('abc'), buf('abcd'))).toBe(false);
  });
});
