import { describe, expect, it } from 'vitest';

import { defaultTitle, pdfFilename } from '../export';

describe('scan file names', () => {
  it('titles a scan by its date and time', () => {
    expect(defaultTitle(new Date(2026, 9, 3, 9, 5))).toBe('Scan 2026-10-03 09.05');
  });

  it('keeps file names safe on every file system', () => {
    expect(pdfFilename('Invoice 3/2026: "ACME"')).toBe('Invoice 3-2026- -ACME-.pdf');
    expect(pdfFilename('  ')).toBe('scan.pdf');
  });
});
