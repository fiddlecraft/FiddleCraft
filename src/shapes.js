import * as THREE from "three";
import { mergeGeometries, mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { ConvexGeometry } from "three/examples/jsm/geometries/ConvexGeometry.js";

// Every shape is built to fit a 1 × 1 × 1 box sitting on the workplane (base at y = 0),
// then stretched to its size in millimetres with mesh.scale.
export function normalize(geo) {
  geo.computeBoundingBox();
  const b = geo.boundingBox;
  const size = new THREE.Vector3();
  b.getSize(size);
  geo.translate(-(b.min.x + b.max.x) / 2, -b.min.y, -(b.min.z + b.max.z) / 2);
  geo.scale(1 / size.x, 1 / size.y, 1 / size.z);
  geo.computeVertexNormals();
  return geo;
}

function extrude(shape) {
  const g = new THREE.ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false, curveSegments: 32 });
  g.rotateX(-Math.PI / 2); // lay the outline flat, extrude upwards
  return g;
}

function star(o) {
  const n = Math.max(3, Math.min(30, Math.round(o.points || 5)));
  const inner = 0.5 * Math.min(95, Math.max(5, o.inner || 40)) / 100;
  const s = new THREE.Shape();
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 ? inner : 0.5;
    const a = (i / (n * 2)) * Math.PI * 2 + Math.PI / 2;
    const p = [Math.cos(a) * r, Math.sin(a) * r];
    i ? s.lineTo(...p) : s.moveTo(...p);
  }
  return extrude(s);
}

function heart() {
  const s = new THREE.Shape();
  s.moveTo(0, -0.5);
  s.bezierCurveTo(-0.15, -0.35, -0.5, -0.15, -0.5, 0.12);
  s.bezierCurveTo(-0.5, 0.38, -0.25, 0.5, -0.12, 0.45);
  s.bezierCurveTo(-0.05, 0.42, 0, 0.36, 0, 0.3);
  s.bezierCurveTo(0, 0.36, 0.05, 0.42, 0.12, 0.45);
  s.bezierCurveTo(0.25, 0.5, 0.5, 0.38, 0.5, 0.12);
  s.bezierCurveTo(0.5, -0.15, 0.15, -0.35, 0, -0.5);
  return extrude(s);
}

function roof() {
  const s = new THREE.Shape();
  s.moveTo(-0.5, 0); s.lineTo(0.5, 0); s.lineTo(0, 1); s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: 1, bevelEnabled: false });
  return g;
}

function tube(s) {
  const inner = 0.5 - Math.min(45, Math.max(2, s.wall)) / 100;
  const pts = [new THREE.Vector2(inner, 0), new THREE.Vector2(0.5, 0), new THREE.Vector2(0.5, 1), new THREE.Vector2(inner, 1), new THREE.Vector2(inner, 0)];
  return new THREE.LatheGeometry(pts, s.sides);
}

function halfSphere(s) {
  // dome plus a flat bottom, so it is a closed solid that can be printed and cut
  const dome = new THREE.SphereGeometry(0.5, s.steps * 2, Math.max(2, Math.round(s.steps / 2)), 0, Math.PI * 2, 0, Math.PI / 2);
  const base = new THREE.CircleGeometry(0.5, s.steps * 2).rotateX(Math.PI / 2);
  return mergeGeometries([dome.toNonIndexed(), base.toNonIndexed()]);
}

function wedge() {
  const s = new THREE.Shape();
  s.moveTo(-0.5, 0); s.lineTo(0.5, 0); s.lineTo(-0.5, 1); s.closePath();
  return new THREE.ExtrudeGeometry(s, { depth: 1, bevelEnabled: false });
}

function roundRoof(o) {
  // half a cylinder lying on its side
  const s = new THREE.Shape();
  s.moveTo(0.5, 0);
  s.absarc(0, 0, 0.5, 0, Math.PI, false);
  s.closePath();
  return new THREE.ExtrudeGeometry(s, { depth: 1, bevelEnabled: false, curveSegments: Math.max(2, Math.round(o.sides / 2)) });
}

function paraboloid(s) {
  // a rounded dome that narrows to a point, like a bullet
  const pts = [new THREE.Vector2(0, 0)];
  const N = 32;
  for (let i = 0; i <= N; i++) {
    const r = 0.5 * (1 - i / N);
    pts.push(new THREE.Vector2(r, 1 - (r / 0.5) ** 2));
  }
  return new THREE.LatheGeometry(pts, s.sides);
}

function ring(s) {
  const tube = 0.5 * Math.min(45, Math.max(2, s.tube)) / 100;
  return new THREE.TorusGeometry(0.5 - tube, tube, 16, s.sides).rotateX(Math.PI / 2);
}

function torus(s) {
  const tube = 0.5 * Math.min(90, Math.max(5, s.tube)) / 100;
  return new THREE.TorusGeometry(0.5 - tube, tube, s.steps, s.sides).rotateX(Math.PI / 2);
}

function cylinder(s) {
  // optional bevel: round off the top and bottom edges by a true distance in millimetres
  if (!(s.bevel > 0)) return new THREE.CylinderGeometry(0.5, 0.5, 1, s.sides);
  const R = (s.w || 20) / 2, H = s.h || 20;
  const b = Math.min(s.bevel, R - 0.05, H / 2 - 0.05);
  const pts = [new THREE.Vector2(0, 0)];
  const arc = (cx, cy, a0, a1) => { for (let i = 0; i <= 8; i++) { const a = a0 + ((a1 - a0) * i) / 8; pts.push(new THREE.Vector2(cx + Math.cos(a) * b, cy + Math.sin(a) * b)); } };
  arc(R - b, b, -Math.PI / 2, 0);
  arc(R - b, H - b, 0, Math.PI / 2);
  pts.push(new THREE.Vector2(0, H));
  return new THREE.LatheGeometry(pts, s.sides);
}

function polygon(s) {
  const n = Math.max(3, Math.min(64, Math.round((s && s.sides) || 5)));
  return new THREE.CylinderGeometry(0.5, 0.5, 1, n);
}

function box(s) {
  // a plain box, or one with rounded corners that keep their true radius in millimetres
  if (!(s.radius > 0)) return new THREE.BoxGeometry(1, 1, 1);
  const w = s.w || 20, d = s.d || 20, h = s.h || 20;
  const r = Math.min(s.radius, Math.min(w, d, h) / 2 - 0.01);
  return new RoundedBoxGeometry(w, h, d, Math.max(1, Math.round(s.steps)), Math.max(0.05, r));
}

function roundedBox(s) {
  // corners keep their true radius in millimetres, whatever the box size
  const w = (s && s.w) || 20, d = (s && s.d) || 20, h = (s && s.h) || 20;
  const r = Math.max(0.1, Math.min((s && s.radius) || 3, Math.min(w, d, h) / 2 - 0.01));
  return new RoundedBoxGeometry(w, h, d, 4, r);
}

function gear(s) {
  const n = Math.max(6, Math.min(80, Math.round((s && s.teeth) || 16)));
  const outer = 0.5, root = 0.5 - 0.9 / n - 0.02;
  const shape = new THREE.Shape();
  const step = (Math.PI * 2) / n;
  for (let i = 0; i < n; i++) {
    const a = i * step;
    const pts = [[root, a], [outer, a + step * 0.15], [outer, a + step * 0.45], [root, a + step * 0.6]];
    pts.forEach(([r, ang], k) => {
      const x = Math.cos(ang) * r, y = Math.sin(ang) * r;
      if (i === 0 && k === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
    });
  }
  shape.closePath();
  const hole = new THREE.Path();
  hole.absarc(0, 0, 0.09, 0, Math.PI * 2, true);
  shape.holes.push(hole);
  return new THREE.ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false, curveSegments: 24 }).rotateX(-Math.PI / 2);
}

function screw(s) {
  // a threaded rod: the radius rises and falls in a spiral (a saw-tooth thread), with flat ends
  const threads = Math.max(2, Math.min(80, Math.round(s.threads)));
  const depth = 0.5 * Math.min(40, Math.max(2, s.depth)) / 100;
  const core = 0.5 - depth;
  const around = 48, up = threads * 12;
  const pos = [], idx = [];
  for (let j = 0; j <= up; j++) {
    const y = j / up;
    for (let i = 0; i < around; i++) {
      const a = (i / around) * Math.PI * 2;
      let ph = (y * threads - i / around) % 1;
      if (ph < 0) ph += 1;
      const tri = 1 - Math.abs(ph * 2 - 1); // 0..1..0 along each thread
      // taper the thread to nothing at both ends so the rod sits flat
      const fade = Math.min(1, y * threads, (1 - y) * threads);
      const r = core + depth * tri * fade;
      pos.push(Math.cos(a) * r, y, Math.sin(a) * r);
    }
  }
  for (let j = 0; j < up; j++) {
    for (let i = 0; i < around; i++) {
      const a = j * around + i, b = j * around + ((i + 1) % around), c = a + around, d = b + around;
      idx.push(a, c, b, b, c, d);
    }
  }
  // flat caps at the bottom and top
  const bottom = pos.length / 3; pos.push(0, 0, 0);
  const top = bottom + 1; pos.push(0, 1, 0);
  for (let i = 0; i < around; i++) {
    const n = (i + 1) % around;
    idx.push(bottom, i, n);
    idx.push(top, up * around + n, up * around + i);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g.toNonIndexed();
}

function nut(s) {
  // a hexagonal nut with a round hole through the middle
  const hole = 0.5 * Math.min(85, Math.max(10, s.bore)) / 100;
  const shape = new THREE.Shape();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    i ? shape.lineTo(Math.cos(a) * 0.5, Math.sin(a) * 0.5) : shape.moveTo(Math.cos(a) * 0.5, Math.sin(a) * 0.5);
  }
  shape.closePath();
  const h = new THREE.Path();
  h.absarc(0, 0, hole, 0, Math.PI * 2, true);
  shape.holes.push(h);
  return new THREE.ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false, curveSegments: 32 }).rotateX(-Math.PI / 2);
}

