import * as THREE from "three";
import { Brush, Evaluator, ADDITION, SUBTRACTION } from "three-bvh-csg";
import { geometryFor, normalize } from "./shapes.js";
import { textGeometry, isFontReady } from "./text.js";
import { importedGeometry } from "./imported.js";

// Solid shapes are joined together, then every "hole" shape is cut out of them.
const evaluator = new Evaluator();
evaluator.useGroups = false;
evaluator.attributes = ["position", "normal"];
// Multicolour groups carry each part's colour through the cut-and-join step
const colourEvaluator = new Evaluator();
colourEvaluator.useGroups = false;
colourEvaluator.attributes = ["position", "normal", "color"];
const plain = new THREE.MeshBasicMaterial();
const deg = THREE.MathUtils.degToRad;
const groupCache = new Map();

function baseGeometry(s) {
  if (s.type === "group") return groupGeometry(s);
  if (s.type === "text") return textGeometry(s.text, s.font) || geometryFor("text"); // a box until the font has loaded
  if (s.type === "mesh") return importedGeometry(s.mesh) || geometryFor("box"); // a box if the model data is missing
  return geometryFor(s.type, s);
}

// Mirror: flip the shape inside its own box (left-right, upside down or front-back)
const mirrorCache = new WeakMap();
function mirrored(base, fx, fy, fz) {
  let byFlags = mirrorCache.get(base);
  if (!byFlags) mirrorCache.set(base, (byFlags = new Map()));
  const key = `${fx}${fy}${fz}`;
  if (!byFlags.has(key)) {
    const g = base.index ? base.toNonIndexed() : base.clone();
    g.scale(fx, fy, fz);
    if (fy < 0) g.translate(0, 1, 0); // keep it sitting on the workplane
    if (fx * fy * fz < 0) {
      // an odd number of flips turns faces inside out: put the corners back in order
      for (const name of ["position", "color"]) {
        const pos = g.attributes[name];
        if (!pos) continue;
        for (let i = 0; i < pos.count; i += 3) {
          for (let k = 0; k < pos.itemSize; k++) {
            const a = pos.getComponent(i + 1, k);
            pos.setComponent(i + 1, k, pos.getComponent(i + 2, k));
            pos.setComponent(i + 2, k, a);
          }
        }
        pos.needsUpdate = true;
      }
    }
    g.computeVertexNormals();
    byFlags.set(key, g);
  }
  return byFlags.get(key);
}

export function shapeGeometry(s) {
  const base = baseGeometry(s);
  const fx = s.fx || 1, fy = s.fy || 1, fz = s.fz || 1;
  return fx === 1 && fy === 1 && fz === 1 ? base : mirrored(base, fx, fy, fz);
}

function prep(geo) {
  const g = geo.index ? geo.toNonIndexed() : geo.clone();
  for (const k of Object.keys(g.attributes)) if (k !== "position" && k !== "normal") g.deleteAttribute(k);
  g.clearGroups();
  return g;
}

// Pieces whose faces lie exactly on top of each other (same height, flush sides, a hole flush with
// a base) make the joining maths very slow or stuck. Each piece is grown by a different tiny amount
// (thousandths of a millimetre, far below what a printer can show) so no two faces line up exactly.
const nudge = (i) => (i ? 0.0015 * (1 + (i % 40)) + 0.0003 * Math.floor(i / 40) : 0); // the first piece keeps its exact size
function place(b, s, i) {
  const e = nudge(i);
  b.scale.set(s.w + e, s.h + 2 * e, s.d + e);
  // move the base down along the piece's own "up", so tilted or rolled pieces are nudged too
  const up = new THREE.Vector3(0, 1, 0).applyEuler(new THREE.Euler(deg(s.t || 0), deg(s.r || 0), deg(s.l || 0), "YXZ"));
  b.position.set(s.x - up.x * e, s.y - up.y * e, s.z - up.z * e);
}
function brushFor(s, i = 0) {
  const b = new Brush(prep(shapeGeometry(s)), plain);
  place(b, s, i);
  b.rotation.set(deg(s.t || 0), deg(s.r || 0), deg(s.l || 0), "YXZ");
  b.updateMatrixWorld();
  return b;
}

// Returns one geometry in world space (millimetres), or null when there is nothing solid.
export function combine(list) {
  const solids = list.filter((s) => !s.hole);
  const holes = list.filter((s) => s.hole);
  if (!solids.length) return null;
  let n = 0;
  let acc = brushFor(solids[0], n++);
  for (const s of solids.slice(1)) acc = evaluator.evaluate(acc, brushFor(s, n++), ADDITION);
  for (const s of holes) acc = evaluator.evaluate(acc, brushFor(s, n++), SUBTRACTION);
  acc.updateMatrixWorld();
  const g = acc.geometry.clone();
  g.applyMatrix4(acc.matrixWorld);
  return g;
}

// A shape with a colour on every corner: its own colour, or the parts' colours for a multicolour group
function colouredPrep(s, fallback) {
  const src = shapeGeometry(s);
  const g = src.index ? src.toNonIndexed() : src.clone();
  const keep = s.type === "group" && s.multicolor && g.attributes.color;
  for (const k of Object.keys(g.attributes)) if (k !== "position" && k !== "normal" && !(keep && k === "color")) g.deleteAttribute(k);
  g.clearGroups();
  if (!keep) {
    const c = new THREE.Color(s.hole ? fallback : s.color);
    const arr = new Float32Array(g.attributes.position.count * 3);
    for (let i = 0; i < arr.length; i += 3) { arr[i] = c.r; arr[i + 1] = c.g; arr[i + 2] = c.b; }
    g.setAttribute("color", new THREE.BufferAttribute(arr, 3));
  }
  return g;
}
function colouredBrush(s, fallback, i = 0) {
  const b = new Brush(colouredPrep(s, fallback), plain);
  place(b, s, i);
  b.rotation.set(deg(s.t || 0), deg(s.r || 0), deg(s.l || 0), "YXZ");
  b.updateMatrixWorld();
  return b;
}
// Like combine(), but every part keeps its colour (cut walls take the colour of the part they cut)
export function combineColoured(list) {
  const solids = list.filter((s) => !s.hole);
  const holes = list.filter((s) => s.hole);
  if (!solids.length) return null;
  let n = 0;
  let acc = colouredBrush(solids[0], undefined, n++);
  for (const s of solids.slice(1)) acc = colourEvaluator.evaluate(acc, colouredBrush(s, undefined, n++), ADDITION);
  for (const s of holes) acc = colourEvaluator.evaluate(acc, colouredBrush(s, solids[0].color, n++), SUBTRACTION);
  acc.updateMatrixWorld();
  const g = acc.geometry.clone();
  g.applyMatrix4(acc.matrixWorld);
  return g;
}

function groupGeometry(s) {
  const key = (s.multicolor ? "multi:" : "") + JSON.stringify(s.children);
  if (!groupCache.has(key)) {
    const g = s.multicolor ? combineColoured(s.children) : combine(s.children);
    const geo = g ? normalize(g) : normalize(new THREE.BoxGeometry(1, 1, 1));
    if (!isFontReady() && key.includes('"type":"text"')) return geo; // build again once the letters are ready
    groupCache.set(key, geo);
  }
  return groupCache.get(key);
}
