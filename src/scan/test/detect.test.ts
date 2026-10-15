import { describe, expect, it } from 'vitest';
import { fullPicture, pickCamera, scoreCamera } from '../engine/camera/camera';
import { heatmapsToQuad } from '../engine/detect/heatmap';

/** Four Gaussian blobs at normalised positions, DocAligner's output layout. */
function heatmaps(points: [number, number][], size = 128, peak = 0.9): Float32Array {
  const heat = new Float32Array(4 * size * size);
  points.forEach(([px, py], c) => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = x + 0.5 - px * size;
        const dy = y + 0.5 - py * size;
        heat[c * size * size + y * size + x] =
          peak * Math.exp(-(dx * dx + dy * dy) / (2 * 2.5 ** 2));
      }
    }
  });
  return heat;
}

describe('heatmapsToQuad', () => {
  it('finds each corner with sub-cell precision', () => {
    const truth: [number, number][] = [
      [0.213, 0.161],
      [0.804, 0.187],
      [0.866, 0.842],
      [0.118, 0.809],
    ];
    const result = heatmapsToQuad(heatmaps(truth), 128);
    expect(result).not.toBeNull();
    // Within a quarter of a heatmap cell.
    result!.quad.forEach(([x, y], i) => {
      expect(Math.abs(x - truth[i][0]) * 128).toBeLessThan(0.25);
      expect(Math.abs(y - truth[i][1]) * 128).toBeLessThan(0.25);
    });
    expect(result!.confidence).toBeGreaterThan(0.8);
  });

  it('ignores a weaker second blob in the same channel', () => {
    const heat = heatmaps([
      [0.2, 0.2],
      [0.8, 0.2],
      [0.8, 0.8],
      [0.2, 0.8],
    ]);
    // A small spurious hot spot in the TL channel, far from the real corner.
    heat[64 * 128 + 64] = 0.5;
    const result = heatmapsToQuad(heat, 128)!;
    expect(result.quad[0][0]).toBeCloseTo(0.2, 2);
  });

  it('takes confidence from the chosen blob, not a stray hotter spot', () => {
    const heat = heatmaps(
      [
        [0.2, 0.2],
        [0.8, 0.2],
        [0.8, 0.8],
        [0.2, 0.8],
      ],
      128,
      0.6,
    );
    // One very hot cell in the TL channel, too small to be the chosen blob.
    heat[64 * 128 + 64] = 0.99;
    const result = heatmapsToQuad(heat, 128)!;
    expect(result.quad[0][0]).toBeCloseTo(0.2, 2);
    expect(result.confidence).toBeLessThan(0.61);
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it('returns null when a corner is missing or the quad is degenerate', () => {
    const heat = heatmaps([
      [0.2, 0.2],
      [0.8, 0.2],
      [0.8, 0.8],
      [0.2, 0.8],
    ]);
    heat.fill(0, 2 * 128 * 128, 3 * 128 * 128);
    expect(heatmapsToQuad(heat, 128)).toBeNull();
    const tiny = heatmaps([
      [0.5, 0.5],
      [0.55, 0.5],
      [0.55, 0.55],
      [0.5, 0.55],
    ]);
    expect(heatmapsToQuad(tiny, 128)).toBeNull();
  });
});

describe('camera selection', () => {
  it('prefers the plain 1x lens on iOS', () => {
    const devices = [
      { deviceId: 'a', label: 'Front Camera' },
      { deviceId: 'b', label: 'Back Ultra Wide Camera' },
      { deviceId: 'c', label: 'Back Triple Camera' },
      { deviceId: 'd', label: 'Back Camera' },
      { deviceId: 'e', label: 'Back Telephoto Camera' },
    ];
    expect(pickCamera(devices)?.deviceId).toBe('d');
  });

  it('prefers camera2 0 on Android', () => {
    const devices = [
      { deviceId: 'x', label: 'camera2 1, facing front' },
      { deviceId: 'y', label: 'camera2 2, facing back' },
      { deviceId: 'z', label: 'camera2 0, facing back' },
    ];
    expect(pickCamera(devices)?.deviceId).toBe('z');
  });

  it('defers to facingMode when labels are hidden', () => {
    expect(pickCamera([{ deviceId: 'q', label: '' }])).toBeNull();
    expect(scoreCamera('', 0)).toBe(-0);
  });
});

describe('fullPicture', () => {
  it("asks for the camera's largest size, uncropped", () => {
    const caps = { width: { min: 1, max: 4000 }, height: { min: 1, max: 3000 }, resizeMode: ['none', 'crop-and-scale'] };
    expect(fullPicture(caps as MediaTrackCapabilities)).toEqual({ width: { ideal: 4000 }, height: { ideal: 3000 }, resizeMode: { ideal: 'none' } });
  });

  it('asks for nothing a camera does not report', () => {
    expect(fullPicture({})).toEqual({});
  });
});