function spring(s) {
  const turns = Math.max(1, Math.min(30, Math.round((s && s.turns) || 5)));
  const tube = 0.06;
  class Helix extends THREE.Curve {
    getPoint(t, target = new THREE.Vector3()) {
      const a = t * turns * Math.PI * 2;
      return target.set(Math.cos(a) * (0.5 - tube), tube + t * (1 - 2 * tube), Math.sin(a) * (0.5 - tube));
    }
  }
  const curve = new Helix();
  const coil = new THREE.TubeGeometry(curve, turns * 40, tube, 12, false);
  // round caps on both ends so the spring is a closed, printable solid
  const cap = (t) => { const p = curve.getPoint(t); return new THREE.SphereGeometry(tube, 12, 8).translate(p.x, p.y, p.z); };
  return mergeGeometries([coil, cap(0), cap(1)]);
}

// Several traced outlines (from Scribble or a picture) to shapes with their holes.
// The biggest outline is an outside edge; outlines turning the same way are outside edges too,
// the others are holes, each belonging to the smallest outside edge around it.
function shapesFromLoops(loops) {
  const signed = (l) => { let a = 0; for (let i = 0, j = l.length - 1; i < l.length; j = i++) a += (l[j].x - l[i].x) * (l[j].y + l[i].y); return a / 2; };
  const inside = (p, l) => { let c = false; for (let i = 0, j = l.length - 1; i < l.length; j = i++) { const a = l[i], b = l[j]; if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c; } return c; };
  const list = loops.filter((l) => l.length >= 3).map((l) => { const pts = l.map(([x, y]) => new THREE.Vector2(x - 0.5, 0.5 - y)); return { pts, a: signed(pts) }; });
  if (!list.length) return [];
  const big = list.reduce((m, l) => (Math.abs(l.a) > Math.abs(m.a) ? l : m));
  const outs = list.filter((l) => Math.sign(l.a) === Math.sign(big.a)).map((l) => ({ ...l, shape: new THREE.Shape(l.pts) }));
  for (const h of list.filter((l) => Math.sign(l.a) !== Math.sign(big.a))) {
    const around = outs.filter((o) => inside(h.pts[0], o.pts)).sort((p, q) => Math.abs(p.a) - Math.abs(q.a))[0];
    if (around) around.shape.holes.push(new THREE.Path(h.pts));
  }
  return outs.map((o) => o.shape);
}

function scribble(s) {
  // the outline drawn by hand, stored as points from 0 to 1 (or several outlines, with holes)
  const pts = (s && Array.isArray(s.path) && s.path.length >= 3) ? s.path : [[0, 0], [1, 0], [0.5, 1]];
  const traced = s && Array.isArray(s.loops) && s.loops.length ? shapesFromLoops(s.loops) : [];
  const shape = traced.length ? traced : new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x - 0.5, 0.5 - y)));
  const taper = Math.min(200, Math.max(0, s && s.taper != null ? s.taper : 100)) / 100; // top size compared with the bottom
  const twist = THREE.MathUtils.degToRad(Math.min(720, Math.max(-720, (s && s.twist) || 0)));
  const plain = Math.abs(taper - 1) < 1e-6 && !twist;
  // tapering and twisting need the sides cut into thin slices so they can bend smoothly
  const g = new THREE.ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false, steps: plain ? 1 : Math.max(8, Math.ceil(Math.abs(twist) / 0.1)) }).rotateX(-Math.PI / 2);
  if (plain) return g;
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i), k = 1 + (Math.max(taper, 0.001) - 1) * y, a = twist * y;
    const x = pos.getX(i) * k, z = pos.getZ(i) * k;
    pos.setXYZ(i, x * Math.cos(a) - z * Math.sin(a), y, x * Math.sin(a) + z * Math.cos(a));
  }
  return g;
}

// ---------- Symbols, signs and maths: flat outlines raised upwards ----------
const outline = (pts) => { const sh = new THREE.Shape(); pts.forEach(([x, y], i) => (i ? sh.lineTo(x, y) : sh.moveTo(x, y))); sh.closePath(); return sh; };
const rect = (x0, y0, x1, y1) => outline([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
const raise = (shapes) => new THREE.ExtrudeGeometry(shapes, { depth: 1, bevelEnabled: false, curveSegments: 32 }).rotateX(-Math.PI / 2);

function arrow(o) {
  const t = 0.5 * Math.min(90, Math.max(10, o.shaft || 40)) / 100; // half the shaft's thickness
  return raise(outline([[-0.5, -t], [0.05, -t], [0.05, -0.5], [0.5, 0], [0.05, 0.5], [0.05, t], [-0.5, t]]));
}
function doubleArrow(o) {
  const t = 0.5 * Math.min(90, Math.max(10, o.shaft || 40)) / 100;
  return raise(outline([[-0.5, 0], [-0.15, -0.5], [-0.15, -t], [0.15, -t], [0.15, -0.5], [0.5, 0], [0.15, 0.5], [0.15, t], [-0.15, t], [-0.15, 0.5]]));
}
function plusShape(o, turn = 0) {
  const t = 0.5 * Math.min(90, Math.max(5, o.thick || 30)) / 100;
  const sh = outline([[-t, -0.5], [t, -0.5], [t, -t], [0.5, -t], [0.5, t], [t, t], [t, 0.5], [-t, 0.5], [-t, t], [-0.5, t], [-0.5, -t], [-t, -t]]);
  const g = raise(sh);
  if (turn) g.rotateY(turn);
  return g;
}
const minusShape = () => raise(rect(-0.5, -0.5, 0.5, 0.5)); // a bar: stretched thin by its size
function equalsShape() { return raise([rect(-0.5, -0.5, 0.5, -0.15), rect(-0.5, 0.15, 0.5, 0.5)]); }
function divideShape() {
  const dot = (y) => { const c = new THREE.Shape(); c.absarc(0, y, 0.13, 0, Math.PI * 2, false); return c; };
  return raise([rect(-0.5, -0.09, 0.5, 0.09), dot(0.35), dot(-0.35)]);
}
function check() { return raise(outline([[-0.5, 0.05], [-0.32, 0.23], [-0.12, 0.03], [0.32, 0.5], [0.5, 0.32], [-0.12, -0.33]])); }
function moon(o) {
  // a crescent: a circle with a bite taken out of one side
  const R = 0.5, r = 0.5 * Math.min(95, Math.max(40, o.bite || 85)) / 100, cx = R * 0.45;
  const x = (R * R - r * r + cx * cx) / (2 * cx), y = Math.sqrt(Math.max(1e-6, R * R - x * x));
  const a = Math.atan2(y, x), b = Math.atan2(y, x - cx);
  const sh = new THREE.Shape();
  sh.absarc(0, 0, R, a, Math.PI * 2 - a, false);
  sh.absarc(cx, 0, r, -b, b, true);
  return raise(sh);
}
function lightning() { return raise(outline([[0.1, 0.5], [-0.35, -0.02], [-0.02, -0.02], [-0.15, -0.5], [0.35, 0.08], [0.03, 0.08]])); }
function speech() {
  const sh = new THREE.Shape();
  const pts = [];
  for (let i = 0; i <= 48; i++) {
    const ang = -1.35 + (i / 48) * (Math.PI * 2 - 0.5);
    pts.push([Math.cos(ang) * 0.5, 0.12 + Math.sin(ang) * 0.36]);
  }
  pts.forEach(([px, py], i) => (i ? sh.lineTo(px, py) : sh.moveTo(px, py)));
  sh.lineTo(-0.3, -0.5);
  sh.closePath();
  return raise(sh);
}
function drop() {
  const c = -0.18, r = 0.32, d = 0.5 - c, phi = Math.acos(r / d);
  const sh = new THREE.Shape();
  sh.moveTo(0, 0.5);
  sh.lineTo(r * Math.cos(Math.PI / 2 + phi), c + r * Math.sin(Math.PI / 2 + phi)); // the pointed tip
  sh.absarc(0, c, r, Math.PI / 2 + phi, Math.PI * 2.5 - phi, false);
  sh.closePath();
  return raise(sh);
}
function flower(o) {
  const n = Math.max(3, Math.min(12, Math.round(o.petals || 5)));
  const sh = new THREE.Shape();
  for (let i = 0; i <= 180; i++) {
    const ang = (i / 180) * Math.PI * 2;
    const rr = 0.32 + 0.18 * Math.abs(Math.cos((n * ang) / 2));
    const px = Math.cos(ang + Math.PI / 2) * rr, py = Math.sin(ang + Math.PI / 2) * rr;
    i ? sh.lineTo(px, py) : sh.moveTo(px, py);
  }
  return raise(sh);
}

// ---------- Connectors and hardware ----------
// an L-shaped bracket standing up (its outline drawn side-on, made as deep as the shape)
function bracket(o) {
  const t = Math.min(45, Math.max(5, o.thick || 20)) / 100;
  return new THREE.ExtrudeGeometry(outline([[0, 0], [1, 0], [1, t], [t, t], [t, 1], [0, 1]]), { depth: 1, bevelEnabled: false });
}
// a J-shaped hook standing up
function hook() {
  const sh = new THREE.Shape();
  sh.moveTo(-0.5, 1); sh.lineTo(-0.5, 0.3);
  sh.absarc(0, 0.3, 0.5, Math.PI, Math.PI * 2, false);
  sh.lineTo(0.5, 0.55); sh.lineTo(0.3, 0.55); sh.lineTo(0.3, 0.3);
  sh.absarc(0, 0.3, 0.3, 0, Math.PI, true);
  sh.lineTo(-0.3, 1); sh.closePath();
  return new THREE.ExtrudeGeometry(sh, { depth: 1, bevelEnabled: false, curveSegments: 24 });
}
// a peg with a rounded tip, for pushing into a matching hole
function pin(o) {
  const pts = [new THREE.Vector2(0, 0), new THREE.Vector2(0.5, 0)];
  for (let i = 0; i <= 8; i++) { const ang = (i / 8) * (Math.PI / 2); pts.push(new THREE.Vector2(0.3 + 0.2 * Math.cos(ang), 0.8 + 0.2 * Math.sin(ang))); }
  pts.push(new THREE.Vector2(0, 1));
  return new THREE.LatheGeometry(pts, o.sides || 48);
}
// a bolt: a hexagon head on a threaded shaft, made as one closed surface
function bolt(o) {
  const threads = Math.max(2, Math.min(60, Math.round(o.threads || 10)));
  const headH = Math.min(50, Math.max(10, o.head || 22)) / 100, top = 1 - headH;
  const shaft = 0.3, depth = 0.05, core = shaft - depth;
  const around = 48, up = threads * 12;
  const pos = [], idx = [];
  const hex = (ang) => 0.5 * Math.cos(Math.PI / 6) / Math.cos(((ang % (Math.PI / 3)) + Math.PI / 3) % (Math.PI / 3) - Math.PI / 6);
  const row = (y, rf) => { for (let i = 0; i < around; i++) { const ang = (i / around) * Math.PI * 2; const rr = rf(ang, i); pos.push(Math.cos(ang) * rr, y, Math.sin(ang) * rr); } };
  for (let j = 0; j <= up; j++) {
    const y = (j / up) * top, f = j / up;
    row(y, (ang, i) => {
      let ph = (f * threads - i / around) % 1;
      if (ph < 0) ph += 1;
      const fade = Math.min(1, f * threads, (1 - f) * threads);
      return core + depth * (1 - Math.abs(ph * 2 - 1)) * fade;
    });
  }
  row(top, hex);
  row(1, hex);
  const rows = up + 3;
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < around; i++) {
      const a = j * around + i, b = j * around + ((i + 1) % around), c = a + around, d = b + around;
      idx.push(a, c, b, b, c, d);
    }
  }
  const bottom = pos.length / 3; pos.push(0, 0, 0);
  const cap = bottom + 1; pos.push(0, 1, 0);
  const last = (rows - 1) * around;
  for (let i = 0; i < around; i++) {
    const n = (i + 1) % around;
    idx.push(bottom, i, n);
    idx.push(cap, last + n, last + i);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g.toNonIndexed();
}

// A spun shape: a side profile drawn by hand, turned around an upright axis (like a potter's wheel).
// The profile is stored as points from 0 to 1: [distance from the axis, height].
function spun(o) {
  let pts = (o && Array.isArray(o.path) && o.path.length >= 3) ? o.path : [[0, 0], [0.8, 0], [1, 0.3], [0.55, 0.65], [0.7, 1], [0, 1]];
  pts = pts.map(([r, y]) => [Math.max(0, Math.min(1, r)) * 0.5, Math.max(0, Math.min(1, y))]);
  // the outline must run anticlockwise (seen with the axis on the left) so the surface faces outwards
  let area = 0;
  for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; area += p[0] * q[1] - q[0] * p[1]; }
  if (area < 0) pts = pts.slice().reverse();
  const v = pts.map(([r, y]) => new THREE.Vector2(r, y));
  v.push(v[0].clone());
  return new THREE.LatheGeometry(v, Math.max(3, Math.min(96, Math.round((o && o.sides) || 48))));
}

