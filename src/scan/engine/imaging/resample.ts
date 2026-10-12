import { createRGBA, downsampleBox, type Quad, type RGBAImage } from './image';
import { homography } from './quad';

/**
 * Rectify `quad` (in source pixel-edge coordinates, so a full-image quad is
 * (0,0)..(width,height)) into a `outWidth x outHeight` image.
 *
 * Sampling uses the Catmull-Rom cubic, which interpolates (passes through the
 * samples), so unlike B-spline or bilinear it does not soften text edges when
 * the page is enlarged.
 *
 * Where the warp would shrink the page by 2x or more along a source axis, the
 * source is first box-averaged along that axis by the integer part of that
 * factor, because a 4x4 kernel cannot see enough source pixels to avoid
 * aliasing on its own. Each axis gets its own factor, so squashing a page in
 * one direction only is antialiased too.
 */
export function warpQuad(
  src: RGBAImage,
  quad: Quad,
  outWidth: number,
  outHeight: number,
): RGBAImage {
  const shrink = sourceShrink(quad, outWidth, outHeight);
  const fx = shrink.x >= 2 ? Math.floor(shrink.x) : 1;
  const fy = shrink.y >= 2 ? Math.floor(shrink.y) : 1;
  const source = fx > 1 || fy > 1 ? downsampleBox(src, fx, fy) : src;
  const q =
    fx > 1 || fy > 1 ? (quad.map(([x, y]) => [x / fx, y / fy] as const) as unknown as Quad) : quad;

  const h = homography(
    [
      [0, 0],
      [outWidth, 0],
      [outWidth, outHeight],
      [0, outHeight],
    ],
    q,
  );

  const out = createRGBA(outWidth, outHeight);
  const od = out.data;
  const sd = source.data;
  const sw = source.width;
  const sh = source.height;
  const [h0, h1, h2, h3, h4, h5, h6, h7, h8] = h;

  for (let y = 0; y < outHeight; y++) {
    // Homogeneous source coordinates are linear along an output row, so step
    // them incrementally instead of evaluating the homography per pixel.
    const yc = y + 0.5;
    let nx = h0 * 0.5 + h1 * yc + h2;
    let ny = h3 * 0.5 + h4 * yc + h5;
    let nw = h6 * 0.5 + h7 * yc + h8;
    let o = y * outWidth * 4;
    for (let x = 0; x < outWidth; x++, nx += h0, ny += h3, nw += h6, o += 4) {
      // Pixel-edge coordinates to pixel-centre coordinates.
      const fx = nx / nw - 0.5;
      const fy = ny / nw - 0.5;
      const ix = Math.floor(fx);
      const iy = Math.floor(fy);
      const tx = fx - ix;
      const ty = fy - iy;

      // Catmull-Rom weights.
      const tx2 = tx * tx;
      const tx3 = tx2 * tx;
      const wx0 = -0.5 * tx3 + tx2 - 0.5 * tx;
      const wx1 = 1.5 * tx3 - 2.5 * tx2 + 1;
      const wx2 = -1.5 * tx3 + 2 * tx2 + 0.5 * tx;
      const wx3 = 0.5 * tx3 - 0.5 * tx2;
      const ty2 = ty * ty;
      const ty3 = ty2 * ty;
      const wy0 = -0.5 * ty3 + ty2 - 0.5 * ty;
      const wy1 = 1.5 * ty3 - 2.5 * ty2 + 1;
      const wy2 = -1.5 * ty3 + 2 * ty2 + 0.5 * ty;
      const wy3 = 0.5 * ty3 - 0.5 * ty2;

      // Clamped tap columns (as byte offsets) and rows.
      const c0 = (ix - 1 < 0 ? 0 : ix - 1 >= sw ? sw - 1 : ix - 1) * 4;
      const c1 = (ix < 0 ? 0 : ix >= sw ? sw - 1 : ix) * 4;
      const c2 = (ix + 1 < 0 ? 0 : ix + 1 >= sw ? sw - 1 : ix + 1) * 4;
      const c3 = (ix + 2 < 0 ? 0 : ix + 2 >= sw ? sw - 1 : ix + 2) * 4;
      const r0 = (iy - 1 < 0 ? 0 : iy - 1 >= sh ? sh - 1 : iy - 1) * sw * 4;
      const r1 = (iy < 0 ? 0 : iy >= sh ? sh - 1 : iy) * sw * 4;
      const r2 = (iy + 1 < 0 ? 0 : iy + 1 >= sh ? sh - 1 : iy + 1) * sw * 4;
      const r3 = (iy + 2 < 0 ? 0 : iy + 2 >= sh ? sh - 1 : iy + 2) * sw * 4;

      for (let c = 0; c < 3; c++) {
        const a0 = r0 + c;
        const a1 = r1 + c;
        const a2 = r2 + c;
        const a3 = r3 + c;
        const v0 = sd[a0 + c0] * wx0 + sd[a0 + c1] * wx1 + sd[a0 + c2] * wx2 + sd[a0 + c3] * wx3;
        const v1 = sd[a1 + c0] * wx0 + sd[a1 + c1] * wx1 + sd[a1 + c2] * wx2 + sd[a1 + c3] * wx3;
        const v2 = sd[a2 + c0] * wx0 + sd[a2 + c1] * wx1 + sd[a2 + c2] * wx2 + sd[a2 + c3] * wx3;
        const v3 = sd[a3 + c0] * wx0 + sd[a3 + c1] * wx1 + sd[a3 + c2] * wx2 + sd[a3 + c3] * wx3;
        // Uint8ClampedArray rounds and clamps the cubic overshoot.
        od[o + c] = v0 * wy0 + v1 * wy1 + v2 * wy2 + v3 * wy3;
      }
      od[o + 3] = 255;
    }
  }
  return out;
}

/**
 * Source pixels per output pixel along the source's x and y axes. The page's
 * edges (longer of each opposite pair, as in `quadNaturalSize`) give how far
 * one output pixel steps in the source along each output axis; a source
 * axis's shrink is the length of its share of those steps, so a page warped
 * on its side still has its shrink measured along the right axes.
 */
function sourceShrink(quad: Quad, outWidth: number, outHeight: number): { x: number; y: number } {
  const [tl, tr, br, bl] = quad;
  const across = (c: 0 | 1) =>
    Math.max(Math.abs(tr[c] - tl[c]), Math.abs(br[c] - bl[c])) / outWidth;
  const down = (c: 0 | 1) => Math.max(Math.abs(bl[c] - tl[c]), Math.abs(br[c] - tr[c])) / outHeight;
  return { x: Math.hypot(across(0), down(0)), y: Math.hypot(across(1), down(1)) };
}

/** Plain resize of a whole image (no perspective), same kernel and prefilter. */
export function resize(src: RGBAImage, width: number, height: number): RGBAImage {
  if (width === src.width && height === src.height) return src;
  return warpQuad(
    src,
    [
      [0, 0],
      [src.width, 0],
      [src.width, src.height],
      [0, src.height],
    ],
    width,
    height,
  );
}
