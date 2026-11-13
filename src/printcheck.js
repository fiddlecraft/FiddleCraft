// Printing helpers: 3MF files (the format modern slicers prefer, keeps colours) and
// finding walls that are too thin for a 3D printer to make.
import * as THREE from "three";
import { MeshBVH } from "three-mesh-bvh";

// ---------- Thin walls ----------
// From the middle of every triangle, look straight into the material. If the far side of the
// wall is closer than `minWall` millimetres, that bit of the surface belongs to a thin wall.
// Returns the thin triangles (for showing them in red) and how much of the surface they cover.
export function findThinSpots(geometry, minWall) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry.clone();
  for (const k of Object.keys(g.attributes)) if (k !== "position") g.deleteAttribute(k);
  const pos = g.attributes.position;
  const tris = pos.count / 3;
  const bvh = new MeshBVH(g.clone()); // the tree reorders its own copy
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), n = new THREE.Vector3(), mid = new THREE.Vector3();
  const ray = new THREE.Ray();
  // very big designs: look at an even sample of the triangles, it is plenty to spot thin walls
  const step = Math.max(1, Math.ceil(tris / 150000));
  let total = 0, thin = 0, thinnest = Infinity;
  const out = [];
  for (let t = 0; t < tris; t += step) {
    a.fromBufferAttribute(pos, t * 3); b.fromBufferAttribute(pos, t * 3 + 1); c.fromBufferAttribute(pos, t * 3 + 2);
    e1.subVectors(b, a); e2.subVectors(c, a); n.crossVectors(e1, e2);
    const area2 = n.length();
    if (area2 < 1e-8) continue;
    const area = (area2 / 2) * step;
    total += area;
    n.divideScalar(area2); // outward
    mid.addVectors(a, b).add(c).divideScalar(3);
    ray.origin.copy(mid).addScaledVector(n, -1e-4);
    ray.direction.copy(n).negate();
    const hit = bvh.raycastFirst(ray, THREE.DoubleSide, 1e-3, minWall);
    if (!hit) continue;
    thin += area;
    thinnest = Math.min(thinnest, hit.distance);
    // lift the red copy a hair off the surface so it shows on top
    for (const v of [a, b, c]) out.push(v.x + n.x * 0.03, v.y + n.y * 0.03, v.z + n.z * 0.03);
  }
  return { thinArea: thin, totalArea: total, thinnest: thinnest === Infinity ? null : thinnest, positions: new Float32Array(out) };
}

// Small specks (tiny chamfers, the very tip of a cone) are normal; only warn about real areas.
export function isWorthWarning(r) {
  return !!r && r.thinArea > Math.max(2, r.totalArea * 0.003);
}

