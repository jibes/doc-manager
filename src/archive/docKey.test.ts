import { describe, expect, it } from 'vitest';

import { docKey } from './docKey';

describe('docKey', () => {
  it('identifies a document by what later edits keep', async () => {
    const body = new TextEncoder().encode('%PDF-1.7\n1 0 obj<<>>endobj\nstartxref\n9\n%%EOF\n');
    const appended = new Uint8Array([...body, ...new TextEncoder().encode('2 0 obj<</Title(x)>>endobj\nstartxref\n50\n%%EOF\n')]);
    expect(await docKey(appended.buffer)).toBe(await docKey(body.buffer));
    expect(await docKey(new TextEncoder().encode('%PDF-1.7\nother\n%%EOF').buffer)).not.toBe(await docKey(body.buffer));
  });
});
