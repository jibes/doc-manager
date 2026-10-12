import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureStill } from '../engine/camera/camera';

/** An ImageCapture whose takePhoto answers per the settings it is given. */
function fakeCapture(take: (settings?: Record<string, unknown>) => Promise<Blob>) {
  const calls: (Record<string, unknown> | undefined)[] = [];
  vi.stubGlobal(
    'ImageCapture',
    class {
      getPhotoCapabilities() {
        return Promise.resolve({ imageWidth: { max: 4080 }, imageHeight: { max: 3060 } });
      }
      takePhoto(settings?: Record<string, unknown>) {
        calls.push(settings);
        return take(settings);
      }
    },
  );
  return calls;
}

const track = {} as MediaStreamTrack;
const video = {} as HTMLVideoElement;

afterEach(() => vi.unstubAllGlobals());

describe('captureStill', () => {
  it('asks for the full sensor size', async () => {
    const calls = fakeCapture(() => Promise.resolve(new Blob(['jpeg'])));
    expect((await captureStill(track, video)).size).toBe(4);
    expect(calls).toEqual([{ imageWidth: 4080, imageHeight: 3060 }]);
  });

  it("falls back to the camera's default size when that is refused", async () => {
    const calls = fakeCapture((settings) =>
      settings ? Promise.reject(new Error('unsupported')) : Promise.resolve(new Blob(['jpeg'])),
    );
    expect((await captureStill(track, video)).size).toBe(4);
    expect(calls).toEqual([{ imageWidth: 4080, imageHeight: 3060 }, undefined]);
  });
});
