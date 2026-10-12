import { describe, expect, it } from 'vitest';

import { levelFor } from './ambient';

// Levels: 0 Black (night), 1 Dark (dusk), 2 Light (paper).
describe('light sensor theme', () => {
  it('steps down as the room gets darker', () => {
    expect(levelFor(500, 2)).toBe(2);
    expect(levelFor(10, 2)).toBe(1);
    expect(levelFor(1, 2)).toBe(0);
  });

  it('steps up as it gets brighter', () => {
    expect(levelFor(20, 0)).toBe(1);
    expect(levelFor(300, 0)).toBe(2);
  });

  it('holds between the thresholds, so it does not flicker', () => {
    // Dimmed to 30 lux: still bright enough for Light, not bright enough to leave Dark.
    expect(levelFor(30, 2)).toBe(2);
    expect(levelFor(30, 1)).toBe(1);
    expect(levelFor(5, 0)).toBe(0);
    expect(levelFor(5, 1)).toBe(1);
  });
});
