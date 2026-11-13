import * as THREE from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { SVGLoader } from "three/examples/jsm/loaders/SVGLoader.js";
import { normalize } from "./shapes.js";

// Imported models (STL files). The shape only stores a short id; the model data is kept once
// on this computer under that id, and inside saved design files so they stay portable.
const PREFIX = "shapeforge-mesh-";
const MAX_TRIANGLES = 80000;
const geos = new Map();

function toBase64(floats) {
  const bytes = new Uint8Array(floats.buffer, floats.byteOffset, floats.byteLength);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromBase64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}
async function idFor(b64) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(b64));
  return [...new Uint8Array(digest)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function geometryFromData(b64) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(fromBase64(b64), 3));
  g.computeVertexNormals();
  return normalize(g);
}

// Read an STL file; returns { id, size: {w, d, h} } in millimetres, or throws a friendly error
export async function importSTL(arrayBuffer) {
  let g = new STLLoader().parse(arrayBuffer);
  if (g.index) g = g.toNonIndexed();
  const triangles = g.attributes.position.count / 3;
  if (!triangles) throw new Error("That file has no shape in it.");
  if (triangles > MAX_TRIANGLES) throw new Error(`That model is very detailed (${triangles.toLocaleString()} triangles). FiddleCraft can import models up to ${MAX_TRIANGLES.toLocaleString()} triangles.`);
  g.rotateX(-Math.PI / 2); // STL files are Z-up; the workplane is Y-up
  return keep(g);
}

// Store a finished model and hand back its id and size in millimetres
async function keep(g) {
  g.computeBoundingBox();
  const size = new THREE.Vector3();
  g.boundingBox.getSize(size);
  const pos = new Float32Array(g.attributes.position.array);
  const b64 = toBase64(pos);
  const id = await idFor(b64);
  storeMesh(id, b64);
  geos.set(id, geometryFromData(b64));
  return { id, size: { w: +size.x.toFixed(2), d: +size.z.toFixed(2), h: +size.y.toFixed(2) } };
}

// Read an SVG drawing: every filled shape is raised 10 mm off the workplane (holes inside letters stay open)
export async function importSVG(text) {
  let data;
  try { data = new SVGLoader().parse(text); } catch { throw new Error("That SVG file couldn't be read."); }
  const outlines = [];
  for (const path of data.paths) {
    const style = path.userData && path.userData.style;
    if (style && style.display === "none") continue;
    for (const sh of SVGLoader.createShapes(path)) outlines.push(sh);
  }
  if (!outlines.length) throw new Error("That SVG file has no closed shapes to raise. Try a drawing with filled shapes.");
  let g = new THREE.ExtrudeGeometry(outlines, { depth: 10, bevelEnabled: false, curveSegments: 12 });
  if (g.index) g = g.toNonIndexed();
  const triangles = g.attributes.position.count / 3;
  if (triangles > MAX_TRIANGLES) throw new Error(`That drawing is very detailed (${triangles.toLocaleString()} triangles). Try a simpler SVG.`);
  // drawing units are pixels (96 per inch); keep that size unless it is tiny or huge
  g.computeBoundingBox();
  const size = new THREE.Vector3();
  g.boundingBox.getSize(size);
  // a drawing that says its real size (width in mm, cm or inches, like laser-cutter files) keeps it
  const real = drawingScale(text);
  let k = real ? real.k : 25.4 / 96;
  const longest = Math.max(size.x, size.y) * k;
  const fits = real && real.physical ? longest >= 1 && longest <= 1000 : longest >= 10 && longest <= 180;
  if (!fits) k = 80 / Math.max(size.x, size.y);
  g.scale(k, k, 1);
  g.rotateX(Math.PI / 2); // the drawing lies on the workplane, its top edge at the back, raised upwards
  g.translate(0, 10, 0);
  return keep(g);
}

// Millimetres per drawing unit, from the drawing's width and viewBox (null if it doesn't say)
function drawingScale(text) {
  try {
    const svg = new DOMParser().parseFromString(text, "image/svg+xml").documentElement;
    const m = /^\s*([\d.]+)\s*(mm|cm|in|pt|px)?\s*$/.exec(svg.getAttribute("width") || "");
    if (!m) return null;
    const per = { mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, px: 25.4 / 96 }[m[2] || "px"];
    const vb = (svg.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
    const units = vb.length === 4 && vb[2] > 0 ? vb[2] : parseFloat(m[1]);
    const k = (parseFloat(m[1]) * per) / units;
    return Number.isFinite(k) && k > 0 ? { k, physical: ["mm", "cm", "in"].includes(m[2]) } : null;
  } catch { return null; }
}

export function storeMesh(id, b64) {
  try { localStorage.setItem(PREFIX + id, b64); }
  catch { throw new Error("There isn't enough room on this computer's app storage to keep that model. Try a simpler model."); }
}
export const meshData = (id) => localStorage.getItem(PREFIX + id);

export function importedGeometry(id) {
  if (!id) return null;
  if (!geos.has(id)) {
    const b64 = meshData(id);
    if (!b64) return null;
    geos.set(id, geometryFromData(b64));
  }
  return geos.get(id);
}

// Every model id used by a list of shapes, including inside groups
export function meshIds(list, out = new Set()) {
  for (const s of list) {
    if (s.type === "mesh" && s.mesh) out.add(s.mesh);
    if (s.type === "picture" && s.image) out.add(s.image); // pictures keep their image the same way
    if (s.type === "group" && Array.isArray(s.children)) meshIds(s.children, out);
  }
  return out;
}