// ---------- More basic and connector shapes ----------
// a pill: a cylinder with rounded ends
function capsule(o) {
  const pts = [], n = 12;
  for (let i = 0; i <= n; i++) { const a = -Math.PI / 2 + (i / n) * (Math.PI / 2); pts.push(new THREE.Vector2(0.5 * Math.cos(a), 0.5 + 0.5 * Math.sin(a))); }
  for (let i = 0; i <= n; i++) { const a = (i / n) * (Math.PI / 2); pts.push(new THREE.Vector2(0.5 * Math.cos(a), 1.5 + 0.5 * Math.sin(a))); }
  pts[0].x = 0; pts[pts.length - 1].x = 0;
  return new THREE.LatheGeometry(pts, o.sides || 48);
}
// a bowl: the bottom half of a hollow ball
function bowl(o) {
  const t = Math.min(45, Math.max(2, o.wall || 12)) / 100, ri = 0.5 - t, n = 24, pts = [];
  for (let i = 0; i <= n; i++) { const a = (i / n) * (Math.PI / 2); pts.push(new THREE.Vector2(0.5 * Math.sin(a), 0.5 - 0.5 * Math.cos(a))); }
  for (let i = n; i >= 0; i--) { const a = (i / n) * (Math.PI / 2); pts.push(new THREE.Vector2(ri * Math.sin(a), 0.5 - ri * Math.cos(a))); }
  pts.push(pts[0].clone());
  return new THREE.LatheGeometry(pts, o.sides || 64);
}
// two pyramids base to base
function bipyramid(o) {
  const n = Math.max(3, Math.min(24, Math.round(o.sides || 6)));
  return new THREE.LatheGeometry([new THREE.Vector2(0, 0), new THREE.Vector2(0.5, 0.5), new THREE.Vector2(0, 1), new THREE.Vector2(0, 0)], n).rotateY(Math.PI / n);
}
// a dovetail: wider at the top than at the bottom, standing up (its outline drawn side-on)
function dovetail(o) {
  const k = 0.5 * Math.min(95, Math.max(20, o.narrow || 60)) / 100;
  return new THREE.ExtrudeGeometry(outline([[-k, 0], [k, 0], [0.5, 1], [-0.5, 1]]), { depth: 1, bevelEnabled: false });
}
// a keyhole for hanging things on a screw: a round hole with a slot above it
function keyhole() {
  const sh = new THREE.Shape();
  const y0 = -0.5 + Math.sqrt(0.25 - 0.0625);
  sh.moveTo(-0.25, 1); sh.lineTo(-0.25, y0);
  sh.absarc(0, -0.5, 0.5, Math.PI * 2 / 3, Math.PI * 2 + Math.PI / 3, false);
  sh.lineTo(0.25, 1); sh.closePath();
  return raise(sh);
}

// ---------- Braille: raised dots on a tile, from typed text (standard grade 1 braille) ----------
// Dots are numbered 1-2-3 down the left column and 4-5-6 down the right.
const BRAILLE_LETTERS = { a: [1], b: [1, 2], c: [1, 4], d: [1, 4, 5], e: [1, 5], f: [1, 2, 4], g: [1, 2, 4, 5], h: [1, 2, 5], i: [2, 4], j: [2, 4, 5] };
"klmnopqrst".split("").forEach((ch, i) => { BRAILLE_LETTERS[ch] = [...BRAILLE_LETTERS["abcdefghij"[i]], 3]; });
"uvxyz".split("").forEach((ch, i) => { BRAILLE_LETTERS[ch] = [...BRAILLE_LETTERS["abcde"[i]], 3, 6]; });
BRAILLE_LETTERS.w = [2, 4, 5, 6];
const BRAILLE_MARKS = { ".": [2, 5, 6], ",": [2], "?": [2, 3, 6], "!": [2, 3, 5], "'": [3], "-": [3, 6], ";": [2, 3], ":": [2, 5], " ": [] };
const NUMBER_SIGN = [3, 4, 5, 6], CAPITAL_SIGN = [6];
// the braille cells for some text: a capital sign before capitals, a number sign before each run of digits
export function brailleCells(text) {
  const cells = [];
  let inNumber = false;
  for (const ch of String(text || "").slice(0, 40)) {
    if (/[0-9]/.test(ch)) {
      if (!inNumber) cells.push(NUMBER_SIGN);
      inNumber = true;
      cells.push(BRAILLE_LETTERS["jabcdefghi"[+ch]]);
      continue;
    }
    inNumber = false;
    const low = ch.toLowerCase();
    if (BRAILLE_LETTERS[low]) { if (ch !== low) cells.push(CAPITAL_SIGN); cells.push(BRAILLE_LETTERS[low]); }
    else if (BRAILLE_MARKS[ch]) cells.push(BRAILLE_MARKS[ch]);
  }
  return cells.length ? cells : [[]];
}
// real sizes in millimetres (common sign standards): dots 1.5 mm across, 2.5 mm apart, cells 6.2 mm apart
const B = { pitch: 6.2, dot: 2.5, margin: 2.6, plate: 1.6, dotH: 0.6, dotR: 0.75 };
export function brailleSize(text) {
  const n = brailleCells(text).length;
  return { w: Math.round((B.margin * 2 + (n - 1) * B.pitch + B.dot) * 100) / 100, d: Math.round((B.margin * 2 + 2 * B.dot) * 100) / 100, h: B.plate + B.dotH };
}
function braille(o) {
  const cells = brailleCells(o.text || "a");
  const { w, d } = brailleSize(o.text || "a");
  const clean = (g) => { const n = g.index ? g.toNonIndexed() : g; for (const k of Object.keys(n.attributes)) if (k !== "position" && k !== "normal") n.deleteAttribute(k); return n; };
  const parts = [clean(new THREE.BoxGeometry(w, B.plate, d).translate(0, B.plate / 2, 0))];
  cells.forEach((cell, i) => cell.forEach((n) => {
    const x = -w / 2 + B.margin + i * B.pitch + (n > 3 ? B.dot : 0);
    const z = -d / 2 + B.margin + ((n - 1) % 3) * B.dot;
    // a rounded dot, its lower half sunk into the tile
    parts.push(clean(new THREE.SphereGeometry(B.dotR, 16, 8).scale(1, B.dotH / B.dotR, 1).translate(x, B.plate, z)));
  }));
  return mergeGeometries(parts);
}

