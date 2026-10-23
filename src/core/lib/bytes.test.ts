import { describe, expect, it } from 'vitest';

import { fingerprint, sameBytes, startsWith } from './bytes';

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

describe('fingerprint', () => {
  const file = (n: number, at = -1) => {
    const b = new Uint8Array(n).map((_, i) => i % 251);
    if (at >= 0) b[at] ^= 1;
    return b.buffer;
  };
  it('is the same for the same bytes', () => {
    expect(fingerprint(file(300_000))).toBe(fingerprint(file(300_000)));
  });
  it('tells a revision appended, a changed start or end, and a full save of the same length apart', () => {
    const base = fingerprint(file(300_000));
    expect(fingerprint(file(300_100))).not.toBe(base);
    expect(fingerprint(file(300_000, 10))).not.toBe(base);
    expect(fingerprint(file(300_000, 299_990))).not.toBe(base);
    expect(fingerprint(file(300_000, 65536 + 61 * 100))).not.toBe(base);
  });
});
