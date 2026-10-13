import type { Point, Quad } from './image';

/** 3x3 homography, row-major, h[8] normalised to 1. */
export type Homography = Float64Array;

/**
 * Homography mapping `from[i]` to `to[i]` for four point pairs, solved as the
 * standard 8x8 linear system with partial pivoting.
 */
export function homography(from: Quad, to: Quad): Homography {
  const a: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = from[i];
    const [u, v] = to[i];
    a.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    a.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let row = col + 1; row < 8; row++) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    }
    if (Math.abs(a[pivot][col]) < 1e-12) throw new Error('Degenerate quadrilateral');
    [a[col], a[pivot]] = [a[pivot], a[col]];
    for (let row = 0; row < 8; row++) {
      if (row === col) continue;
      const f = a[row][col] / a[col][col];
      if (f === 0) continue;
      for (let k = col; k < 9; k++) a[row][k] -= f * a[col][k];
    }
  }
  const h = new Float64Array(9);
  for (let i = 0; i < 8; i++) h[i] = a[i][8] / a[i][i];
  h[8] = 1;
  return h;
}

export function applyHomography(h: Homography, x: number, y: number): [number, number] {
  const w = h[6] * x + h[7] * y + h[8];
  return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w];
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/** Shoelace area (absolute). */
export function quadArea(q: Quad): number {
  let s = 0;
  for (let i = 0; i < 4; i++) {
    const [x0, y0] = q[i];
    const [x1, y1] = q[(i + 1) % 4];
    s += x0 * y1 - x1 * y0;
  }
  return Math.abs(s) / 2;
}

/** True for a strictly convex quad with a non-trivial area. */
export function isConvex(q: Quad): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = q[i];
    const [bx, by] = q[(i + 1) % 4];
    const [cx, cy] = q[(i + 2) % 4];
    const cross = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
    if (Math.abs(cross) < 1e-9) return false;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** Interior angles of a convex quad, radians, one per corner. */
export function interiorAngles(q: Quad): number[] {
  return q.map((c, i) => {
    const p = q[(i + 3) % 4];
    const n = q[(i + 1) % 4];
    const a = Math.atan2(p[1] - c[1], p[0] - c[0]);
    const b = Math.atan2(n[1] - c[1], n[0] - c[0]);
    const d = Math.abs(a - b);
    return d > Math.PI ? 2 * Math.PI - d : d;
  });
}

/** Sharpest and bluntest corner a photographed rectangle plausibly shows. */
const PLAUSIBLE_ANGLE = (30 * Math.PI) / 180;
/** Opposite sides of a photographed rectangle: the shorter at least this share of the longer. */
const PLAUSIBLE_FORESHORTENING = 0.4;

/**
 * Whether a quad can be the photo of a flat rectangular page: convex, no
 * corner sharper than 30° (or blunter than 150°), each pair of opposite
 * sides within the foreshortening a phone's perspective produces, and at
 * least `minArea` of the `width` × `height` photo.
 */
export function plausibleQuad(q: Quad, width: number, height: number, minArea = 0.05): boolean {
  if (!q.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y))) return false;
  if (!isConvex(q)) return false;
  if (interiorAngles(q).some((a) => a < PLAUSIBLE_ANGLE || a > Math.PI - PLAUSIBLE_ANGLE)) {
    return false;
  }
  const side = (i: number) => distance(q[i], q[(i + 1) % 4]);
  for (const [a, b] of [
    [side(0), side(2)],
    [side(1), side(3)],
  ]) {
    if (Math.min(a, b) < PLAUSIBLE_FORESHORTENING * Math.max(a, b)) return false;
  }
  return quadArea(q) >= minArea * width * height;
}

/**
 * Put four arbitrary points into TL, TR, BR, BL order (image coordinates, y
 * down): sort by angle around the centroid, then rotate so the corner with the
 * smallest x + y comes first.
 */