// a slice of a circle, its point at the centre; with a hollow middle it becomes a curved band
function pie(o) {
  const a = THREE.MathUtils.degToRad(Math.min(359, Math.max(5, o.angle || 45)));
  const inner = 0.5 * Math.min(95, Math.max(0, o.inner || 0)) / 100;
  const sh = new THREE.Shape();
  if (inner > 0) {
    sh.absarc(0, 0, 0.5, Math.PI / 2 - a / 2, Math.PI / 2 + a / 2, false);
    sh.absarc(0, 0, inner, Math.PI / 2 + a / 2, Math.PI / 2 - a / 2, true);
  } else {
    // (an arc that starts a path ignores moveTo, so draw the edge to the arc first)
    sh.moveTo(0, 0);
    sh.lineTo(0.5 * Math.cos(Math.PI / 2 - a / 2), 0.5 * Math.sin(Math.PI / 2 - a / 2));
    sh.absarc(0, 0, 0.5, Math.PI / 2 - a / 2, Math.PI / 2 + a / 2, false);
  }
  sh.closePath();
  return raise(sh);
}
// a flat frame: a rectangle with a rectangular opening
function frame(o) {
  const t = 0.5 * Math.min(90, Math.max(4, o.wall || 20)) / 100;
  const sh = rect(-0.5, -0.5, 0.5, 0.5);
  sh.holes.push(rect(-0.5 + t, -0.5 + t, 0.5 - t, 0.5 - t));
  return raise(sh);
}

// ---------- Polyhedra: built as the outer skin around a set of corner points, one face down ----------
const PHI = (1 + Math.sqrt(5)) / 2;
const perms = (x, y, z) => { const out = []; for (const [a, b, c] of [[x, y, z], [y, z, x], [z, x, y]]) for (const sa of a ? [1, -1] : [1]) for (const sb of b ? [1, -1] : [1]) for (const sc of c ? [1, -1] : [1]) out.push([a * sa, b * sb, c * sc]); return out; };
const BASE = {
  tetra: [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]],
  cube: perms(1, 1, 1).filter((v, i, a) => a.findIndex((u) => u.join() === v.join()) === i),
  octa: perms(1, 0, 0),
  icosa: [...perms(0, 1, PHI)],
  dodeca: [...perms(1, 1, 1), ...perms(0, 1 / PHI, PHI)],
};
// cut every corner off a solid (t of the way along each edge); t = 0.5 meets in the middle of the edges
function truncate(points, t) {
  let min = Infinity;
  for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) min = Math.min(min, Math.hypot(...points[i].map((v, k) => v - points[j][k])));
  const out = [];
  for (let i = 0; i < points.length; i++) for (let j = 0; j < points.length; j++) {
    if (i === j || Math.abs(Math.hypot(...points[i].map((v, k) => v - points[j][k])) - min) > 1e-6) continue;
    out.push(points[i].map((v, k) => v + (points[j][k] - v) * t));
  }
  return out;
}
const SOLIDS = {
  tetra: () => BASE.tetra, cube: () => BASE.cube, octa: () => BASE.octa, icosa: () => BASE.icosa, dodeca: () => BASE.dodeca,
  trunctetra: () => truncate(BASE.tetra, 1 / 3), trunccube: () => truncate(BASE.cube, 1 / (2 + Math.SQRT2)), truncocta: () => truncate(BASE.octa, 1 / 3),
  truncicosa: () => truncate(BASE.icosa, 1 / 3), cubocta: () => truncate(BASE.cube, 0.5), icosidodeca: () => truncate(BASE.icosa, 0.5),
  rhombicubocta: () => perms(1, 1, 1 + Math.SQRT2).concat(perms(1, 1 + Math.SQRT2, 1), perms(1 + Math.SQRT2, 1, 1)),
  rhombicdodeca: () => [...BASE.cube, ...perms(2, 0, 0)],
  d10: () => { const pts = [[0, 1.1, 0], [0, -1.1, 0]]; for (let i = 0; i < 10; i++) { const a = (i / 10) * Math.PI * 2; pts.push([Math.cos(a), i % 2 ? 0.105 : -0.105, Math.sin(a)]); } return pts; },
};
function polyhedron(o) {
  const pts = (SOLIDS[o.kind] || SOLIDS.truncicosa)().map(([x, y, z]) => new THREE.Vector3(x, y, z));
  let g = new ConvexGeometry(pts);
  // stand it on one of its faces: turn the first face to point straight down
  const p = g.attributes.position;
  const a = new THREE.Vector3().fromBufferAttribute(p, 0), b = new THREE.Vector3().fromBufferAttribute(p, 1), c = new THREE.Vector3().fromBufferAttribute(p, 2);
  const n = b.clone().sub(a).cross(c.clone().sub(a)).normalize();
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(n, new THREE.Vector3(0, -1, 0)));
  return g;
}
// knots: a tube that loops through itself (trefoil, cinquefoil...)
function knot(o) {
  const [pp, qq] = String(o.kind || "2,3").split(",").map(Number);
  return new THREE.TorusKnotGeometry(0.35, 0.35 * Math.min(60, Math.max(10, o.tube || 30)) / 100, 160, 16, pp, qq);
}
// a bumpy rock or asteroid: a ball pushed in and out by a pattern that depends on the seed number
function asteroid(o) {
  const g = new THREE.IcosahedronGeometry(0.5, 4);
  const k = Math.min(60, Math.max(0, o.bumps == null ? 25 : o.bumps)) / 100, seed = (o.seed || 1) * 12.9898;
  const p = g.attributes.position, v = new THREE.Vector3();
  const noise = (x, y, z) => Math.sin(x * 3.1 + seed) * Math.cos(y * 2.7 + seed * 1.3) + 0.6 * Math.sin(z * 5.3 + x * 2.1 + seed * 0.7) + 0.35 * Math.cos(y * 9.1 - z * 4.3 + seed * 2.1);
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i).normalize();
    const r = 0.5 * (1 + k * 0.45 * noise(v.x * 2, v.y * 2, v.z * 2));
    p.setXYZ(i, v.x * r, v.y * r, v.z * r);
  }
  return g;
}
// a beam or strip with a row of round holes (like construction-kit parts)
function beam(o) {
  const n = Math.max(1, Math.min(30, Math.round(o.holes || 5)));
  const sh = new THREE.Shape();
  sh.absarc(0.5, 0.5, 0.5, Math.PI / 2, Math.PI * 1.5, false);
  sh.lineTo(n - 0.5, 0); sh.absarc(n - 0.5, 0.5, 0.5, -Math.PI / 2, Math.PI / 2, false); sh.lineTo(0.5, 1);
  for (let i = 0; i < n; i++) { const h = new THREE.Path(); h.absarc(i + 0.5, 0.5, 0.25, 0, Math.PI * 2, true); sh.holes.push(h); }
  return raise(sh);
}
// a gear rack: a straight bar with teeth along the top (drawn side-on, made as deep as the shape)
function rack(o) {
  const n = Math.max(2, Math.min(60, Math.round(o.teeth || 10)));
  const pts = [[0, 0], [n, 0], [n, 0.55]];
  for (let i = n - 1; i >= 0; i--) pts.push([i + 0.85, 0.55], [i + 0.65, 1], [i + 0.35, 1], [i + 0.15, 0.55]);
  pts.push([0, 0.55]);
  return new THREE.ExtrudeGeometry(outline(pts), { depth: 1, bevelEnabled: false });
}
// a symmetrical wing section (NACA 4-digit formula), drawn side-on and made as long as the shape is deep
function airfoil(o) {
  const t = Math.min(40, Math.max(4, o.thick || 12)) / 100, N = 60, top = [], bottom = [];
  for (let i = 0; i <= N; i++) {
    const x = (1 - Math.cos((i / N) * Math.PI)) / 2;
    const y = 5 * t * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4);
    top.push([x, y]); bottom.push([x, -y]);
  }
  return new THREE.ExtrudeGeometry(outline([...top, ...bottom.reverse().slice(1, -1)]), { depth: 1, bevelEnabled: false });
}
// a straight marble-run channel: a block with a round groove along it (drawn end-on)
function channel(o) {
  const r = 0.5 * Math.min(90, Math.max(30, o.groove || 70)) / 100;
  const sh = new THREE.Shape();
  sh.moveTo(-0.5, 0); sh.lineTo(0.5, 0); sh.lineTo(0.5, 1); sh.lineTo(r, 1);
  sh.absarc(0, 1, r, 0, Math.PI, true);
  sh.lineTo(-0.5, 1); sh.closePath();
  return new THREE.ExtrudeGeometry(sh, { depth: 1, bevelEnabled: false, curveSegments: 32 });
}
// a slice of a doughnut
function donutSlice(o) {
  const a = THREE.MathUtils.degToRad(Math.min(359, Math.max(10, o.angle || 90)));
  return new THREE.TorusGeometry(0.35, 0.15, 24, 64, a).rotateX(-Math.PI / 2);
}

