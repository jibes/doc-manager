import { describe, expect, it } from 'vitest';

import { levelFor } from './ambient';

// Levels: 0 Dark, 1 Light.
describe('Auto appearance by light sensor', () => {
  it('turns Dark when the room gets dim, Light when it gets bright', () => {
    expect(levelFor(500, 1)).toBe(1);
    expect(levelFor(5, 1)).toBe(0);
    expect(levelFor(300, 0)).toBe(1);
  });

  it('holds between the thresholds, so it does not flicker', () => {
    // An evening room at 20 lux: stays whichever it was.
    expect(levelFor(20, 1)).toBe(1);
    expect(levelFor(20, 0)).toBe(0);
  });
});