export function orderCorners(points: readonly Point[]): Quad {
  const cx = points.reduce((s, p) => s + p[0], 0) / points.length;
  const cy = points.reduce((s, p) => s + p[1], 0) / points.length;
  const sorted = [...points].sort(
    (a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx),
  );
  let start = 0;
  for (let i = 1; i < 4; i++) {
    if (sorted[i][0] + sorted[i][1] < sorted[start][0] + sorted[start][1]) start = i;
  }
  const r = [0, 1, 2, 3].map((i) => sorted[(start + i) % 4]);
  return [r[0], r[1], r[2], r[3]];
}

export function scaleQuad(q: Quad, sx: number, sy = sx): Quad {
  return q.map(([x, y]) => [x * sx, y * sy] as const) as unknown as Quad;
}

export function clampQuad(q: Quad, width: number, height: number): Quad {
  return q.map(
    ([x, y]) => [Math.min(width, Math.max(0, x)), Math.min(height, Math.max(0, y))] as const,
  ) as unknown as Quad;
}

/** A centred quad inset by `inset` of each dimension. */
export function insetQuad(width: number, height: number, inset = 0.05): Quad {
  const x0 = width * inset;
  const y0 = height * inset;
  const x1 = width * (1 - inset);
  const y1 = height * (1 - inset);
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
}

/**
 * The crop given to a photo in which no page was found. An imported image
 * keeps all of it: it is most likely a scan or a screenshot whose page fills
 * it (one the detector's frame check missed), and an inset would cut off
 * whatever is printed near its edges. A camera photo, framed around a page
 * on a table, starts slightly inset, and the user is sent to place its
 * corners.
 */
export function fallbackQuad(width: number, height: number, imported = false): Quad {
  return imported ? fullQuad(width, height) : insetQuad(width, height, 0.04);
}

/**
 * Whether a crop is no measurement of the page's shape: the untouched
 * fallback crop, or one with a corner on the photo's border (a page running
 * off the photo, clipped to it).
 */
export function cropShapeUnknown(q: Quad, width: number, height: number): boolean {
  const fallback = fallbackQuad(width, height);
  if (q.every((p, i) => distance(p, fallback[i]) < 0.5)) return true;
  // Clipped corners lie on the border; a corner just past it is the page's own.
  const on = (v: number, edge: number) => Math.abs(v - edge) <= 0.5;
  return q.some(([x, y]) => on(x, 0) || on(y, 0) || on(x, width) || on(y, height));
}

export function fullQuad(width: number, height: number): Quad {
  return [
    [0, 0],
    [width, 0],
    [width, height],
    [0, height],
  ];
}

/**
 * Natural rectified size of a quad in source pixels.
 *
 * Each dimension takes the longer of its two opposite edges: the shorter one
 * is the foreshortened side, and using it would throw resolution away.
 */
export function quadNaturalSize(q: Quad): { width: number; height: number } {
  const [tl, tr, br, bl] = q;
  const width = Math.max(distance(tl, tr), distance(bl, br));
  const height = Math.max(distance(tl, bl), distance(tr, br));
  return { width: Math.max(1, width), height: Math.max(1, height) };
}

type Vec3 = [number, number, number];

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/**
 * Focal length of a typical phone main camera (26 mm equivalent) as a
 * multiple of the image's long edge. It holds for full-sensor 4:3 stills and
 * for 16:9 video frames alike, since both span the sensor's full width.
 */
const DEFAULT_FOCAL = 0.75;

/**
 * True width/height ratio of the rectangle a quad is a photo of.
 *
 * Edge lengths in the photo are foreshortened, so a page shot at an angle
 * rectifies too short. Following Zhang & He, "Whiteboard scanning and image
 * enhancement" (2007): the quad's two vanishing directions give the camera's
 * focal length (principal point assumed at the image centre), and with it the
 * rectangle's real aspect ratio.
 *
 * When a pair of edges is parallel in the photo (the page is tilted about one
 * axis only, or not at all) the focal length cannot be measured; a typical
 * phone focal length is assumed instead, which is exact for the head-on case
 * and close for the rest.
 */