// a bumpy landscape tile: a grid of heights from a pattern that depends on the seed, with straight sides and a flat bottom
function terrain(o) {
  const N = 40, seed = (o.seed || 1) * 7.31, rough = Math.min(100, Math.max(0, o.rough == null ? 50 : o.rough)) / 100;
  const hAt = (u, v) => {
    const x = u * 6, z = v * 6;
    const n = Math.sin(x * 0.9 + seed) * Math.cos(z * 1.1 - seed * 0.7) + 0.5 * Math.sin(x * 2.3 - z * 1.7 + seed * 1.9) + 0.25 * rough * Math.cos(x * 5.1 + z * 4.3 + seed * 2.7) + 0.12 * rough * Math.sin(x * 9.7 - z * 8.9 + seed);
    return 0.25 + 0.75 * Math.min(1, Math.max(0, (n + 1.9) / 3.8));
  };
  const pos = [];
  const P = (i, j, top) => [i / N - 0.5, top ? hAt(i / N, j / N) : 0, j / N - 0.5];
  const tri = (a, b, c) => pos.push(...a, ...b, ...c);
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    tri(P(i, j, 1), P(i, j + 1, 1), P(i + 1, j, 1)); tri(P(i + 1, j, 1), P(i, j + 1, 1), P(i + 1, j + 1, 1)); // top, facing up
    tri(P(i, j, 0), P(i + 1, j, 0), P(i, j + 1, 0)); tri(P(i + 1, j, 0), P(i + 1, j + 1, 0), P(i, j + 1, 0)); // bottom, facing down
  }
  for (let k = 0; k < N; k++) { // the four sides
    tri(P(k, 0, 0), P(k, 0, 1), P(k + 1, 0, 1)); tri(P(k, 0, 0), P(k + 1, 0, 1), P(k + 1, 0, 0));
    tri(P(k, N, 0), P(k + 1, N, 1), P(k, N, 1)); tri(P(k, N, 0), P(k + 1, N, 0), P(k + 1, N, 1));
    tri(P(0, k, 0), P(0, k + 1, 1), P(0, k, 1)); tri(P(0, k, 0), P(0, k + 1, 0), P(0, k + 1, 1));
    tri(P(N, k, 0), P(N, k, 1), P(N, k + 1, 1)); tri(P(N, k, 0), P(N, k + 1, 1), P(N, k + 1, 0));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  return g;
}