// ---------- Watertight meshes ----------
// Combining shapes leaves "T-junctions": a long edge on one side of a seam, two short edges on the
// other, so the seam isn't sealed. Slicers usually repair this, but a sealed mesh prints more reliably.
// Joins matching corners, then splits each long edge at the corners lying on it.
// Returns { verts: [[x,y,z]...], tris: [[a,b,c]...], tag: [per-triangle value] }.
export function sealMesh(geometry, tagOf = () => 0) {
  const pos = geometry.attributes.position;
  // corners closer than a hundredth of a millimetre are the same corner (cutting leaves tiny slivers)
  const verts = [], grid = new Map(), TOL = 0.01, CELL = 0.02;
  const corner = (k) => {
    const x = pos.getX(k), y = pos.getY(k), z = pos.getZ(k);
    const gx = Math.floor(x / CELL), gy = Math.floor(y / CELL), gz = Math.floor(z / CELL);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (let l = -1; l <= 1; l++) {
      const list = grid.get(`${gx + i},${gy + j},${gz + l}`);
      if (!list) continue;
      for (const id of list) {
        const v = verts[id];
        if (Math.abs(v[0] - x) < TOL && Math.abs(v[1] - y) < TOL && Math.abs(v[2] - z) < TOL) return id;
      }
    }
    const id = verts.length;
    verts.push([x, y, z]);
    const key = `${gx},${gy},${gz}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(id);
    return id;
  };
  let tris = [], tag = [];
  const count = geometry.index ? geometry.index.count : pos.count;
  const at = (k) => (geometry.index ? geometry.index.getX(k) : k);
  for (let k = 0; k < count; k += 3) {
    const a = corner(at(k)), b = corner(at(k + 1)), c = corner(at(k + 2));
    if (a === b || b === c || a === c) continue;
    tris.push([a, b, c]); tag.push(tagOf(at(k)));
  }
  const ek = (a, b) => (a < b ? a * 2097152 + b : b * 2097152 + a);
  for (let pass = 0; pass < 6; pass++) {
    const uses = new Map();
    for (const t of tris) for (let e = 0; e < 3; e++) { const k = ek(t[e], t[(e + 1) % 3]); uses.set(k, (uses.get(k) || 0) + 1); }
    const open = new Set();
    for (const t of tris) for (let e = 0; e < 3; e++) if (uses.get(ek(t[e], t[(e + 1) % 3])) === 1) { open.add(t[e]); open.add(t[(e + 1) % 3]); }
    if (!open.size) break;
    const candidates = [...open];
    let openEdges = 0;
    for (const v of uses.values()) if (v === 1) openEdges++;
    if (openEdges * candidates.length > 4e7) break; // enormous designs: leave it to the slicer
    const between = (a, b) => {
      const A = verts[a], B = verts[b];
      const dx = B[0] - A[0], dy = B[1] - A[1], dz = B[2] - A[2];
      const len2 = dx * dx + dy * dy + dz * dz;
      if (len2 < 1e-12) return [];
      const found = [];
      for (const v of candidates) {
        if (v === a || v === b) continue;
        const P = verts[v];
        const t = ((P[0] - A[0]) * dx + (P[1] - A[1]) * dy + (P[2] - A[2]) * dz) / len2;
        if (t <= 1e-6 || t >= 1 - 1e-6) continue;
        const qx = A[0] + dx * t - P[0], qy = A[1] + dy * t - P[1], qz = A[2] + dz * t - P[2];
        if (qx * qx + qy * qy + qz * qz < 1e-6) found.push([t, v]); // within a thousandth of a millimetre
      }
      return found.sort((p, q) => p[0] - q[0]).map((f) => f[1]);
    };
    let changed = false;
    const nt = [], ng = [];
    tris.forEach((t, i) => {
      for (let e = 0; e < 3; e++) {
        const a = t[e], b = t[(e + 1) % 3], c = t[(e + 2) % 3];
        if (uses.get(ek(a, b)) !== 1) continue;
        const mids = between(a, b);
        if (!mids.length) continue;
        const chain = [a, ...mids, b];
        for (let j = 0; j < chain.length - 1; j++) { nt.push([chain[j], chain[j + 1], c]); ng.push(tag[i]); }
        changed = true;
        return;
      }
      nt.push(t); ng.push(tag[i]);
    });
    tris = nt; tag = ng;
    if (!changed) break;
  }
  return { verts, tris, tag };
}

// A sealed copy as plain triangles (for STL)
export function sealedGeometry(geometry) {
  const { verts, tris } = sealMesh(geometry);
  const arr = new Float32Array(tris.length * 9);
  tris.forEach((t, i) => t.forEach((v, j) => arr.set(verts[v], i * 9 + j * 3)));
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(arr, 3));
  g.computeVertexNormals();
  return g;
}

// ---------- 3MF ----------
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const num = (v) => String(+v.toFixed(4));

// parts: [{ name, color: THREE.Color, geometry (non-indexed, millimetres, Y up, maybe a colour per corner) }]
export function model3MF(parts, title) {
  const colours = new Map(); // "#rrggbb" -> index in the colour list
  const colourIndex = (hex) => { if (!colours.has(hex)) colours.set(hex, colours.size); return colours.get(hex); };
  const objects = [];
  const c = new THREE.Color();
  parts.forEach((p, i) => {
    const col = p.geometry.attributes.color;
    const base = colourIndex("#" + p.color.getHexString());
    // each triangle's colour: the part's own, or (multicolour groups) the colour of its first corner
    const tagOf = (k) => {
      if (!col) return base;
      c.setRGB(col.getX(k), col.getY(k), col.getZ(k)); // stored as linear light; getHexString gives screen colour
      return colourIndex("#" + c.getHexString());
    };
    const mesh = sealMesh(p.geometry, tagOf);
    // printers use Z up: (x, y, z) in the design becomes (x, -z, y)
    const verts = mesh.verts.map(([x, y, z]) => `<vertex x="${num(x)}" y="${num(-z)}" z="${num(y)}"/>`);
    const tris = mesh.tris.map(([a, b, cc], i) => `<triangle v1="${a}" v2="${b}" v3="${cc}"${mesh.tag[i] !== base ? ` pid="1" p1="${mesh.tag[i]}"` : ""}/>`);
    objects.push(`<object id="${i + 2}" type="model" name="${esc(p.name)}" pid="1" pindex="${base}"><mesh><vertices>${verts.join("")}</vertices><triangles>${tris.join("")}</triangles></mesh></object>`);
  });
  const bases = [...colours.keys()].map((hex) => `<base name="${hex}" displaycolor="${hex.toUpperCase()}FF"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
<metadata name="Title">${esc(title)}</metadata>
<metadata name="Application">FiddleCraft</metadata>
<resources>
<basematerials id="1">${bases}</basematerials>
${objects.join("\n")}
</resources>
<build>${parts.map((_, i) => `<item objectid="${i + 2}"/>`).join("")}</build>
</model>
`;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>
`;
const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>
`;

export async function make3MF(parts, title) {
  return zip([
    ["[Content_Types].xml", CONTENT_TYPES],
    ["_rels/.rels", RELS],
    ["3D/3dmodel.model", model3MF(parts, title)],
  ]);
}

// ---------- A small ZIP writer (3MF files are ZIP archives) ----------
let crcTable;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[i] = c >>> 0; }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
async function deflate(bytes) {
  if (typeof CompressionStream === "undefined") return null;
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function zip(files) {
  const enc = new TextEncoder();
  const chunks = [], central = [];
  let offset = 0;
  for (const [name, text] of files) {
    const nameBytes = enc.encode(name);
    const raw = enc.encode(text);
    const packed = await deflate(raw);
    const data = packed || raw;
    const method = packed ? 8 : 0;
    const crc = crc32(raw);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0, true);
    local.setUint16(8, method, true); local.setUint16(10, 0, true); local.setUint16(12, 0x21, true);
    local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, raw.length, true);
    local.setUint16(26, nameBytes.length, true); local.setUint16(28, 0, true);
    chunks.push(new Uint8Array(local.buffer), nameBytes, data);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true); cen.setUint16(8, 0, true);
    cen.setUint16(10, method, true); cen.setUint16(12, 0, true); cen.setUint16(14, 0x21, true);
    cen.setUint32(16, crc, true); cen.setUint32(20, data.length, true); cen.setUint32(24, raw.length, true);
    cen.setUint16(28, nameBytes.length, true); cen.setUint32(42, offset, true);
    central.push(new Uint8Array(cen.buffer), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const cenSize = central.reduce((s, b) => s + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cenSize, true); end.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], { type: "model/3mf" });
}
