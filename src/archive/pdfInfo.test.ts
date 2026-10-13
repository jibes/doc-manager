import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { buildPdf } from '@/scan/engine/pdf/writer';
import { infoFor, parseTags, pdfText, readTrailer, withInfo } from './pdfInfo';

const text = (b: Uint8Array) => new TextDecoder('latin1').decode(b);
const tablePdf = async () =>
  new Uint8Array(
    await buildPdf([{ pixelWidth: 10, pixelHeight: 10, width: 100, height: 100, image: { kind: 'jpeg', bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), components: 3 } }], { title: 'Scan' }).arrayBuffer(),
  );
const streamPdf = () => new Uint8Array(readFileSync(new URL('../../e2e/fixtures/xrefstream.pdf', import.meta.url)));

/** Each object the newest cross-reference section lists starts where it says. */
function checkOffsets(bytes: Uint8Array, nums: number[], offsets: number[]) {
  nums.forEach((n, i) => expect(text(bytes.subarray(offsets[i], offsets[i] + 12))).toMatch(new RegExp(`^${n} 0 obj`)));
}

describe('document information by incremental update', () => {
  it('appends to a PDF with a cross-reference table, keeping every byte before', async () => {
    const before = await tablePdf();
    const t = readTrailer(before);
    expect(t.kind).toBe('table');
    const after = withInfo(before, { Title: 'Rechnung 40217', Author: 'Musterwerke Zürich', Keywords: 'Strom, 2026' }, new Date('2026-10-13T12:00:00Z'));
    expect(after.subarray(0, before.length)).toEqual(before);
    const added = text(after.subarray(before.length));
    expect(added).toContain('/Title (Rechnung 40217)');
    expect(added).toContain('/ModDate (D:20261013120000Z)');
    // Non-ASCII as UTF-16BE: "Musterwerke Zürich".
    expect(added).toContain('/Author <FEFF004D00750073007400650072007700650072006B00650020005A00FC0072006900630068>');
    const t2 = readTrailer(after);
    expect(t2).toMatchObject({ kind: 'table', size: t.size + 1, root: t.root });
    const offset = Number(/xref\n\d+ 1\n(\d{10}) 00000 n/.exec(added)![1]);
    checkOffsets(after, [t.size], [offset]);
    expect(added).toMatch(new RegExp(`/Prev ${t.xref}`));
  });

  it('appends a cross-reference stream to a PDF that has one', () => {
    const before = streamPdf();
    const t = readTrailer(before);
    expect(t).toMatchObject({ kind: 'stream', size: 8, root: '1 0 R', encrypted: false });
    const after = withInfo(before, { Title: 'New', Creator: 'hand' });
    expect(after.subarray(0, before.length)).toEqual(before);
    const t2 = readTrailer(after);
    expect(t2).toMatchObject({ kind: 'stream', size: 10, root: '1 0 R' });
    // The stream's rows: type 1 entries pointing at the info dictionary (8) and at the stream itself (9).
    const at = t2.xref;
    const head = text(after.subarray(at, at + 300));
    expect(head).toMatch(/^9 0 obj/);
    expect(head).toContain('/Index [8 2] /W [1 4 2] /Length 14');
    const data = after.subarray(at + head.indexOf('stream\n') + 7, at + head.indexOf('stream\n') + 21);
    const off = (row: number) => (data[row * 7 + 1] << 24) | (data[row * 7 + 2] << 16) | (data[row * 7 + 3] << 8) | data[row * 7 + 4];
    checkOffsets(after, [8, 9], [off(0), off(1)]);
    expect(text(after.subarray(off(0)))).toMatch(/^8 0 obj\n<< \/Title \(New\) \/Creator \(hand\) \/ModDate/);
  });

  it('can be applied again and again', async () => {
    let bytes = await tablePdf();
    for (const title of ['One', 'Two', 'Three']) bytes = withInfo(bytes, { Title: title });
    expect(readTrailer(bytes).size).toBe(readTrailer(await tablePdf()).size + 3);
    expect(text(bytes).match(/startxref/g)).toHaveLength(4);
  });

  it('leaves encrypted PDFs alone', () => {
    const body = '%PDF-1.4\n1 0 obj\n<<>>\nendobj\n';
    const pdf = new TextEncoder().encode(`${body}xref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size 2 /Root 1 0 R /Encrypt 5 0 R >>\nstartxref\n${body.length}\n%%EOF\n`);
    expect(readTrailer(pdf).encrypted).toBe(true);
    expect(() => withInfo(pdf, { Title: 'x' })).toThrow(/encrypted/);
  });

  it('escapes literal strings and writes everything else as UTF-16', () => {
    expect(pdfText('a (b) \\ c')).toBe('(a \\(b\\) \\\\ c)');
    expect(pdfText('€')).toBe('<FEFF20AC>');
    expect(pdfText('𝄞')).toBe('<FEFFD834DD1E>');
  });

  it('maps details to the dictionary, keeping the other entries', () => {
    const info = infoFor({ title: ' Rechnung ', sender: 'Musterwerke', type: 'Rechnung', tags: ['a', 'b'], date: '2026-10-02' }, { Creator: 'Word', Title: 'old' });
    expect(info).toEqual({ Creator: 'Word', Title: 'Rechnung', Author: 'Musterwerke', Subject: 'Rechnung', Keywords: 'a, b', DocumentDate: '2026-10-02' });
    expect(infoFor({ title: '', sender: '', type: '', tags: [], date: '2.10.' }, {})).toMatchObject({ Title: undefined, DocumentDate: undefined });
    expect(parseTags('Steuer; 2026, Steuer ,')).toEqual(['Steuer', '2026']);
  });
});