// ---------- Photo relief: a plate whose height follows the shades of a picture ----------
// s.grid = { id, w, h, v } where v is base64 bytes, one per picture point: 0 = lowest, 255 = tallest.
const gridCache = new Map();
function gridBytes(g) {
  const key = g.id || g.v.slice(0, 64);
  if (!gridCache.has(key)) {
    const bin = atob(g.v), out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    if (gridCache.size > 20) gridCache.clear();
    gridCache.set(key, out);
  }
  return gridCache.get(key);
}
function relief(o) {
  const g = o.grid;
  if (!g || !g.w || !g.h || !g.v) return new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const W = g.w, H = g.h, data = gridBytes(g);
  const base = Math.min(95, Math.max(0, o.base == null ? 20 : o.base)) / 100;
  const levels = Math.max(0, Math.round(o.levels || 0));
  const hAt = (i, j) => {
    let t = data[Math.min(H - 1, Math.max(0, j)) * W + Math.min(W - 1, Math.max(0, i))] / 255;
    if (levels) t = Math.round(t * levels) / levels;
    return Math.max(0.01, base + (1 - base) * t);
  };
  const pos = [];
  const v3 = new THREE.Vector3(), w3 = new THREE.Vector3();
  // a four-cornered face, turned so it faces the given way
  const quad = (a, b, c, d, n) => {
    v3.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]); w3.set(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
    const flip = v3.cross(w3).dot(n) < 0;
    if (flip) pos.push(...a, ...c, ...b, ...a, ...d, ...c); else pos.push(...a, ...b, ...c, ...a, ...c, ...d);
  };
  const UP = new THREE.Vector3(0, 1, 0), DOWN = new THREE.Vector3(0, -1, 0);
  const XP = new THREE.Vector3(1, 0, 0), XN = new THREE.Vector3(-1, 0, 0), ZP = new THREE.Vector3(0, 0, 1), ZN = new THREE.Vector3(0, 0, -1);
  if (levels) {
    // steps: every picture point is a flat-topped column, like stacked layers
    const X = (i) => i / W - 0.5, Z = (j) => j / H - 0.5;
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const h = hAt(i, j);
      quad([X(i), h, Z(j)], [X(i + 1), h, Z(j)], [X(i + 1), h, Z(j + 1)], [X(i), h, Z(j + 1)], UP);
      quad([X(i), 0, Z(j)], [X(i + 1), 0, Z(j)], [X(i + 1), 0, Z(j + 1)], [X(i), 0, Z(j + 1)], DOWN);
      // walls towards the right and the front neighbour (or the outside)
      const hr = i + 1 < W ? hAt(i + 1, j) : 0;
      if (hr !== h) quad([X(i + 1), hr, Z(j)], [X(i + 1), h, Z(j)], [X(i + 1), h, Z(j + 1)], [X(i + 1), hr, Z(j + 1)], h > hr ? XP : XN);
      const hf = j + 1 < H ? hAt(i, j + 1) : 0;
      if (hf !== h) quad([X(i), hf, Z(j + 1)], [X(i), h, Z(j + 1)], [X(i + 1), h, Z(j + 1)], [X(i + 1), hf, Z(j + 1)], h > hf ? ZP : ZN);
      if (i === 0) quad([X(0), 0, Z(j)], [X(0), h, Z(j)], [X(0), h, Z(j + 1)], [X(0), 0, Z(j + 1)], XN);
      if (j === 0) quad([X(i), 0, Z(0)], [X(i), h, Z(0)], [X(i + 1), h, Z(0)], [X(i + 1), 0, Z(0)], ZN);
    }
  } else {
    // smooth: one point per picture point, joined into a gently sloping surface
    const X = (i) => i / Math.max(1, W - 1) - 0.5, Z = (j) => j / Math.max(1, H - 1) - 0.5;
    const T = (i, j) => [X(i), hAt(i, j), Z(j)], B = (i, j) => [X(i), 0, Z(j)];
    for (let j = 0; j < H - 1; j++) for (let i = 0; i < W - 1; i++) {
      pos.push(...T(i, j), ...T(i, j + 1), ...T(i + 1, j), ...T(i + 1, j), ...T(i, j + 1), ...T(i + 1, j + 1));
      pos.push(...B(i, j), ...B(i + 1, j), ...B(i, j + 1), ...B(i + 1, j), ...B(i + 1, j + 1), ...B(i, j + 1));
    }
    for (let i = 0; i < W - 1; i++) {
      quad(B(i, 0), T(i, 0), T(i + 1, 0), B(i + 1, 0), ZN);
      quad(B(i, H - 1), T(i, H - 1), T(i + 1, H - 1), B(i + 1, H - 1), ZP);
    }
    for (let j = 0; j < H - 1; j++) {
      quad(B(0, j), T(0, j), T(0, j + 1), B(0, j + 1), XN);
      quad(B(W - 1, j), T(W - 1, j), T(W - 1, j + 1), B(W - 1, j + 1), XP);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  // smooth reliefs share their corners so the light falls softly over the slopes
  return levels ? geo : mergeVertices(geo);
}

// A setting shown as a slider: key, label, unit, range and starting value
const P = (key, label, min, max, step, value, unit = "") => ({ key, label, min, max, step, value, unit });
const SIDES = (value = 64) => P("sides", "Sides", 3, 64, 1, value);

export const SHAPES = {
  box:      { label: "Box",      size: [20, 20, 20], color: "#e5352b", make: box, sized: (s) => s.radius > 0,
    params: [P("radius", "Corner radius", 0, 10, 0.5, 0, "mm"), P("steps", "Corner steps", 1, 10, 1, 4)] },
  cylinder: { label: "Cylinder", size: [20, 20, 20], color: "#f08a1c", make: cylinder, sized: (s) => s.bevel > 0,
    params: [SIDES(), P("bevel", "Bevel", 0, 10, 0.5, 0, "mm")] },
  sphere:   { label: "Sphere",   size: [20, 20, 20], color: "#1f8fe5", make: (s) => new THREE.SphereGeometry(0.5, s.steps * 2, s.steps),
    params: [P("steps", "Steps", 3, 36, 1, 24)] },
  cone:     { label: "Cone",     size: [20, 20, 20], color: "#8a4fd8", make: (s) => new THREE.CylinderGeometry((0.5 * s.top) / 100, 0.5, 1, s.sides),
    params: [P("top", "Top size", 0, 100, 1, 0, "%"), SIDES()] },
  pyramid:  { label: "Pyramid",  size: [20, 20, 20], color: "#f2c230", make: (s) => new THREE.ConeGeometry(Math.SQRT1_2, 1, s.sides).rotateY(Math.PI / s.sides),
    params: [P("sides", "Sides", 3, 20, 1, 4)] },
  roof:     { label: "Roof",     size: [20, 20, 20], color: "#2fa24a", make: roof },
  torus:    { label: "Torus",    size: [20, 20, 5],  color: "#16b6b0", make: torus,
    params: [P("tube", "Tube thickness", 5, 90, 1, 25, "%"), SIDES(), P("steps", "Steps", 3, 32, 1, 24)] },
  tube:     { label: "Tube",     size: [20, 20, 20], color: "#d4508f", make: tube,
    params: [P("wall", "Wall thickness", 2, 45, 1, 20, "%"), SIDES()] },
  star:     { label: "Star",     size: [20, 20, 5],  color: "#ffb400", make: star,
    params: [P("points", "Points", 3, 30, 1, 5), P("inner", "Inner size", 5, 95, 1, 40, "%")] },
  heart:    { label: "Heart",    size: [20, 20, 5],  color: "#e8306e", make: heart },
  halfsphere: { label: "Half sphere", size: [20, 20, 10], color: "#16b6b0", make: halfSphere, params: [P("steps", "Steps", 3, 36, 1, 24)] },
  wedge:    { label: "Wedge",    size: [20, 20, 20], color: "#f2c230", make: wedge },
  hexagon:  { label: "Hexagon",  size: [20, 20, 20], color: "#8a4fd8", make: () => new THREE.CylinderGeometry(0.5, 0.5, 1, 6) },
  diamond:  { label: "Diamond",  size: [20, 20, 24], color: "#1f8fe5", make: () => new THREE.OctahedronGeometry(0.5, 0) },
  text:     { label: "Text",     size: [36, 5, 10],  color: "#1f8fe5", make: () => new THREE.BoxGeometry(1, 1, 1),
    params: [{ key: "font", label: "Font", options: [["sans", "Sans"], ["serif", "Serif"], ["mono", "Typewriter"], ["script", "Handwriting"]], value: "sans" }] },
  roundroof: { label: "Round roof", size: [20, 20, 10], color: "#16b6b0", make: roundRoof, params: [SIDES(96)] },
  polygon:  { label: "Polygon",  size: [20, 20, 20], color: "#f08a1c", make: polygon, params: [P("sides", "Sides", 3, 64, 1, 5)] },
  paraboloid: { label: "Paraboloid", size: [20, 20, 20], color: "#8a4fd8", make: paraboloid, params: [SIDES()] },
  ring:     { label: "Ring",     size: [20, 20, 4],  color: "#e5352b", make: ring, params: [P("tube", "Tube thickness", 2, 45, 1, 16, "%"), SIDES()] },
  icosahedron: { label: "Icosahedron", size: [20, 20, 20], color: "#2fa24a", make: () => new THREE.IcosahedronGeometry(0.5, 0) },
  dodecahedron: { label: "Dodecahedron", size: [20, 20, 20], color: "#1f8fe5", make: () => new THREE.DodecahedronGeometry(0.5, 0) },
  roundedbox: { label: "Rounded box", size: [20, 20, 20], color: "#e5352b", make: roundedBox, sized: true,
    params: [P("radius", "Corner radius", 0.5, 50, 0.5, 3, "mm")] },
  gear:     { label: "Gear",     size: [30, 30, 6],  color: "#9aa0a8", make: gear, params: [P("teeth", "Teeth", 6, 80, 1, 16)] },
  spring:   { label: "Spring",   size: [20, 20, 30], color: "#9aa0a8", make: spring, params: [P("turns", "Turns", 1, 30, 1, 5)] },
  screw:    { label: "Screw",    size: [10, 10, 30], color: "#9aa0a8", make: screw,
    params: [P("threads", "Threads", 2, 80, 1, 12), P("depth", "Thread depth", 2, 40, 1, 15, "%")] },
  nut:      { label: "Nut",      size: [17, 15, 8],  color: "#9aa0a8", make: nut, params: [P("bore", "Hole size", 10, 85, 1, 58, "%")] },
  capsule:  { label: "Capsule",  size: [10, 10, 24], color: "#e8306e", make: capsule, params: [SIDES(48)] },
  bowl:     { label: "Bowl",     size: [30, 30, 15], color: "#16b6b0", make: bowl, params: [P("wall", "Wall thickness", 2, 45, 1, 12, "%"), SIDES()] },
  bipyramid: { label: "Bipyramid", size: [20, 20, 24], color: "#8a4fd8", make: bipyramid, params: [P("sides", "Sides", 3, 24, 1, 6)] },
  dovetail: { label: "Dovetail", size: [12, 20, 8],  color: "#9aa0a8", make: dovetail, params: [P("narrow", "Bottom width", 20, 95, 1, 60, "%")] },
  keyhole:  { label: "Keyhole",  size: [9, 18, 10],  color: "#9aa0a8", make: keyhole },
  braille:  { label: "Braille", size: [10.1, 10.2, 2.2], color: "#ffffff", make: braille, textKey: true },
  pie:      { label: "Circle slice", size: [20, 20, 4], color: "#16b6b0", make: pie,
    params: [P("angle", "Angle", 5, 359, 1, 45, "°"), P("inner", "Hollow middle", 0, 95, 1, 0, "%")] },
  frame:    { label: "Frame",    size: [40, 30, 4],  color: "#7a4a24", make: frame, params: [P("wall", "Frame width", 4, 90, 1, 20, "%")] },
  polyhedron: { label: "Polyhedron", size: [20, 20, 20], color: "#2fa24a", make: polyhedron, params: [{ key: "kind", label: "Kind", value: "truncicosa", options: [
    ["tetra", "Tetrahedron (D4)"], ["cube", "Cube (D6)"], ["octa", "Octahedron (D8)"], ["d10", "Ten-sided (D10)"], ["dodeca", "Dodecahedron (D12)"], ["icosa", "Icosahedron (D20)"],
    ["trunctetra", "Truncated tetrahedron"], ["trunccube", "Truncated cube"], ["truncocta", "Truncated octahedron"], ["truncicosa", "Truncated icosahedron (football)"],
    ["cubocta", "Cuboctahedron"], ["icosidodeca", "Icosidodecahedron"], ["rhombicubocta", "Rhombicuboctahedron"], ["rhombicdodeca", "Rhombic dodecahedron"]] }] },
  knot:     { label: "Knot", size: [24, 24, 10], color: "#8a4fd8", make: knot, params: [{ key: "kind", label: "Kind", value: "2,3", options: [["2,3", "Trefoil"], ["2,5", "Cinquefoil"], ["3,4", "3 × 4 knot"], ["3,5", "3 × 5 knot"], ["2,7", "Septafoil"]] },
    P("tube", "Thickness", 10, 60, 1, 30, "%")] },
  asteroid: { label: "Asteroid", size: [24, 22, 20], color: "#8a8f98", make: asteroid, params: [P("bumps", "Bumpiness", 0, 60, 1, 25, "%"), P("seed", "Pattern", 1, 99, 1, 1)] },
  beam:     { label: "Hole beam", size: [62.5, 12.5, 3.2], color: "#f2c230", make: beam, params: [P("holes", "Holes", 1, 30, 1, 5)] },
  rack:     { label: "Gear rack", size: [50, 5, 10], color: "#9aa0a8", make: rack, params: [P("teeth", "Teeth", 2, 60, 1, 10)] },
  airfoil:  { label: "Wing section", size: [40, 30, 6], color: "#c4c9d0", make: airfoil, params: [P("thick", "Thickness", 4, 40, 1, 12, "%")] },
  channel:  { label: "Marble channel", size: [20, 50, 12], color: "#e0a85a", make: channel, params: [P("groove", "Groove size", 30, 90, 1, 70, "%")] },
  donutslice: { label: "Donut slice", size: [30, 30, 9], color: "#e8306e", make: donutSlice, params: [P("angle", "Angle", 10, 359, 1, 90, "°")] },
  // a flat copy of a picture (the image itself is kept under s.image); only a guide, never exported
  picture:  { label: "Picture", size: [60, 60, 0.2], color: "#ffffff", make: () => new THREE.BoxGeometry(1, 1, 1),
    params: [P("fade", "See-through", 0, 90, 1, 0, "%")] },
  relief:   { label: "Photo relief", size: [60, 60, 4], color: "#f5f5f5", make: relief, drawn: true,
    params: [P("base", "Base plate", 0, 90, 1, 20, "%"), P("levels", "Height steps (0 = smooth)", 0, 20, 1, 0)] },
  terrain:  { label: "Terrain", size: [60, 60, 14], color: "#5c8f3a", make: terrain, params: [P("rough", "Roughness", 0, 100, 1, 50, "%"), P("seed", "Pattern", 1, 99, 1, 1)] },
  // Geometry
  tetrahedron: { label: "Tetrahedron", size: [20, 17.32, 16.33], color: "#f2c230", make: () => new THREE.ConeGeometry(0.5, 1, 3) },
  // Symbols
  arrow:    { label: "Arrow",    size: [30, 20, 5],  color: "#1f8fe5", make: arrow, params: [P("shaft", "Shaft thickness", 10, 90, 1, 40, "%")] },
  doublearrow: { label: "Double arrow", size: [40, 20, 5], color: "#16b6b0", make: doubleArrow, params: [P("shaft", "Shaft thickness", 10, 90, 1, 40, "%")] },
  check:    { label: "Check mark", size: [20, 16, 5], color: "#2fa24a", make: check },
  moon:     { label: "Moon",     size: [20, 20, 5],  color: "#f2c230", make: moon, params: [P("bite", "Bite size", 40, 95, 1, 85, "%")] },
  lightning: { label: "Lightning", size: [14, 22, 5], color: "#ffb400", make: lightning },
  speech:   { label: "Speech bubble", size: [24, 20, 5], color: "#ffffff", make: speech },
  drop:     { label: "Drop",     size: [14, 20, 5],  color: "#1f8fe5", make: drop },
  flower:   { label: "Flower",   size: [22, 22, 5],  color: "#e8306e", make: flower, params: [P("petals", "Petals", 3, 12, 1, 5)] },
  // Maths
  plus:     { label: "Plus",     size: [20, 20, 5],  color: "#e5352b", make: (o) => plusShape(o), params: [P("thick", "Thickness", 5, 90, 1, 30, "%")] },
  minus:    { label: "Minus",    size: [20, 6, 5],   color: "#1f8fe5", make: minusShape },
  times:    { label: "Times",    size: [20, 20, 5],  color: "#8a4fd8", make: (o) => plusShape(o, Math.PI / 4), params: [P("thick", "Thickness", 5, 90, 1, 30, "%")] },
  divide:   { label: "Divide",   size: [20, 20, 5],  color: "#f08a1c", make: divideShape },
  equals:   { label: "Equals",   size: [20, 14, 5],  color: "#2fa24a", make: equalsShape },
  // Connectors and hardware
  bolt:     { label: "Bolt",     size: [17, 17, 30], color: "#9aa0a8", make: bolt,
    params: [P("threads", "Threads", 2, 60, 1, 10), P("head", "Head height", 10, 50, 1, 22, "%")] },
  pin:      { label: "Peg",      size: [8, 8, 16],   color: "#9aa0a8", make: pin, params: [SIDES(48)] },
  bracket:  { label: "Bracket",  size: [20, 15, 20], color: "#9aa0a8", make: bracket, params: [P("thick", "Thickness", 5, 45, 1, 20, "%")] },
  hook:     { label: "Hook",     size: [15, 5, 30],  color: "#9aa0a8", make: hook },
  spun:     { label: "Spun shape", size: [30, 30, 30], color: "#16b6b0", make: spun, drawn: true, params: [SIDES(48)] },
  scribble: { label: "Scribble", size: [30, 30, 5],  color: "#e8306e", make: scribble, drawn: true,
    params: [P("taper", "Top size", 0, 200, 1, 100, "%"), P("twist", "Twist", -720, 720, 5, 0, "°")] },
  holebox:  { label: "Hole box", size: [20, 20, 20], color: "#9aa0a8", make: box, hole: true, sized: (s) => s.radius > 0,
    params: [P("radius", "Corner radius", 0, 10, 0.5, 0, "mm"), P("steps", "Corner steps", 1, 10, 1, 4)] },
  holecylinder: { label: "Hole cylinder", size: [20, 20, 20], color: "#9aa0a8", make: (s) => new THREE.CylinderGeometry(0.5, 0.5, 1, s.sides), hole: true, params: [SIDES()] },
};

// A shape's settings, with the starting value filled in for any that aren't set
export const paramsOf = (type) => (SHAPES[type] && SHAPES[type].params) || [];
export function withDefaults(type, s) {
  const out = { ...(s || {}) };
  for (const p of paramsOf(type)) if (out[p.key] == null) out[p.key] = p.value;
  return out;
}

const cache = new Map();
// One geometry per combination of settings (and per size for corners that keep their radius)
export function geometryFor(type, s) {
  const def = SHAPES[type];
  const full = withDefaults(type, s);
  let key = type + paramsOf(type).map((p) => "|" + full[p.key]).join("");
  if (def.drawn && s && s.path) key += "|" + JSON.stringify(s.path);
  if (def.drawn && s && s.loops) key += "|" + JSON.stringify(s.loops);
  if (s && s.grid) key += "|" + (s.grid.id || s.grid.v.slice(0, 64)) + "|" + s.grid.w + "x" + s.grid.h;
  if (def.textKey && s) key += "|" + (s.text || "");
  const sized = typeof def.sized === "function" ? def.sized(full) : def.sized;
  if (sized && s) key += `|${(+s.w).toFixed(1)}|${(+s.d).toFixed(1)}|${(+s.h).toFixed(1)}`;
  if (!cache.has(key)) {
    if (cache.size > 300) cache.clear(); // keep memory in check when resizing rounded shapes a lot
    cache.set(key, normalize(def.make(full)));
  }
  return cache.get(key);
}

// Little drawings for the shape buttons
export const ICONS = {
  box: '<path d="M8 15l14-7 14 7v16l-14 7-14-7z" fill="#e5352b"/><path d="M8 15l14 7 14-7M22 22v16" stroke="#9c1e16" stroke-width="1.5" fill="none"/>',
  cylinder: '<path d="M8 12v20a14 6 0 0 0 28 0V12z" fill="#f08a1c"/><ellipse cx="22" cy="12" rx="14" ry="6" fill="#ffb066"/>',
  sphere: '<circle cx="22" cy="22" r="15" fill="#1f8fe5"/><circle cx="17" cy="16" r="5" fill="#8fcaff"/>',
  cone: '<path d="M22 6L8 32a14 6 0 0 0 28 0z" fill="#8a4fd8"/><ellipse cx="22" cy="32" rx="14" ry="6" fill="#6a2fc4"/>',
  pyramid: '<path d="M22 6L6 30l16 8z" fill="#f2c230"/><path d="M22 6l16 24-16 8z" fill="#cf9c12"/>',
  roof: '<path d="M6 32L18 10l20 6-12 22z" fill="#2fa24a"/><path d="M18 10l20 6-12 22" fill="#1f7a36"/>',
  torus: '<ellipse cx="22" cy="22" rx="16" ry="9" fill="none" stroke="#16b6b0" stroke-width="7"/>',
  tube: '<path d="M8 12v20a14 6 0 0 0 28 0V12z" fill="#d4508f"/><ellipse cx="22" cy="12" rx="14" ry="6" fill="#f08ab8"/><ellipse cx="22" cy="12" rx="7" ry="3" fill="#8f2459"/>',
  star: '<path d="M22 5l4.5 11.5L38 17l-9 7.5 3 11.5-10-6.5L12 36l3-11.5L6 17l11.5-.5z" fill="#ffb400"/>',
  heart: '<path d="M22 37C10 28 6 22 6 16a8 8 0 0 1 16-2 8 8 0 0 1 16 2c0 6-4 12-16 21z" fill="#e8306e"/>',
  halfsphere: '<path d="M6 30a16 16 0 0 1 32 0z" fill="#16b6b0"/><ellipse cx="22" cy="30" rx="16" ry="4" fill="#0e8f8a"/><circle cx="16" cy="22" r="3" fill="#7ee6e1"/>',
  wedge: '<path d="M8 34V10l28 24z" fill="#f2c230"/><path d="M8 34l28 0 0 4H8z" fill="#cf9c12"/>',
  hexagon: '<path d="M14 8h16l8 14-8 14H14L6 22z" fill="#8a4fd8"/><path d="M14 8h16l8 14H6z" fill="#a876e8"/>',
  diamond: '<path d="M22 4l14 18-14 18L8 22z" fill="#1f8fe5"/><path d="M22 4l14 18H8z" fill="#7cc0ff"/>',
  text: '<path d="M7 8h30v8h-10v22h-10V16H7z" fill="#1f8fe5"/><path d="M27 16v22h-10l4-4h2V12h14v4z" fill="#0e5fb0"/>',
  roundroof: '<path d="M6 32a16 16 0 0 1 32 0z" fill="#16b6b0"/><path d="M6 32h32v4H6z" fill="#0e8f8a"/>',
  polygon: '<path d="M22 6l15 11-6 18H13L7 17z" fill="#f08a1c"/><path d="M22 6l15 11H7z" fill="#ffb066"/>',
  paraboloid: '<path d="M8 36C8 20 16 8 22 8s14 12 14 28z" fill="#8a4fd8"/><ellipse cx="22" cy="36" rx="14" ry="3" fill="#6a2fc4"/>',
  ring: '<ellipse cx="22" cy="24" rx="16" ry="8" fill="none" stroke="#e5352b" stroke-width="4"/>',
  icosahedron: '<path d="M22 4l15 9v18l-15 9-15-9V13z" fill="#2fa24a"/><path d="M22 4l7 15H15zM15 19h14l-7 21zM7 13l8 6-8 12zM37 13l-8 6 8 12z" fill="#5cc46f"/>',
  dodecahedron: '<path d="M22 4l16 11-6 20H12L6 15z" fill="#1f8fe5"/><path d="M22 12l9 6-3 10h-12l-3-10z" fill="#7cc0ff"/>',
  roundedbox: '<rect x="8" y="10" width="28" height="26" rx="7" fill="#e5352b"/><rect x="12" y="13" width="20" height="8" rx="4" fill="#ff7a70"/>',
  gear: '<circle cx="22" cy="22" r="12" fill="#9aa0a8"/><g fill="#9aa0a8"><rect x="19" y="4" width="6" height="8"/><rect x="19" y="32" width="6" height="8"/><rect x="4" y="19" width="8" height="6"/><rect x="32" y="19" width="8" height="6"/><rect x="8" y="8" width="6" height="6" transform="rotate(45 11 11)"/><rect x="30" y="8" width="6" height="6" transform="rotate(45 33 11)"/><rect x="8" y="30" width="6" height="6" transform="rotate(45 11 33)"/><rect x="30" y="30" width="6" height="6" transform="rotate(45 33 33)"/></g><circle cx="22" cy="22" r="4" fill="#fff"/>',
  screw: '<path d="M17 6h10v32H17z" fill="#b8bec6"/><path d="M15 10l14 3M15 15l14 3M15 20l14 3M15 25l14 3M15 30l14 3" stroke="#6b7280" stroke-width="2.5" stroke-linecap="round"/>',
  nut: '<path d="M14 8h16l8 14-8 14H14L6 22z" fill="#9aa0a8"/><circle cx="22" cy="22" r="7" fill="#fff" stroke="#6b7280" stroke-width="2"/>',
  spring: '<path d="M10 36c0-4 24-4 24-8s-24-4-24-8 24-4 24-8-24-4-24-8" fill="none" stroke="#6b7280" stroke-width="3.5" stroke-linecap="round"/>',
  capsule: '<rect x="14" y="4" width="16" height="36" rx="8" fill="#e8306e"/><rect x="18" y="8" width="4" height="12" rx="2" fill="#f58db0"/>',
  bowl: '<path d="M4 16h36a18 18 0 0 1-36 0z" fill="#16b6b0"/><ellipse cx="22" cy="16" rx="18" ry="5" fill="#0e8f8a"/><ellipse cx="22" cy="16" rx="14" ry="3.4" fill="#7ee6e1"/>',
  bipyramid: '<path d="M22 3l14 19-14 19L8 22z" fill="#8a4fd8"/><path d="M22 3l14 19H22z" fill="#a876e8"/><path d="M8 22h28l-14 19z" fill="#6a2fc4"/>',
  dovetail: '<path d="M14 36h16l6-26H8z" fill="#9aa0a8"/><path d="M8 10h28l-2 4H10z" fill="#c4c9d0"/>',
  keyhole: '<circle cx="22" cy="28" r="10" fill="#9aa0a8"/><rect x="17" y="6" width="10" height="22" rx="5" fill="#9aa0a8"/>',
  braille: '<rect x="4" y="12" width="36" height="22" rx="3" fill="#fff" stroke="#9aa0a8"/><g fill="#333"><circle cx="14" cy="18" r="2.6"/><circle cx="14" cy="24" r="2.6"/><circle cx="21" cy="18" r="2.6"/><circle cx="30" cy="18" r="2.6"/><circle cx="30" cy="30" r="2.6"/></g>',
  pie: '<path d="M22 40L6 9a34 34 0 0 1 32 0z" fill="#16b6b0"/><path d="M22 40L6 9a34 34 0 0 1 32 0" fill="none" stroke="#0e8f8a" stroke-width="1.5"/>',
  frame: '<path d="M4 8h36v28H4zM11 15v14h22V15z" fill="#7a4a24" fill-rule="evenodd"/>',
  polyhedron: '<path d="M22 4l8 4 6 8v12l-6 8-8 4-8-4-6-8V16l6-8z" fill="#2fa24a"/><path d="M22 14l6 4v7l-6 4-6-4v-7z" fill="#e8f5ea"/><path d="M22 4v10M30 8l-2 10M36 16l-8 2M36 28l-8-3M22 40V29M8 28l8-3M8 16l8 2M14 8l2 10" stroke="#1f7a36" stroke-width="1.3"/>',
  knot: '<path d="M22 6c8 0 10 10 4 16s-14 10-16 4 6-10 12-8 12 8 8 14-14 4-16-2S14 6 22 6z" fill="none" stroke="#8a4fd8" stroke-width="5" stroke-linejoin="round"/>',
  asteroid: '<path d="M10 14l8-7 10 2 8 6 2 10-5 9-11 4-9-4-5-9z" fill="#8a8f98"/><circle cx="18" cy="17" r="3" fill="#6b7280"/><circle cx="27" cy="26" r="4" fill="#6b7280"/><circle cx="15" cy="29" r="2" fill="#6b7280"/>',
  beam: '<rect x="2" y="15" width="40" height="14" rx="7" fill="#f2c230"/><g fill="#fff"><circle cx="9" cy="22" r="3.4"/><circle cx="17" cy="22" r="3.4"/><circle cx="25" cy="22" r="3.4"/><circle cx="33" cy="22" r="3.4"/></g>',
  rack: '<path d="M4 34h36V24h-2l-2-6h-3l-2 6h-3l-2-6h-3l-2 6h-3l-2-6h-3l-2 6h-3l-2-6H8l-2 6H4z" fill="#9aa0a8"/>',
  airfoil: '<path d="M4 23c4-9 18-10 36-2-18 3-32 4-36 2z" fill="#c4c9d0" stroke="#6b7280"/>',
  channel: '<path d="M6 14h32v24H6z" fill="#e0a85a"/><path d="M12 14a10 10 0 0 0 20 0z" fill="#a0683a"/>',
  donutslice: '<path d="M8 36A28 28 0 0 1 36 8v11a17 17 0 0 0-17 17z" fill="#e8306e"/>',
  picture: '<rect x="6" y="9" width="32" height="26" rx="2" fill="#fff" stroke="#6b7280" stroke-width="2"/><path d="M9 32l9-11 6 7 4-4 7 8z" fill="#2fa24a"/><circle cx="30" cy="16" r="3" fill="#ffb400"/>',
  relief: '<path d="M4 30h36v6H4z" fill="#cfd6de"/><path d="M4 30l5-8 4 4 6-12 5 9 4-5 5 6 7-3v9z" fill="#8a96a3"/>',
  terrain: '<path d="M3 34l8-12 6 6 8-14 7 9 9-5v16z" fill="#5c8f3a"/><path d="M3 34h38v5H3z" fill="#8a6a3a"/><path d="M25 14l-3 5 3-1 2 2z" fill="#fff"/>',
  tetrahedron: '<path d="M22 6L6 36h32z" fill="#f2c230"/><path d="M22 6l6 30h10z" fill="#cf9c12"/>',
  arrow: '<path d="M4 17h20V8l16 14-16 14v-9H4z" fill="#1f8fe5"/>',
  doublearrow: '<path d="M3 22l11-12v7h16v-7l11 12-11 12v-7H14v7z" fill="#16b6b0"/>',
  check: '<path d="M5 23l6-6 7 7L33 9l6 6-21 21z" fill="#2fa24a"/>',
  moon: '<circle cx="20" cy="22" r="16" fill="#f2c230"/><circle cx="29" cy="17" r="13" fill="#fff"/>',
  lightning: '<path d="M25 3L10 24h10l-5 17 19-24H23z" fill="#ffb400"/>',
  speech: '<path d="M22 6c10 0 18 6 18 13s-8 13-18 13c-2 0-4 0-6-1l-9 6 2-8c-3-3-5-6-5-10 0-7 8-13 18-13z" fill="#fff" stroke="#6b7280" stroke-width="2"/>',
  drop: '<path d="M22 4c6 10 12 16 12 23a12 12 0 0 1-24 0c0-7 6-13 12-23z" fill="#1f8fe5"/>',
  flower: '<g fill="#e8306e"><circle cx="22" cy="11" r="7"/><circle cx="32" cy="19" r="7"/><circle cx="28" cy="31" r="7"/><circle cx="16" cy="31" r="7"/><circle cx="12" cy="19" r="7"/></g><circle cx="22" cy="22" r="6" fill="#ffb400"/>',
  plus: '<path d="M17 6h10v11h11v10H27v11H17V27H6V17h11z" fill="#e5352b"/>',
  minus: '<path d="M6 17h32v10H6z" fill="#1f8fe5"/>',
  times: '<path d="M10 6l12 12 12-12 4 4-12 12 12 12-4 4-12-12-12 12-4-4 12-12L6 10z" fill="#8a4fd8"/>',
  divide: '<path d="M6 19h32v6H6z" fill="#f08a1c"/><circle cx="22" cy="11" r="4.5" fill="#f08a1c"/><circle cx="22" cy="33" r="4.5" fill="#f08a1c"/>',
  equals: '<path d="M6 12h32v8H6zM6 24h32v8H6z" fill="#2fa24a"/>',
  bolt: '<path d="M10 6h24l3 5-3 5H10l-3-5z" fill="#9aa0a8"/><path d="M17 16h10v23H17z" fill="#b8bec6"/><path d="M16 20l12 3M16 25l12 3M16 30l12 3" stroke="#6b7280" stroke-width="2.2" stroke-linecap="round"/>',
  pin: '<path d="M14 38V14a8 8 0 0 1 16 0v24z" fill="#b8bec6"/><path d="M10 34h24v5H10z" fill="#9aa0a8"/>',
  bracket: '<path d="M8 6h8v24h22v8H8z" fill="#9aa0a8"/><path d="M16 30h22v2H16z" fill="#6b7280"/>',
  hook: '<path d="M17 4h7v24a5 5 0 0 0 10 0v-5h6v5a11.5 11.5 0 0 1-23 0z" fill="#9aa0a8"/>',
  spun: '<path d="M16 6h12c0 6-6 9-6 15 0 6 12 7 12 13a4 4 0 0 1-4 4H12a4 4 0 0 1-4-4c0-6 12-7 12-13 0-6-6-9-6-15z" fill="#16b6b0"/><path d="M22 2v40" stroke="#0e5f5b" stroke-width="1.5" stroke-dasharray="3 2"/>',
  scribble: '<path d="M8 30c2-12 8-20 16-18s4 10 10 8 4 10-6 12-14 6-20-2z" fill="#e8306e"/><path d="M30 6l6 6-14 14-7 1 1-7z" fill="#fbbf24" stroke="#92400e"/>',
  holebox: '<defs><pattern id="hp1" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="5" height="5" fill="#d6dae0"/><rect width="2.5" height="5" fill="#9aa0a8"/></pattern></defs><path d="M8 15l14-7 14 7v16l-14 7-14-7z" fill="url(#hp1)" stroke="#6b7280"/>',
  holecylinder: '<defs><pattern id="hp2" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="5" height="5" fill="#d6dae0"/><rect width="2.5" height="5" fill="#9aa0a8"/></pattern></defs><path d="M8 12v20a14 6 0 0 0 28 0V12z" fill="url(#hp2)" stroke="#6b7280"/><ellipse cx="22" cy="12" rx="14" ry="6" fill="#e5e7eb" stroke="#6b7280"/>',
};

export const PALETTE = ["#e5352b", "#f08a1c", "#f2c230", "#2fa24a", "#16b6b0", "#1f8fe5", "#8a4fd8", "#e8306e", "#7a4a24", "#ffffff", "#9aa0a8", "#333333"];
