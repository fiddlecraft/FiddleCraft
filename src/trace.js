// Turns a black-and-white picture (a drawing, a scribble, a logo) into clean outlines that can be
// raised into a flat 3D shape. Used by Scribble and by importing PNG/JPG pictures.

// mask: Uint8Array of W*H, 1 = solid. Returns closed outlines in pixel units (y down), each a list of [x, y].
export function traceMask(mask, W, H) {
  const solid = (x, y) => x >= 0 && y >= 0 && x < W && y < H && mask[y * W + x] === 1;
  const VW = W + 1;
  const out = new Map(); // corner -> edges leaving it: [to corner, direction]
  const add = (x0, y0, x1, y1, dir) => {
    const k = y0 * VW + x0;
    let list = out.get(k);
    if (!list) { list = []; out.set(k, list); }
    list.push([y1 * VW + x1, dir]);
  };
  // walk round every solid area with the solid side on the right (directions: 0 right, 1 down, 2 left, 3 up)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!solid(x, y)) continue;
    if (!solid(x, y - 1)) add(x, y, x + 1, y, 0);
    if (!solid(x + 1, y)) add(x + 1, y, x + 1, y + 1, 1);
    if (!solid(x, y + 1)) add(x + 1, y + 1, x, y + 1, 2);
    if (!solid(x - 1, y)) add(x, y + 1, x, y, 3);
  }
  const loops = [];
  const take = (k, dir) => {
    const list = out.get(k);
    if (!list) return null;
    // where two outlines touch at a corner, turn right first so they stay apart
    let pick = 0;
    if (list.length > 1 && dir != null) {
      const order = [(dir + 1) % 4, dir, (dir + 3) % 4];
      for (const want of order) { const i = list.findIndex((e) => e[1] === want); if (i >= 0) { pick = i; break; } }
    }
    const e = list.splice(pick, 1)[0];
    if (!list.length) out.delete(k);
    return e;
  };
  while (out.size) {
    const start = out.keys().next().value;
    let k = start, dir = null;
    const pts = [];
    let lastDir = -1;
    for (let guard = 0; guard < 4 * W * H + 8; guard++) {
      const e = take(k, dir);
      if (!e) break;
      if (e[1] !== lastDir) { pts.push([k % VW, Math.floor(k / VW)]); lastDir = e[1]; } // keep only the corners
      k = e[0]; dir = e[1];
      if (k === start) break;
    }
    if (pts.length >= 3) loops.push(pts);
  }
  return loops;
}

export const area = (pts) => { let a = 0; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] - pts[i][0]) * (pts[j][1] + pts[i][1]); return a / 2; };

// fewer points: drop the ones that sit (almost) on the line between their neighbours
export function simplify(pts, eps) {
  if (pts.length < 4) return pts;
  // split the loop at the two points furthest apart and simplify each half
  let far = 0, best = -1;
  for (let i = 1; i < pts.length; i++) { const d = (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2; if (d > best) { best = d; far = i; } }
  const dp = (list) => {
    const keep = new Uint8Array(list.length); keep[0] = keep[list.length - 1] = 1;
    const stack = [[0, list.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      const [ax, ay] = list[a], [bx, by] = list[b];
      const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
      let idx = -1, dmax = eps;
      for (let i = a + 1; i < b; i++) { const d = Math.abs((list[i][0] - ax) * dy - (list[i][1] - ay) * dx) / len; if (d > dmax) { dmax = d; idx = i; } }
      if (idx >= 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
    }
    return list.filter((_, i) => keep[i]);
  };
  const first = dp(pts.slice(0, far + 1)), second = dp([...pts.slice(far), pts[0]]);
  return [...first.slice(0, -1), ...second.slice(0, -1)];
}

// rounder corners (one round of corner cutting)
export function smooth(pts) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length];
    out.push([ax * 0.75 + bx * 0.25, ay * 0.75 + by * 0.25], [ax * 0.25 + bx * 0.75, ay * 0.25 + by * 0.75]);
  }
  return out;
}

// From a mask to finished outlines: traced, tidied, specks dropped.
export function outlinesFromMask(mask, W, H, { eps = 1, rounds = 1, minArea = 6 } = {}) {
  let loops = traceMask(mask, W, H).filter((l) => Math.abs(area(l)) >= minArea);
  loops = loops.map((l) => { let p = simplify(l, eps); for (let r = 0; r < rounds; r++) p = smooth(p); return p; }).filter((l) => l.length >= 3);
  return loops;
}

// Outlines scaled to fit 0..1 both ways (like the shapes' other drawn outlines), plus their size in pixels
export function normalizeLoops(loops) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const l of loops) for (const [x, y] of l) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
  const sx = Math.max(maxX - minX, 1e-6), sy = Math.max(maxY - minY, 1e-6);
  const r = (v) => Math.round(v * 10000) / 10000;
  return { loops: loops.map((l) => l.map(([x, y]) => [r((x - minX) / sx), r((y - minY) / sy)])), spanX: sx, spanY: sy };
}

// A picture to a mask: dark pixels are solid (or light ones, with invert). See-through pixels count as white.
export function maskFromImage(img, threshold, invert) {
  const { data, width: W, height: H } = img;
  const mask = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const a = data[i * 4 + 3] / 255;
    const lum = (0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]) * a + 255 * (1 - a);
    mask[i] = (lum < threshold) !== !!invert ? 1 : 0;
  }
  return mask;
}

// A good starting cut-off between dark and light (Otsu's method)
export function autoThreshold(img) {
  const { data } = img, hist = new Float64Array(256);
  const n = data.length / 4;
  for (let i = 0; i < n; i++) {
    const a = data[i * 4 + 3] / 255;
    const lum = (0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]) * a + 255 * (1 - a);
    hist[Math.min(255, Math.round(lum))]++;
  }
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 128, bestVar = -1;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = n - wB; if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) ** 2;
    if (v > bestVar) { bestVar = v; best = t + 0.5; }
  }
  return Math.round(Math.min(250, Math.max(5, best)));
}