export function perspectiveAspect(q: Quad, imageWidth: number, imageHeight: number): number | null {
  const u0 = imageWidth / 2;
  const v0 = imageHeight / 2;
  const scale = Math.max(imageWidth, imageHeight);
  const [tl, tr, br, bl] = q;
  const m1: Vec3 = [tl[0], tl[1], 1];
  const m2: Vec3 = [tr[0], tr[1], 1];
  const m3: Vec3 = [bl[0], bl[1], 1];
  const m4: Vec3 = [br[0], br[1], 1];

  const c14 = cross(m1, m4);
  const k2 = dot(c14, m3) / dot(cross(m2, m4), m3);
  const k3 = dot(c14, m2) / dot(cross(m3, m4), m2);
  if (!Number.isFinite(k2) || !Number.isFinite(k3) || k2 <= 0 || k3 <= 0) return null;
  const n2: Vec3 = [k2 * m2[0] - m1[0], k2 * m2[1] - m1[1], k2 - 1];
  const n3: Vec3 = [k3 * m3[0] - m1[0], k3 * m3[1] - m1[1], k3 - 1];

  let f = DEFAULT_FOCAL * scale;
  // k = 1 means that pair of edges is parallel in the photo: its vanishing
  // point is at infinity and says nothing about the focal length.
  if (Math.abs(n2[2]) > 1e-3 && Math.abs(n3[2]) > 1e-3) {
    const f2 =
      -(
        n2[0] * n3[0] -
        (n2[0] * n3[2] + n2[2] * n3[0]) * u0 +
        n2[2] * n3[2] * u0 * u0 +
        (n2[1] * n3[1] - (n2[1] * n3[2] + n2[2] * n3[1]) * v0 + n2[2] * n3[2] * v0 * v0)
      ) /
      (n2[2] * n3[2]);
    // Only trust a plausible phone lens: ultra-wide to telephoto.
    if (f2 > 0 && Math.sqrt(f2) > 0.4 * scale && Math.sqrt(f2) < 4 * scale) f = Math.sqrt(f2);
  }

  const norm = (n: Vec3) => {
    const x = (n[0] - u0 * n[2]) / f;
    const y = (n[1] - v0 * n[2]) / f;
    return x * x + y * y + n[2] * n[2];
  };
  const aspect = Math.sqrt(norm(n2) / norm(n3));
  return Number.isFinite(aspect) && aspect > 0.05 && aspect < 20 ? aspect : null;
}

/**
 * Rectified size of a quad in source pixels, with the perspective-corrected
 * aspect ratio when the source image size is known. The long side keeps the
 * resolution the photo actually has; the other side follows the true aspect.
 */
export function quadPageSize(
  q: Quad,
  image?: { width: number; height: number },
): { width: number; height: number } {
  const natural = quadNaturalSize(q);
  const aspect = image ? perspectiveAspect(q, image.width, image.height) : null;
  if (aspect === null) return natural;
  if (natural.width >= natural.height) {
    return { width: natural.width, height: natural.width / aspect };
  }
  return { width: natural.height * aspect, height: natural.height };
}

/** Scale a size so its long edge is `longEdge`, keeping the aspect ratio. */
export function fitLongEdge(
  size: { width: number; height: number },
  longEdge: number,
): { width: number; height: number } {
  const scale = longEdge / Math.max(size.width, size.height);
  return {
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
  };
}

/**
 * The preview's page on the photo: the video frame is the middle of the photo, as wide or as tall as it (a photo
 * often shows more of the sensor than the video). Null when they don't share an orientation.
 */
export function hintOnPhoto(hint: { quad: Quad; aspect: number }, w: number, h: number): Quad | null {
  const photo = w / h;
  if (hint.aspect > 1 !== photo > 1 && Math.abs(hint.aspect - 1) > 0.05) return null;
  const fw = photo > hint.aspect ? h * hint.aspect : w;
  const fh = photo > hint.aspect ? h : w / hint.aspect;
  return hint.quad.map(([x, y]) => [(w - fw) / 2 + x * fw, (h - fh) / 2 + y * fh]) as unknown as Quad;
}
