/**
 * 8-connected component labelling with union-find. Returns the label of every
 * set pixel (0 = background) and the pixel count of every label.
 */
export function labelComponents(
  mask: Uint8Array,
  width: number,
  height: number,
): { labels: Int32Array; areas: Int32Array } {
  const labels = new Int32Array(width * height);
  const parent: number[] = [0];

  const find = (x: number): number => {
    let root = x;
    while (parent[root] !== root) root = parent[root];
    while (parent[x] !== root) {
      const next = parent[x];
      parent[x] = root;
      x = next;
    }
    return root;
  };
  const union = (a: number, b: number): number => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return ra;
    if (ra < rb) {
      parent[rb] = ra;
      return ra;
    }
    parent[ra] = rb;
    return rb;
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!mask[i]) continue;
      // Previously visited neighbours: W, NW, N, NE.
      let label = x > 0 ? labels[i - 1] : 0;
      if (y > 0) {
        const nw = x > 0 ? labels[i - width - 1] : 0;
        const n = labels[i - width];
        const ne = x < width - 1 ? labels[i - width + 1] : 0;
        if (nw) label = label ? union(label, nw) : nw;
        if (n) label = label ? union(label, n) : n;
        if (ne) label = label ? union(label, ne) : ne;
      }
      if (!label) {
        label = parent.length;
        parent.push(label);
      }
      labels[i] = label;
    }
  }

  const areas = new Int32Array(parent.length);
  for (let i = 0; i < labels.length; i++) {
    if (!labels[i]) continue;
    const root = find(labels[i]);
    labels[i] = root;
    areas[root]++;
  }
  return { labels, areas };
}

/** Clear components smaller than `minArea` pixels. Mutates and returns `mask`. */
export function removeSmallComponents(
  mask: Uint8Array,
  width: number,
  height: number,
  minArea: number,
): Uint8Array {
  if (minArea <= 1) return mask;
  const { labels, areas } = labelComponents(mask, width, height);
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] && areas[labels[i]] < minArea) mask[i] = 0;
  }
  return mask;
}

/** Binary dilation by a (2r+1)^2 square: separable distance scans, O(n) for any radius. */
export function dilate(mask: Uint8Array, width: number, height: number, radius = 1): Uint8Array {
  const r = Math.max(1, Math.floor(radius));
  const tmp = new Uint8Array(mask.length);
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    const off = y * width;
    // Distance since the last set pixel, scanning both ways.
    let last = -Infinity;
    for (let x = 0; x < width; x++) {
      if (mask[off + x]) last = x;
      if (x - last <= r) tmp[off + x] = 1;
    }
    last = Infinity;
    for (let x = width - 1; x >= 0; x--) {
      if (mask[off + x]) last = x;
      if (last - x <= r) tmp[off + x] = 1;
    }
  }
  // Vertically, the same scans for all columns at once, a row at a time, so
  // memory is read in order rather than a row apart per step.
  const last = new Float64Array(width).fill(-Infinity);
  for (let y = 0; y < height; y++) {
    const off = y * width;
    for (let x = 0; x < width; x++) {
      if (tmp[off + x]) last[x] = y;
      if (y - last[x] <= r) out[off + x] = 1;
    }
  }
  last.fill(Infinity);
  for (let y = height - 1; y >= 0; y--) {
    const off = y * width;
    for (let x = 0; x < width; x++) {
      if (tmp[off + x]) last[x] = y;
      if (last[x] - y <= r) out[off + x] = 1;
    }
  }
  return out;
}
