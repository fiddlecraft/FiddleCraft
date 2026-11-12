// SVG export for laser cutters: the outline of the design where it meets the workplane, seen from
// the top, in real millimetres. Holes are already cut out of the geometry passed in.

const KEY = 1e3; // join points closer than a thousandth of a millimetre

/** Slice a (Y-up, millimetre) geometry with the level plane at height y; returns closed outlines. */
export function sliceOutlines(geometry, y) {
  const pos = geometry.attributes.position;
  const idx = geometry.index;
  const count = idx ? idx.count : pos.count;
  const at = (i) => (idx ? idx.getX(i) : i);
  const segs = [];
  const P = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let t = 0; t < count; t += 3) {
    for (let k = 0; k < 3; k++) { const v = at(t + k); P[k][0] = pos.getX(v); P[k][1] = pos.getY(v) - y; P[k][2] = pos.getZ(v); }
    const pts = [];
    for (let k = 0; k < 3; k++) {
      const a = P[k], b = P[(k + 1) % 3];
      if ((a[1] >= 0) !== (b[1] >= 0)) {
        const f = a[1] / (a[1] - b[1]);
        pts.push([a[0] + (b[0] - a[0]) * f, a[2] + (b[2] - a[2]) * f]);
      }
    }
    if (pts.length === 2 && Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]) > 1e-6) segs.push(pts);
  }
  // join the little pieces end to end into outlines
  const key = (p) => Math.round(p[0] * KEY) + "," + Math.round(p[1] * KEY);
  const ends = new Map();
  segs.forEach((s, i) => s.forEach((p) => { const k = key(p); if (!ends.has(k)) ends.set(k, []); ends.get(k).push(i); }));
  const used = new Uint8Array(segs.length);
  const loops = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const loop = [segs[i][0], segs[i][1]];
    for (;;) {
      const last = loop[loop.length - 1];
      const next = (ends.get(key(last)) || []).find((j) => !used[j]);
      if (next === undefined) break;
      used[next] = 1;
      const s = segs[next];
      loop.push(key(s[0]) === key(last) ? s[1] : s[0]);
    }
    if (key(loop[0]) === key(loop[loop.length - 1])) loop.pop();
    const clean = simplify(loop);
    if (clean.length >= 3 && Math.abs(area(clean)) > 1e-4) loops.push(clean);
  }
  return loops;
}

function area(l) {
  let a = 0;
  for (let i = 0; i < l.length; i++) { const p = l[i], q = l[(i + 1) % l.length]; a += p[0] * q[1] - q[0] * p[1]; }
  return a / 2;
}
// drop points that sit on a straight line between their neighbours
function simplify(l) {
  let pts = l;
  for (let pass = 0; pass < 2; pass++) {
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i + pts.length - 1) % pts.length], b = pts[i], c = pts[(i + 1) % pts.length];
      const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      const len = Math.hypot(c[0] - a[0], c[1] - a[1]) || 1;
      if (Math.abs(cross) / len > 1e-4) out.push(b);
    }
    if (out.length < 3) return pts;
    pts = out;
  }
  return pts;
}

/** Outlines as an SVG document sized in millimetres (red hairlines, the usual "cut" colour). */
export function outlinesToSVG(loops, title) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  loops.forEach((l) => l.forEach(([x, y]) => { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }));
  const m = 1; // a millimetre of margin so the lines aren't clipped
  const w = maxX - minX + 2 * m, h = maxY - minY + 2 * m;
  const n = (v) => String(Math.round(v * 1000) / 1000);
  const d = loops.map((l) => "M" + l.map(([x, y]) => n(x - minX + m) + " " + n(y - minY + m)).join("L") + "Z").join("");
  const esc = (s) => String(s).replace(/[<&>"]/g, (c) => ({ "<": "&lt;", "&": "&amp;", ">": "&gt;", '"': "&quot;" })[c]);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${n(w)}mm" height="${n(h)}mm" viewBox="0 0 ${n(w)} ${n(h)}">
  <title>${esc(title)}</title>
  <path d="${d}" fill="none" fill-rule="evenodd" stroke="#ff0000" stroke-width="0.1"/>
</svg>
`;
}
