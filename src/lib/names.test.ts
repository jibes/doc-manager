import { describe, expect, it } from 'vitest';

import { sameOrRenamed } from './names';

describe('sameOrRenamed', () => {
  it('knows a file under the name it got when its own was taken', () => {
    expect(sameOrRenamed('Rechnung.pdf', 'Rechnung.pdf')).toBe(true);
    expect(sameOrRenamed('Rechnung (2).pdf', 'Rechnung.pdf')).toBe(true);
    expect(sameOrRenamed('Rechnung (12).pdf', 'Rechnung.pdf')).toBe(true);
    expect(sameOrRenamed('Rechnung (x).pdf', 'Rechnung.pdf')).toBe(false);
    expect(sameOrRenamed('Rechnung 2.pdf', 'Rechnung.pdf')).toBe(false);
    expect(sameOrRenamed('Rechnung (2).epub', 'Rechnung.pdf')).toBe(false);
    expect(sameOrRenamed('Notes (3)', 'Notes')).toBe(true);
  });
});
