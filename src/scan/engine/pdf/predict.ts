/**
 * Apply PNG row filters (the "optimum" PNG predictor, PDF /Predictor 15) to
 * interleaved 8-bit samples. Each output row is one filter-type byte followed
 * by the filtered row; the type per row is chosen by the usual minimum sum of
 * absolute signed differences heuristic.
 *
 * Prediction pays off on smooth tones (photos, the colour filter); on clean
 * black-and-white output plain deflate usually wins, so callers should
 * compress both ways and keep the smaller.
 */
export function pngPredict(
  samples: Uint8Array,
  width: number,
  height: number,
  channels: number,
): Uint8Array<ArrayBuffer> {
  const stride = width * channels;
  const out = new Uint8Array((stride + 1) * height);
  const candidate = new Uint8Array(stride);
  const best = new Uint8Array(stride);

  for (let y = 0; y < height; y++) {
    const row = y * stride;
    const prev = y > 0 ? row - stride : -1;
    let bestType = 0;
    let bestScore = Infinity;
    for (let type = 0; type <= 4; type++) {
      let score = 0;
      for (let i = 0; i < stride; i++) {
        const x = samples[row + i];
        const a = i >= channels ? samples[row + i - channels] : 0;
        const b = prev >= 0 ? samples[prev + i] : 0;
        const c = prev >= 0 && i >= channels ? samples[prev + i - channels] : 0;
        let predicted: number;
        switch (type) {
          case 0:
            predicted = 0;
            break;
          case 1:
            predicted = a;
            break;
          case 2:
            predicted = b;
            break;
          case 3:
            predicted = (a + b) >> 1;
            break;
          default: {
            const p = a + b - c;
            const pa = Math.abs(p - a);
            const pb = Math.abs(p - b);
            const pc = Math.abs(p - c);
            predicted = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          }
        }
        const v = (x - predicted) & 0xff;
        candidate[i] = v;
        score += v < 128 ? v : 256 - v;
        if (score >= bestScore) break;
      }
      if (score < bestScore) {
        bestScore = score;
        bestType = type;
        best.set(candidate);
      }
    }
    const o = y * (stride + 1);
    out[o] = bestType;
    out.set(best, o + 1);
  }
  return out;
}
