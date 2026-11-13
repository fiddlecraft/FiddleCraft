import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";
import { SHAPES, ICONS, PALETTE, paramsOf, brailleCells, brailleSize, trueProportions } from "./shapes.js";
import { shapeGeometry, combine, combineColoured } from "./csg.js";
import { fontReady, onFontLoaded, textAspect } from "./text.js";
import { importSTL, importSVG, storeMesh, meshData, meshIds } from "./imported.js";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { createViewCube } from "./viewcube.js";
import { createRuler } from "./ruler.js";
import { createSizeTags } from "./sizetags.js";
import { createThumbs } from "./thumbs.js";
import { units, BRICK, BRICK_UP, BRICK_HINT } from "./units.js";
import { findThinSpots, isWorthWarning, make3MF, sealedGeometry } from "./printcheck.js";
import { outlinesFromMask, normalizeLoops, maskFromImage, autoThreshold } from "./trace.js";
import { sliceOutlines, outlinesToSVG } from "./svgexport.js";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";

const $ = (s) => document.querySelector(s);
const STORE = "shapeforge-design-v1";
// Workplane size in mm (can be changed to match a 3D printer's bed; kept on this computer)
const PLANE_KEY = "shapeforge-workplane";
let planeW = 200, planeD = 200;
try { const wp = JSON.parse(localStorage.getItem(PLANE_KEY) || "null"); if (wp && wp.w > 0 && wp.d > 0) { planeW = wp.w; planeD = wp.d; } } catch { /* keep the default */ }
const demo = new URLSearchParams(location.search).has("demo");
if (demo) document.body.classList.add("demo");

// ---------- Scene ----------
const host = $("#viewport");
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
host.prepend(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, 1, 1, 5000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI - 0.01; // you can look up from under the workplane
controls.minDistance = 40;
controls.maxDistance = 1200;
controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };

// Flat view (like an orthographic camera): look from very far away through a very narrow lens,
// so shapes keep the same size however far back they are. Everything else works the same.
const FLAT = 25;
const FOV = 40, FLAT_FOV = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(FOV / 2)) / FLAT));
let flatView = false;
const viewScale = () => (flatView ? FLAT : 1);
function setFlatView(on) {
  if (on === flatView) return;
  const k = on ? FLAT : 1 / FLAT;
  flatView = on;
  if (flight) { camera.position.copy(flight.to); controls.target.copy(flight.tTo); flight = null; }
  camera.position.sub(controls.target).multiplyScalar(k).add(controls.target);
  camera.fov = on ? FLAT_FOV : FOV;
  camera.near = on ? 20 : 1;
  camera.far = on ? 5000 * FLAT : 5000;
  camera.updateProjectionMatrix();
  controls.minDistance = 40 * viewScale();
  controls.maxDistance = 1200 * viewScale();
  controls.update();
  const b = document.querySelector("#flat-view");
  if (b) { b.setAttribute("aria-pressed", String(on)); b.textContent = on ? "3D" : "Flat"; b.title = on ? "Back to the normal 3D view (O)" : "Flat view: no perspective, sizes don't shrink with distance (O)"; }
  try { localStorage.setItem("shapeforge-flat-view", on ? "1" : "0"); } catch { /* storage full */ }
}
function homeView() {
  camera.position.set(120, 125, 165).multiplyScalar(viewScale());
  controls.target.set(0, 0, 0);
  controls.update();
}
homeView();

// ---------- Camera views: smooth moves to home, top, front, side, and fit ----------
let flight = null;
let flightTimer = 0;
function flyTo(pos, target) {
  flight = { from: camera.position.clone(), to: pos, tFrom: controls.target.clone(), tTo: target, start: performance.now() };
  // if the window isn't drawing (minimised or busy), still finish the move
  clearTimeout(flightTimer);
  flightTimer = setTimeout(() => {
    if (!flight) return;
    camera.position.copy(flight.to);
    controls.target.copy(flight.tTo);
    flight = null;
    controls.update();
  }, 500);
}
function stepFlight() {
  if (!flight) return;
  const k = Math.min(1, (performance.now() - flight.start) / 350);
  const e = k * k * (3 - 2 * k); // ease in and out
  camera.position.lerpVectors(flight.from, flight.to, e);
  controls.target.lerpVectors(flight.tFrom, flight.tTo, e);
  if (k >= 1) flight = null;
}
function setView(name) {
  const target = controls.target.clone();
  const dist = Math.max(80 * viewScale(), camera.position.distanceTo(target));
  const dirs = { top: [0, 1, 0.0001], front: [0, 0, 1], side: [1, 0, 0] };
  if (name === "home") return flyTo(new THREE.Vector3(120, 125, 165).multiplyScalar(viewScale()), new THREE.Vector3(0, 0, 0));
  if (name === "fit") return fitView();
  const d = new THREE.Vector3(...dirs[name]).normalize().multiplyScalar(dist);
  flyTo(target.clone().add(d), target);
}
// Zoom so the selected shapes (or every shape) fill the view
function fitView() {
  const list = picked.size ? shapes.filter((s) => picked.has(s.id)) : shapes;
  const box = new THREE.Box3();
  list.forEach((s) => { const m = meshes.get(s.id); if (m) { m.updateMatrixWorld(); box.union(new THREE.Box3().setFromObject(m)); } });
  if (box.isEmpty()) box.set(new THREE.Vector3(-planeW / 2, 0, -planeD / 2), new THREE.Vector3(planeW / 2, 20, planeD / 2));
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(10, box.getSize(new THREE.Vector3()).length() / 2);
  const dist = radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.1;
  const dir = camera.position.clone().sub(controls.target).normalize();
  flyTo(center.clone().add(dir.multiplyScalar(dist)), center);
}


scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(120, 260, 160);
scene.add(sun);
// Shadows come from their own light (it adds no brightness), placed so shapes cast a soft shadow
// out towards the front-right, where it shows from the usual viewing angle
const shadowLight = new THREE.DirectionalLight(0xffffff, 0);
shadowLight.position.set(-70, 320, -90);
shadowLight.shadow.mapSize.set(2048, 2048);
shadowLight.shadow.bias = -0.0005;
shadowLight.shadow.radius = 4;
scene.add(shadowLight);
scene.add(shadowLight.target);
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const shadowCatcher = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.ShadowMaterial({ opacity: 0.22 }));
shadowCatcher.position.y = 0.02;
shadowCatcher.receiveShadow = true;
scene.add(shadowCatcher);

// Blue workplane with a 1 cm grid and 5 mm fine lines
const workplane = new THREE.Group();
scene.add(workplane);
function gridLines(w, d, step, color, y) {
  const pts = [];
  for (let x = -w / 2; x <= w / 2 + 1e-6; x += step) pts.push(x, y, -d / 2, x, y, d / 2);
  for (let z = -d / 2; z <= d / 2 + 1e-6; z += step) pts.push(-w / 2, y, z, w / 2, y, z);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color }));
}
function buildWorkplane() {
  workplane.children.slice().forEach((c) => { workplane.remove(c); c.geometry.dispose(); c.material.dispose(); });
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(planeW, planeD), new THREE.MeshBasicMaterial({ color: 0xdcebfb, side: THREE.DoubleSide }));
  plane.rotation.x = -Math.PI / 2;
  plane.position.y = -0.05;
  workplane.add(plane);
  const inch = units.get() === "in"; // inches: quarter-inch squares with a darker line every inch
  workplane.add(gridLines(planeW, planeD, inch ? 25.4 / 4 : 5, 0xb4d2f2, -0.03));
  workplane.add(gridLines(planeW, planeD, inch ? 25.4 : 10, 0x5a9be0, -0.02));
  const border = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(planeW, 0, planeD)), new THREE.LineBasicMaterial({ color: 0x0175da }));
  workplane.add(border);
  // the two sets of grid lines can be hidden from Workspace settings
  workplane.children[1].userData.grid = workplane.children[2].userData.grid = true;
  if (typeof workspace !== "undefined") workplane.children.forEach((c) => { if (c.userData.grid) c.visible = workspace.grid; });
  // the shadow-catching plane and the sun's shadow box follow the workplane size
  const big = Math.max(planeW, planeD) * 1.6 + 200;
  shadowCatcher.scale.set(big, 1, big);
  const cam = shadowLight.shadow.camera;
  cam.left = cam.bottom = -big / 2; cam.right = cam.top = big / 2; cam.near = 1; cam.far = 1200;
  cam.updateProjectionMatrix();
}
buildWorkplane();

const box = new THREE.Box3();
const selBox = new THREE.Box3Helper(box, 0x0175da);
selBox.visible = false;
scene.add(selBox);

// ---------- Model ----------
let shapes = []; // { id, type, name, color, hole, w, d, h, x, y, z, r, t }
const meshes = new Map();
let selected = null;
let picked = new Set(); // every selected shape (Shift+click adds more); `selected` is the main one
let tempPlane = null; // { point, normal } of the temporary workplane, or null for the main one
let placingPlane = false;
let aligning = null; // { key, bounds, hover, preview } while the align dots are showing
let dirty = false; // true when the design changed since it was last saved to a file
// Hide/lock icons (defined early: the shape list uses them while a saved design loads at start-up)
const EYE = '<svg viewBox="0 0 24 24"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg>';
const EYE_OFF = '<svg viewBox="0 0 24 24"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M4 4l16 16" stroke="currentColor" stroke-width="2"/></svg>';
const LOCK = '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2" fill="currentColor"/><path d="M8 11V8a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
const UNLOCK = '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 11V8a4 4 0 0 1 7.5-2" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
let nextId = 1;
const undoStack = [];
const redoStack = [];

const solidMat = (color) => new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.05 });
const holeMat = new THREE.MeshStandardMaterial({ color: 0x8a9099, transparent: true, opacity: 0.45, roughness: 0.8, depthWrite: false });

function snapshot() { return JSON.stringify({ shapes, nextId }); }
function commit() {
  dirty = true;
  undoStack.push(lastState);
  if (undoStack.length > 100) undoStack.shift();
  redoStack.length = 0;
  lastState = snapshot();
  save();
  updateButtons();
}
let lastState = snapshot();

function restore(json) {
  const s = JSON.parse(json);
  shapes = s.shapes;
  nextId = s.nextId;
  meshes.forEach((m) => scene.remove(m));
  meshes.clear();
  shapes.forEach(buildMesh);
  if (selected && !shapes.find((s) => s.id === selected)) selected = null;
  picked = new Set([...picked].filter((id) => shapes.some((s) => s.id === id)));
  if (selected) picked.add(selected);
  lastState = json;
  refresh();
  save();
}

// Pictures: the image on the top and bottom faces, plain edges, true colours (not lit)
const pictureTextures = new Map();
const isPicture = (s) => s && s.type === "picture";
function pictureMaterials(s) {
  let tex = pictureTextures.get(s.image);
  if (tex === undefined) {
    const url = meshData(s.image);
    tex = url ? new THREE.TextureLoader().load(url, () => { if (typeof wake === "function") wake(600); }) : null;
    if (tex) { tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4; }
    pictureTextures.set(s.image, tex);
  }
  const face = new THREE.MeshBasicMaterial({ map: tex, color: tex ? 0xffffff : 0xe5e7eb, transparent: true, alphaTest: 0.02 });
  const edge = new THREE.MeshBasicMaterial({ color: 0xc9ced6, transparent: true });
  return [edge, edge, face, face, edge, edge];
}
function buildMesh(s) {
  const m = new THREE.Mesh(shapeGeometry(s), isPicture(s) ? pictureMaterials(s) : s.hole ? holeMat : solidMat(s.color));
  m.castShadow = !s.hole && !isPicture(s);
  m.userData.id = s.id;
  meshes.set(s.id, m);
  scene.add(m);
  syncMesh(s);
}

function syncMesh(s) {
  const m = meshes.get(s.id);
  m.geometry = shapeGeometry(s);
  const multi = !s.hole && s.type === "group" && !!s.multicolor;
  if (isPicture(s)) {
    const o = 1 - Math.min(90, Math.max(0, s.fade || 0)) / 100;
    for (const mat of new Set(m.material)) { mat.opacity = o; mat.depthWrite = o >= 1; }
    m.renderOrder = o < 1 ? 2 : 0;
  } else if (s.hole) m.material = holeMat;
  else if (m.material === holeMat || !!m.material.vertexColors !== multi) { m.material = solidMat(s.color); m.material.vertexColors = multi; }
  if (!s.hole && !isPicture(s)) {
    m.material.color.set(multi ? "#ffffff" : s.color); // a multicolour group shows its parts' own colours
    // See-through: only changes how it looks here; exported files are solid as usual
    const clear = !!s.clear;
    if (m.material.transparent !== clear) { m.material.transparent = clear; m.material.depthWrite = !clear; m.material.needsUpdate = true; }
    m.material.opacity = clear ? 0.4 : 1;
    m.renderOrder = clear ? 2 : 0;
  }
  m.scale.set(s.w, s.h, s.d);
  m.position.set(s.x, s.y, s.z);
  m.rotation.set(THREE.MathUtils.degToRad(s.t || 0), THREE.MathUtils.degToRad(s.r), THREE.MathUtils.degToRad(s.l || 0), "YXZ");
  m.visible = !s.hidden;
}

const get = (id) => shapes.find((s) => s.id === id);
const snapStep = () => Number($("#snap").value);
const snap = (v) => { const st = snapStep(); return st ? Math.round(Math.round(v / st) * st * 1000) / 1000 : Math.round(v * 100) / 100; };
// up-and-down step: the same as sideways, except Brick, which goes up one plate (3.2 mm) at a time
const isBrick = () => snapStep() === BRICK;
const snapStepUp = () => (isBrick() ? BRICK_UP : snapStep());
const snapUp = (v) => { const st = snapStepUp(); return st ? Math.round(Math.round(v / st) * st * 1000) / 1000 : Math.round(v * 100) / 100; };
const say = (msg) => { $("#announce").textContent = msg; };

// ---------- Find a shape ----------
// extra words people might search for
const SHAPE_WORDS = {
  box: "cube square block", cylinder: "tube round disc", sphere: "ball round globe", cone: "point round",
  pyramid: "point triangle", roof: "triangle prism", torus: "donut doughnut ring round", tube: "pipe ring hollow round",
  star: "", heart: "love", halfsphere: "dome round bowl", wedge: "ramp slope triangle", hexagon: "nut prism",
  diamond: "gem octahedron", text: "letters words name label", roundroof: "arch half cylinder round", polygon: "sides prism hexagon octagon",
  paraboloid: "bullet dome round", ring: "loop round washer", icosahedron: "dice d20 gem", dodecahedron: "dice d12 gem",
  roundedbox: "rounded cube block soft", gear: "cog teeth wheel", holebox: "hole cut", holecylinder: "hole cut round drill",
  spring: "coil helix", scribble: "draw freehand sketch custom",
  spun: "revolve revolver lathe vase bowl cup spin turned profile draw round",
  screw: "bolt thread threaded rod", nut: "bolt hex hexagon thread washer",
  tetrahedron: "triangle pyramid d4 dice", arrow: "pointer direction sign", doublearrow: "both ways sign", check: "tick yes done",
  moon: "crescent night", lightning: "flash bolt thunder energy", speech: "talk chat comic bubble", drop: "water tear rain",
  flower: "petals daisy", plus: "add cross math", minus: "subtract dash math", times: "multiply x cross math",
  divide: "division math", equals: "equal math", bolt: "screw hex head thread hardware", pin: "peg dowel connector",
  bracket: "angle corner l shelf", hook: "hanger j",
  capsule: "pill rounded cylinder", bowl: "dish cup hollow half sphere", bipyramid: "double pyramid gem crystal",
  dovetail: "joint slide wood", keyhole: "hanger wall screw mount",
  braille: "blind tactile dots read accessible sign", pie: "pizza wedge sector slice quarter", frame: "picture window border outline rectangle",
};
function filterShapes() {
  const q = $("#shape-search").value.trim().toLowerCase();
  let shown = 0;
  const cat =$("#shape-cat").value;
  const seen = new Set();
  shapeButtons.querySelectorAll(".shape-btn").forEach((b) => {
    const item = CATALOG_BY_KEY[b.dataset.key];
    const inCat = cat === "all" || b.closest(".shapes__section").dataset.cat === cat;
    // a search looks through every category (each shape listed once); otherwise show the chosen category
    const match = q ? q.split(/\s+/).every((w) => item.words.includes(w)) && !seen.has(item.key) : inCat;
    b.hidden = !match;
    if (match) { shown++; seen.add(item.key); }
  });
  $("#shape-none").hidden = shown > 0;
  // hide sections with nothing left in them; headings only help when more than one category shows
  shapeButtons.querySelectorAll(".shapes__section").forEach((sec) => { sec.hidden = !sec.querySelector(".shape-btn:not([hidden])"); });
  const many = [...shapeButtons.querySelectorAll(".shapes__section")].filter((sec) => !sec.hidden).length > 1;
  shapeButtons.querySelectorAll(".shapes__cat").forEach((h) => { h.hidden = !many; });
}
$("#shape-search").addEventListener("input", filterShapes);
$("#shape-search").addEventListener("keydown", (e) => {
  if (e.key === "Escape") { e.target.value = ""; filterShapes(); e.target.blur(); }
  if (e.key === "Enter") { const first = shapeButtons.querySelector(".shape-btn:not([hidden])"); if (first) first.click(); }
});

// ---------- Scribble: draw an outline by hand and turn it into a 3D shape ----------
let scribblePts = []; // Spun shape: the one profile line
let strokes = []; // Scribble: every stroke drawn, { pts, width, closed }
let scribbleMode = "flat"; // "flat": an outline seen from above; "spin": a side profile turned around an axis
const SPIN_AXIS = 120; // where the axis sits on the drawing area (pixels from the left)
const SCRIBBLE_MM = 0.2; // one pixel of the drawing area is 0.2 mm, so the whole area is 72 × 60 mm
function openScribble(mode = "flat") {
  scribbleMode = mode;
  scribblePts = [];
  strokes = [];
  $("#scribble-title").textContent = mode === "spin" ? "Spun shape" : "Scribble";
  $("#scribble-note").textContent = mode === "spin"
    ? "Draw half of the shape's side, to the right of the dashed line. It is spun around that line into a round shape, like a vase or a bowl. Parts left of the line are ignored."
    : "Draw with the mouse. Lines become solid lines; a loop that ends where it started is filled in. Draw as many strokes as you like.";
  $("#scribble-pen-row").hidden = mode === "spin";
  $("#scribble-undo").hidden = mode === "spin";
  drawScribble();
  $("#scribble-dialog").showModal();
}
// a stroke that ends near where it began is a filled loop
const strokeClosed = (pts, width) => pts.length > 6 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) <= Math.max(16, width * 1.5)
  && pts.reduce((sum, p, i) => sum + (i ? Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0), 0) > 40;
// draws the strokes exactly as they will be made (used for the screen and for tracing)
function paintStrokes(g, list, scale, fill, line) {
  g.save();
  g.scale(scale, scale);
  g.lineCap = "round"; g.lineJoin = "round";
  for (const s of list) {
    g.lineWidth = s.width;
    g.strokeStyle = line; g.fillStyle = fill;
    g.beginPath();
    if (s.pts.length === 1) { g.arc(s.pts[0][0], s.pts[0][1], s.width / 2, 0, Math.PI * 2); g.fillStyle = line; g.fill(); continue; }
    g.moveTo(s.pts[0][0], s.pts[0][1]);
    s.pts.forEach(([x, y]) => g.lineTo(x, y));
    if (s.closed) { g.closePath(); g.fill(); }
    g.stroke();
  }
  g.restore();
}
function drawScribble() {
  const c = $("#scribble-canvas"), g = c.getContext("2d");
  g.clearRect(0, 0, c.width, c.height);
  g.strokeStyle = "#dbe3ee"; g.lineWidth = 1;
  for (let i = 20; i < c.width; i += 20) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, c.height); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(c.width, i); g.stroke(); }
  if (scribbleMode === "flat") {
    paintStrokes(g, strokes.map((s) => ({ ...s, closed: s.closed || (s.live && strokeClosed(s.pts, s.width)) })), 1, "rgba(232,48,110,.35)", "#e8306e");
    return;
  }
  const spin = scribbleMode === "spin";
  if (spin) {
    g.save(); g.setLineDash([6, 5]); g.strokeStyle = "#0e5f5b"; g.lineWidth = 2;
    g.beginPath(); g.moveTo(SPIN_AXIS, 0); g.lineTo(SPIN_AXIS, c.height); g.stroke(); g.restore();
  }
  if (!scribblePts.length) return;
  const pts = spin ? scribblePts.map(([x, y]) => [Math.max(SPIN_AXIS, x), y]) : scribblePts;
  const trace = (list) => { g.beginPath(); g.moveTo(list[0][0], list[0][1]); list.forEach(([x, y]) => g.lineTo(x, y)); g.closePath(); };
  if (spin) { // a faint mirror image shows the other half of the finished shape
    trace(pts.map(([x, y]) => [2 * SPIN_AXIS - x, y]));
    g.fillStyle = "rgba(22,182,176,.12)"; g.fill();
  }
  trace(pts);
  g.fillStyle = spin ? "rgba(22,182,176,.3)" : "rgba(232,48,110,.25)"; g.fill();
  g.strokeStyle = spin ? "#16b6b0" : "#e8306e"; g.lineWidth = 3; g.stroke();
}
(() => {
  const c = $("#scribble-canvas");
  let drawing = false;
  const at = (e) => { const r = c.getBoundingClientRect(); return [(e.clientX - r.left) * (c.width / r.width), (e.clientY - r.top) * (c.height / r.height)]; };
  const pen = () => Number($("#scribble-pen").value);
  $("#scribble-pen").addEventListener("input", () => { $("#scribble-pen-mm").textContent = units.text(pen() * SCRIBBLE_MM); });
  c.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    drawing = true;
    if (scribbleMode === "flat") strokes.push({ pts: [at(e)], width: pen(), live: true });
    else scribblePts = [at(e)];
    try { c.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    drawScribble();
  });
  c.addEventListener("pointermove", (e) => {
    if (!drawing) return;
    const list = scribbleMode === "flat" ? strokes[strokes.length - 1].pts : scribblePts;
    const p = at(e), last = list[list.length - 1];
    if (Math.hypot(p[0] - last[0], p[1] - last[1]) >= 3) { list.push(p); drawScribble(); }
  });
  const finish = () => {
    if (!drawing) return;
    drawing = false;
    const s = strokes[strokes.length - 1];
    if (scribbleMode === "flat" && s && s.live) { s.closed = strokeClosed(s.pts, s.width); delete s.live; }
    drawScribble();
  };
  c.addEventListener("pointerup", finish);
  c.addEventListener("pointercancel", finish);
  $("#scribble-undo").addEventListener("click", () => { strokes.pop(); drawScribble(); });
  $("#scribble-clear").addEventListener("click", () => { scribblePts = []; strokes = []; drawScribble(); });
  $("#scribble-done").addEventListener("click", (e) => {
    e.preventDefault();
    if (scribbleMode === "flat") {
      if (!strokes.length) { alert("Draw something first: hold the mouse button down and draw."); return; }
      // paint the strokes twice as fine as on screen and trace their outline
      const S = 2, W = c.width * S, H = c.height * S;
      const work = document.createElement("canvas");
      work.width = W; work.height = H;
      const g = work.getContext("2d", { willReadFrequently: true });
      g.fillStyle = "#fff"; g.fillRect(0, 0, W, H);
      paintStrokes(g, strokes, S, "#000", "#000");
      const px = g.getImageData(0, 0, W, H).data;
      const mask = new Uint8Array(W * H);
      for (let i = 0; i < W * H; i++) mask[i] = px[i * 4] < 128 ? 1 : 0;
      const loops = outlinesFromMask(mask, W, H, { eps: 1.2, rounds: 1, minArea: 8 });
      if (!loops.length) { alert("That drawing is too small to make a shape. Try drawing bigger or with a thicker line."); return; }
      const n = normalizeLoops(loops);
      const mm = (v) => Math.max(1, Math.round((v / S) * SCRIBBLE_MM * 10) / 10);
      addShape("scribble", null, { loops: n.loops, w: mm(n.spanX), d: mm(n.spanY) });
      $("#scribble-dialog").close();
      return;
    }
    if (scribblePts.length < 3) { alert("Draw a shape first: hold the mouse button down and draw an outline."); return; }
    if (scribbleMode === "spin") {
      const pts = scribblePts.map(([x, y]) => [Math.max(0, x - SPIN_AXIS), y]);
      const maxR = Math.max(...pts.map((p) => p[0])), minY = Math.min(...pts.map((p) => p[1])), maxY = Math.max(...pts.map((p) => p[1]));
      if (maxR < 4 || maxY - minY < 4) { alert("Draw to the right of the dashed line: that side is spun round into the shape."); return; }
      const path = pts.map(([r, y]) => [Math.round((r / maxR) * 1000) / 1000, Math.round((1 - (y - minY) / (maxY - minY)) * 1000) / 1000]);
      const k = 40 / Math.max(2 * maxR, maxY - minY);
      const across = Math.max(2, Math.round(2 * maxR * k));
      addShape("spun", null, { path, w: across, d: across, h: Math.max(2, Math.round((maxY - minY) * k)) });
      $("#scribble-dialog").close();
    }
  });
})();

// ---------- Photos (PNG, JPG...): a flat outline of the dark parts, or shaded heights ----------
const PICTURE_TYPES = /\.(png|jpe?g|gif|webp|bmp)$/i;
const RELIEF_MAX = 150; // points along the longest side of a photo relief: plenty for printing, still quick
let picture = null; // { img: ImageData (outline work, up to 400 px), small: ImageData (heights), name, at }
const photoMode = () => ($("#photo-mode-relief").checked ? "relief" : $("#photo-mode-picture").checked ? "picture" : "flat");
function pictureOutlines() {
  const { img } = picture;
  const mask = maskFromImage(img, Number($("#picture-cut").value), $("#picture-invert").checked);
  return outlinesFromMask(mask, img.width, img.height, { eps: 1, rounds: 1, minArea: 4 });
}
// the photo's shades as heights from 0 to 255, stretched so the darkest and lightest parts use the full range
function reliefHeights() {
  const { data, width: W, height: H } = picture.small;
  const lightUp = $("#relief-light").checked;
  const vals = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const a = data[i * 4 + 3] / 255;
    const lum = (0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]) * a + 255 * (1 - a);
    vals[i] = lightUp ? lum : 255 - lum;
  }
  const sorted = Array.from(vals).sort((p, q) => p - q);
  const lo = sorted[Math.floor(sorted.length * 0.01)], hi = sorted[Math.ceil(sorted.length * 0.99) - 1];
  const span = Math.max(1, hi - lo);
  const out = new Uint8Array(W * H);
  const levels = Number($("#relief-levels").value);
  for (let i = 0; i < W * H; i++) {
    let t = Math.min(1, Math.max(0, (vals[i] - lo) / span));
    if (levels) t = Math.round(t * levels) / levels;
    out[i] = Math.round(t * 255);
  }
  return { W, H, out };
}
function drawPicturePreview() {
  const c = $("#picture-canvas"), g = c.getContext("2d");
  const relief = photoMode() === "relief", asPicture = photoMode() === "picture";
  $("#flat-opts").hidden = relief || asPicture;
  $("#relief-opts").hidden = !relief;
  const lv = Number($("#relief-levels").value);
  $("#relief-levels-text").textContent = lv ? `${lv} steps` : "Smooth";
  const img = relief ? picture.small : picture.img;
  g.clearRect(0, 0, c.width, c.height);
  const k = Math.min(c.width / img.width, c.height / img.height);
  const ox = (c.width - img.width * k) / 2, oy = (c.height - img.height * k) / 2;
  if (relief) {
    // a lit-from-the-top-left picture of the heights, so you can see the bumps
    const { W, H, out } = reliefHeights();
    const shade = new ImageData(W, H);
    const at = (x, y) => out[Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))] / 255;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const dx = at(x + 1, y) - at(x - 1, y), dy = at(x, y + 1) - at(x, y - 1);
      const light = Math.min(1, Math.max(0, 0.62 - dx * 2.2 - dy * 2.2 + at(x, y) * 0.25));
      const v = Math.round(70 + light * 185), i = (y * W + x) * 4;
      shade.data[i] = v; shade.data[i + 1] = v; shade.data[i + 2] = v; shade.data[i + 3] = 255;
    }
    const tmp = document.createElement("canvas"); tmp.width = W; tmp.height = H;
    tmp.getContext("2d").putImageData(shade, 0, 0);
    g.imageSmoothingEnabled = lv === 0;
    g.drawImage(tmp, ox, oy, W * k, H * k);
    return;
  }
  // the picture, faint, under the outline it makes (or just the picture)
  const tmp = document.createElement("canvas"); tmp.width = img.width; tmp.height = img.height;
  tmp.getContext("2d").putImageData(img, 0, 0);
  if (asPicture) { g.drawImage(tmp, ox, oy, img.width * k, img.height * k); return; }
  g.globalAlpha = 0.3; g.drawImage(tmp, ox, oy, img.width * k, img.height * k); g.globalAlpha = 1;
  const path = new Path2D();
  for (const l of pictureOutlines()) { l.forEach(([x, y], i) => (i ? path.lineTo(ox + x * k, oy + y * k) : path.moveTo(ox + x * k, oy + y * k))); path.closePath(); }
  g.fillStyle = "rgba(232,48,110,.6)"; g.fill(path, "evenodd");
  g.strokeStyle = "#e8306e"; g.lineWidth = 1; g.stroke(path);
}
const scaled = (bmp, max) => {
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const W = Math.max(2, Math.round(bmp.width * k)), H = Math.max(2, Math.round(bmp.height * k));
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(bmp, 0, 0, W, H);
  return g.getImageData(0, 0, W, H);
};
async function openPicture(file, at) {
  let bmp;
  try { bmp = await createImageBitmap(file); } catch { alert("That picture couldn't be opened. FiddleCraft reads PNG, JPG, GIF, WebP and BMP pictures."); return; }
  picture = { img: scaled(bmp, 400), small: scaled(bmp, RELIEF_MAX), bmp, name: file.name.replace(PICTURE_TYPES, "") || "Photo", at };
  $("#picture-cut").value = String(autoThreshold(picture.img));
  $("#picture-invert").checked = false;
  $("#picture-size").value = String(Math.round(units.show(60) * 100) / 100);
  $("#relief-base").value = String(Math.round(units.show(1) * 100) / 100);
  $("#relief-top").value = String(Math.round(units.show(4) * 100) / 100);
  drawPicturePreview();
  $("#picture-dialog").showModal();
}
["#picture-cut", "#relief-levels"].forEach((id) => $(id).addEventListener("input", () => picture && drawPicturePreview()));
["#picture-invert", "#relief-light", "#photo-mode-flat", "#photo-mode-relief", "#photo-mode-picture"].forEach((id) => $(id).addEventListener("change", () => picture && drawPicturePreview()));
$("#relief-litho").addEventListener("click", () => {
  $("#photo-mode-relief").checked = true;
  $("#relief-light").checked = false; // dark parts thick, so they let less light through
  $("#relief-levels").value = "0";
  $("#relief-base").value = String(Math.round(units.show(0.8) * 100) / 100);
  $("#relief-top").value = String(Math.round(units.show(3) * 100) / 100);
  $("#picture-size").value = String(Math.round(units.show(100) * 100) / 100);
  picture.litho = true;
  drawPicturePreview();
  say("Lithophane settings: 0.8 mm thin parts, 3 mm thick parts, 100 mm wide. Print it upright in white.");
});
function bytesToBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(s);
}
$("#picture-done").addEventListener("click", (e) => {
  e.preventDefault();
  if (!picture) return;
  const longest = Math.max(1, units.read(Number($("#picture-size").value) || 60));
  const r1 = (v) => Math.max(0.5, Math.round(v * 10) / 10);
  if (photoMode() === "picture") {
    // the picture itself, no more than 1000 pixels across so design files stay a sensible size
    const { bmp } = picture;
    const k = Math.min(1, 1000 / Math.max(bmp.width, bmp.height));
    const W = Math.max(1, Math.round(bmp.width * k)), H = Math.max(1, Math.round(bmp.height * k));
    const c = document.createElement("canvas"); c.width = W; c.height = H;
    const g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(bmp, 0, 0, W, H);
    const px = g.getImageData(0, 0, W, H).data;
    let seeThrough = false;
    for (let i = 3; i < px.length; i += 4) if (px[i] < 250) { seeThrough = true; break; }
    const url = seeThrough ? c.toDataURL("image/png") : c.toDataURL("image/jpeg", 0.85); // keeps see-through parts
    const id = `pic-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    try { storeMesh(id, url); } catch (err) { alert(err.message.replace("model", "picture")); return; }
    const kk = longest / Math.max(W, H);
    addShape("picture", picture.at || null, { image: id, w: r1(W * kk), d: r1(H * kk), h: 0.2, name: picture.name, color: "#ffffff" });
    say(`${picture.name} added as a picture. Stretch, turn or tilt it like any shape; it is left out when you export.`);
  } else if (photoMode() === "relief") {
    const { W, H, out } = reliefHeights();
    const base = Math.max(0, units.read(Number($("#relief-base").value) || 0));
    const top = Math.max(base + 0.2, units.read(Number($("#relief-top").value) || 4));
    const k = longest / Math.max(W, H);
    addShape("relief", picture.at || null, {
      grid: { id: `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, w: W, h: H, v: bytesToBase64(out) },
      base: Math.round((base / top) * 100), levels: Number($("#relief-levels").value),
      w: r1(W * k), d: r1(H * k), h: r1(top), name: picture.name, color: picture.litho ? "#ffffff" : "#d9dde3",
    });
  } else {
    const loops = pictureOutlines();
    if (!loops.length) { alert("No shape found. Move the slider, or tick “Use the light parts instead”."); return; }
    const n = normalizeLoops(loops);
    const k = longest / Math.max(n.spanX, n.spanY);
    addShape("scribble", picture.at || null, { loops: n.loops, w: r1(n.spanX * k), d: r1(n.spanY * k), h: 3, name: picture.name, color: "#2e86de" });
  }
  $("#picture-dialog").close();
  picture = null;
});

function addShape(type, at, extra) {
  const def = SHAPES[type];
  const count = shapes.filter((s) => s.type === type).length + 1;
  const n = shapes.length;
  const spot = { x: -45 + (n % 4) * 30, z: -30 + (Math.floor(n / 4) % 3) * 30 };
  const s = {
    id: nextId++, type, name: `${def.label} ${count}`, color: def.color, hole: false,
    w: def.size[0], d: def.size[1], h: def.size[2],
    x: snap(at ? at.x : spot.x), y: 0, z: snap(at ? at.z : spot.z), r: 0, t: 0,
  };
  if (at && at.surface) Object.assign(s, at.surface);
  else if (!at && tempPlane) Object.assign(s, onTempPlane());
  if (type === "text") s.text = "Text";
  if (def.hole) s.hole = true;
  for (const p of paramsOf(type)) s[p.key] = p.value;
  if (extra) Object.assign(s, extra);
  trueProportions(s); // dice and regular solids keep their true shape
  shapes.push(s);
  buildMesh(s);
  select(s.id);
  commit();
  say(`${s.name} added.`);
}

const pickedShapes = () => shapes.filter((s) => picked.has(s.id));

function removeSelected() {
  const gone = pickedShapes();
  if (!gone.length) return;
  gone.forEach((s) => { scene.remove(meshes.get(s.id)); meshes.delete(s.id); });
  shapes = shapes.filter((x) => !picked.has(x.id));
  selected = null;
  picked = new Set();
  commit();
  refresh();
  say(gone.length === 1 ? `${gone[0].name} removed.` : `${gone.length} shapes removed.`);
}

// ---------- Import STL models ----------
async function importFile(file, at) {
  if (PICTURE_TYPES.test(file.name) || /^image\/(png|jpeg|gif|webp|bmp)$/.test(file.type)) return openPicture(file, at);
  try {
    const svg = /\.svg$/i.test(file.name);
    const { id, size } = svg ? await importSVG(await file.text()) : await importSTL(await file.arrayBuffer());
    const n = shapes.length;
    const s = {
      id: nextId++, type: "mesh", mesh: id, name: file.name.replace(/\.(stl|svg)$/i, "") || (svg ? "Imported drawing" : "Imported model"),
      color: svg ? "#2e86de" : "#9b59d0", hole: false, w: size.w, d: size.d, h: size.h,
      x: snap(at ? at.x : -45 + (n % 4) * 30), y: 0, z: snap(at ? at.z : -30 + (Math.floor(n / 4) % 3) * 30), r: 0, t: 0,
    };
    shapes.push(s);
    buildMesh(s);
    select(s.id);
    commit();
    say(`${s.name} imported (${s.w} × ${s.d} × ${s.h} mm).`);
  } catch (err) {
    alert(err.message || "That file couldn't be imported. FiddleCraft reads STL models, SVG drawings and PNG or JPG pictures.");
  }
}
const stlPicker = document.createElement("input");
stlPicker.type = "file";
stlPicker.accept = ".stl,.svg,.png,.jpg,.jpeg,.gif,.webp,.bmp,model/stl,image/svg+xml,image/png,image/jpeg";
// "Import photo" in the shapes panel: pictures and SVG drawings only
const drawingPicker = document.createElement("input");
drawingPicker.type = "file";
drawingPicker.accept = ".png,.jpg,.jpeg,.gif,.webp,.bmp,.svg,image/png,image/jpeg,image/gif,image/webp,image/bmp,image/svg+xml";
drawingPicker.addEventListener("change", () => {
  const f = drawingPicker.files[0];
  drawingPicker.value = "";
  if (f) importFile(f);
});
stlPicker.addEventListener("change", () => {
  const f = stlPicker.files[0];
  stlPicker.value = "";
  if (f) importFile(f);
});
$("#import-stl").addEventListener("click", () => stlPicker.click());

// ---------- Cut, copy and paste (inside FiddleCraft) ----------
let clipboard = null;
let pasteCount = 0;
function copySelection(cut) {
  const list = pickedShapes();
  if (!list.length) { say("Select a shape first."); return; }
  clipboard = JSON.parse(JSON.stringify(list));
  pasteCount = 0;
  if (cut) removeSelected();
  say(`${list.length === 1 ? list[0].name : list.length + " shapes"} ${cut ? "cut" : "copied"}. Press Ctrl+V to paste.`);
}
// ---------- My shapes: a personal library kept on this computer ----------
const LIBRARY = "shapeforge-library";
const readLibrary = () => { try { return JSON.parse(localStorage.getItem(LIBRARY) || "[]"); } catch { return []; } };
function writeLibrary(list) {
  try { localStorage.setItem(LIBRARY, JSON.stringify(list)); }
  catch { alert("There isn't enough room to keep that in My shapes."); }
}
// A small "type a name" dialog (the desktop app has no built-in prompt box)
function askName(title, value) {
  return new Promise((done) => {
    const dlg = $("#name-dialog");
    $("#name-title").textContent = title;
    $("#name-input").value = value || "";
    let answered = false;
    const finish = (v) => { if (answered) return; answered = true; done(v); };
    // answer as soon as a button is pressed (or Enter); closing with Esc means Cancel
    $("#name-form").onsubmit = (e) => finish(e.submitter && e.submitter.value === "cancel" ? null : $("#name-input").value);
    dlg.onclose = () => finish(dlg.returnValue === "ok" ? $("#name-input").value : null);
    dlg.returnValue = "";
    dlg.showModal();
    $("#name-input").select();
  });
}
async function saveToLibrary() {
  const list = pickedShapes();
  if (!list.length) { say("Select the shapes to keep first."); return; }
  const suggested = list.length === 1 ? list[0].name : "My shape";
  const name = ((await askName("Name it for My shapes", suggested)) || "").trim();
  if (!name) return;
  const cx = list.reduce((a, s) => a + s.x, 0) / list.length;
  const cz = list.reduce((a, s) => a + s.z, 0) / list.length;
  const parts = JSON.parse(JSON.stringify(list)).map((s) => ({ ...s, x: s.x - cx, z: s.z - cz, locked: false, hidden: false }));
  const lib = readLibrary();
  lib.push({ id: Date.now(), name, parts });
  writeLibrary(lib);
  renderLibrary();
  say(`${name} saved to My shapes.`);
}
function useLibraryItem(item, at) {
  const n = shapes.length;
  const spot = at || { x: -45 + (n % 4) * 30, z: -30 + (Math.floor(n / 4) % 3) * 30 };
  const placed = item.parts.map((p) => ({ ...JSON.parse(JSON.stringify(p)), id: nextId++, x: snap(spot.x + p.x), z: snap(spot.z + p.z) }));
  placed.forEach((s) => { shapes.push(s); buildMesh(s); });
  picked = new Set(placed.map((s) => s.id));
  selected = placed[placed.length - 1].id;
  refresh();
  commit();
  say(`${item.name} added.`);
}
function renderLibrary() {
  const box = $("#library");
  const lib = readLibrary();
  box.innerHTML = "";
  if (!lib.length) {
    box.innerHTML = '<p class="empty">Select shapes and press “Save to My shapes” to keep them here.</p>';
    return;
  }
  lib.forEach((item) => {
    const row = document.createElement("div");
    row.className = "library__row";
    const use = document.createElement("button");
    use.type = "button";
    use.className = "library__use";
    use.textContent = item.name;
    use.title = `Add ${item.name} to the design`;
    use.draggable = true;
    use.addEventListener("click", () => useLibraryItem(item));
    use.addEventListener("dragstart", (e) => e.dataTransfer.setData("text/library", String(item.id)));
    const del = document.createElement("button");
    del.type = "button";
    del.className = "rowicon";
    del.setAttribute("aria-label", `Remove ${item.name} from My shapes`);
    del.title = "Remove from My shapes";
    del.textContent = "×";
    del.addEventListener("click", () => {
      if (!confirm(`Remove “${item.name}” from My shapes?`)) return;
      writeLibrary(readLibrary().filter((x) => x.id !== item.id));
      renderLibrary();
    });
    row.append(use, del);
    box.append(row);
  });
}
$("#save-to-library").addEventListener("click", saveToLibrary);
renderLibrary();

function pasteClipboard() {
  if (!clipboard || !clipboard.length) { say("Nothing to paste yet. Copy a shape with Ctrl+C first."); return; }
  pasteCount += 1;
  const shift = 10 * pasteCount;
  const pasted = clipboard.map((o) => ({ ...JSON.parse(JSON.stringify(o)), id: nextId++, x: o.x + shift, z: o.z + shift }));
  pasted.forEach((s) => { shapes.push(s); buildMesh(s); });
  picked = new Set(pasted.map((s) => s.id));
  selected = pasted[pasted.length - 1].id;
  refresh();
  commit();
  say(`${pasted.length === 1 ? pasted[0].name : pasted.length + " shapes"} pasted.`);
}

// Duplicate and repeat: after copying, move or turn the copy; each further Ctrl+D repeats that same step
let lastDuplicate = null; // { from: {id: {x,y,z,r}} of the shapes copied, copies: [ids] }
function duplicateSelected() {
  const src = pickedShapes();
  if (!src.length) return;
  const ids = src.map((s) => s.id);
  const repeating = lastDuplicate && ids.length === lastDuplicate.copies.length && ids.every((id) => lastDuplicate.copies.includes(id));
  const copies = src.map((o) => {
    const c = { ...JSON.parse(JSON.stringify(o)), id: nextId++, name: o.name.replace(/( copy)*( \d+)?$/, "") + " copy" };
    if (repeating) {
      const f = lastDuplicate.from[lastDuplicate.copies.indexOf(o.id)];
      c.x = snap(o.x + (o.x - f.x)); c.y = snapUp(o.y + (o.y - f.y)); c.z = snap(o.z + (o.z - f.z));
      c.r = (((o.r || 0) + ((o.r || 0) - (f.r || 0))) % 360 + 540) % 360 - 180;
    } else { c.x = o.x + 10; c.z = o.z + 10; }
    return c;
  });
  lastDuplicate = { from: src.map((o) => ({ x: o.x, y: o.y, z: o.z, r: o.r || 0 })), copies: copies.map((c) => c.id) };
  copies.forEach((s) => { shapes.push(s); buildMesh(s); });
  picked = new Set(copies.map((s) => s.id));
  selected = copies[copies.length - 1].id;
  refresh();
  commit();
  say((copies.length === 1 ? `${copies[0].name} made.` : `${copies.length} copies made.`) + (repeating ? " (repeated the last step)" : " Move or turn it, then press Ctrl+D again to repeat that step."));
}

function select(id) {
  selected = id;
  picked = id ? new Set([id]) : new Set();
  refresh();
  if (id) say(`${get(id).name} selected.`);
}

// Shift+click: add a shape to the selection, or take it out again
function togglePick(id) {
  if (picked.has(id)) {
    picked.delete(id);
    if (selected === id) selected = picked.size ? [...picked][picked.size - 1] : null;
  } else {
    picked.add(id);
    selected = id;
  }
  refresh();
  say(picked.size ? `${picked.size} shape${picked.size === 1 ? "" : "s"} selected.` : "Nothing selected.");
}

function selectAll() {
  if (!shapes.length) return;
  picked = new Set(shapes.map((s) => s.id));
  selected = shapes[shapes.length - 1].id;
  refresh();
  say(`All ${shapes.length} shapes selected.`);
}

// ---------- UI ----------
const shapeButtons = $("#shape-buttons");
// Shapes are grouped into categories, picked from a drop-down in the shape panel.
// Each category lists its ready-made hole shapes first. An entry is a shape type, optionally with
// preset settings (a hole, some letters, a size).
const HOLE_WORDS = "hole cut cutout negative remove";
const hole = (type, label, extra = {}) => ({ type, label, extra: { hole: true, ...extra }, holeIcon: true });
const letter = (ch, extra = {}) => ({ type: "text", label: ch, glyph: ch, extra: { text: ch, ...extra }, words: `letter number character ${ch.toLowerCase()}` });
// Parts made of several pieces (measurements in millimetres, base of the part at height 0)
const BLACK = "#333333", GREY = "#9aa0a8", SILVER = "#c4c9d0", WHITE = "#ffffff";
const KITS = {
  led: () => [
    { type: "cylinder", w: 5.8, d: 5.8, h: 1, color: "#e5352b" },
    { type: "cylinder", w: 5, d: 5, h: 6.1, y: 1, color: "#e5352b" },
    { type: "halfsphere", w: 5, d: 5, h: 2.5, y: 7.1, color: "#e5352b" },
    { type: "box", w: 0.5, d: 0.5, h: 17, x: -1.27, y: -17, color: GREY },
    { type: "box", w: 0.5, d: 0.5, h: 15, x: 1.27, y: -15, color: GREY }],
  battery: () => [
    { type: "cylinder", w: 14.5, d: 14.5, h: 49.5, color: BLACK },
    { type: "cylinder", w: 5.5, d: 5.5, h: 1, y: 49.5, color: SILVER }],
  button: () => [
    { type: "box", w: 6, d: 6, h: 3.5, color: BLACK },
    { type: "cylinder", w: 3.5, d: 3.5, h: 1.5, y: 3.5, color: GREY },
    ...[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([a, b]) => ({ type: "box", w: 0.7, d: 0.3, h: 3, x: a * 3.25, z: b * 2.25, y: -3, color: SILVER }))],
  servo: () => [
    { type: "box", w: 22.5, d: 12, h: 22.7, color: "#1f8fe5" },
    { type: "box", w: 32.5, d: 12, h: 2.5, y: 15.9, color: "#1f8fe5" },
    { type: "cylinder", w: 11.8, d: 11.8, h: 4, x: 5.35, y: 22.7, color: "#1f8fe5" },
    { type: "cylinder", w: 4.8, d: 4.8, h: 3, x: 5.35, y: 26.7, color: WHITE },
    { type: "box", w: 20, d: 5, h: 1.5, x: 5.35, y: 29.7, color: WHITE }],
  board: () => [
    { type: "box", w: 68.6, d: 53.3, h: 1.6, color: "#1f7a36" },
    ...[[-30.8, -23.2], [30.8, -23.2], [-30.8, 23.2], [30.8, 23.2]].map(([x, z]) => ({ type: "cylinder", w: 3.2, d: 3.2, h: 5, x, z, y: -1, hole: true })),
    { type: "box", w: 16, d: 12, h: 11, x: -28.3, z: -12, y: 1.6, color: SILVER },
    { type: "box", w: 13, d: 9, h: 11, x: -28.3, z: 14, y: 1.6, color: BLACK },
    { type: "box", w: 35, d: 10, h: 4, x: 8, z: 12, y: 1.6, color: BLACK },
    { type: "box", w: 48, d: 2.5, h: 8.5, x: 6, z: -24, y: 1.6, color: BLACK },
    { type: "box", w: 36, d: 2.5, h: 8.5, x: 12, z: 24, y: 1.6, color: BLACK }],
  breadboard: () => [
    { type: "box", w: 82, d: 55, h: 8.5, color: WHITE },
    { type: "box", w: 78, d: 2.5, h: 2, z: 0, y: 7, hole: true },
    { type: "box", w: 76, d: 1, h: 0.4, z: -23, y: 8.5, color: "#e5352b" },
    { type: "box", w: 76, d: 1, h: 0.4, z: 23, y: 8.5, color: "#1f8fe5" }],
  balljoint: () => [
    { type: "cylinder", w: 5, d: 5, h: 10, color: GREY },
    { type: "sphere", w: 10, d: 10, h: 10, y: 8, color: GREY }],
  smiley: () => [
    { type: "cylinder", w: 30, d: 30, h: 4, color: "#f2c230" },
    { type: "cylinder", w: 4, d: 5, h: 10, x: -5.5, z: -5, y: -1, hole: true },
    { type: "cylinder", w: 4, d: 5, h: 10, x: 5.5, z: -5, y: -1, hole: true },
    { type: "moon", w: 7, d: 16, h: 10, z: 6, y: -1, r: 90, hole: true }],
  cloud: () => [
    { type: "cylinder", w: 12, d: 12, h: 5, x: -9, z: 2, color: "#1f8fe5" },
    { type: "cylinder", w: 16, d: 16, h: 5, x: 0, z: -2, color: "#1f8fe5" },
    { type: "cylinder", w: 12, d: 12, h: 5, x: 9, z: 2, color: "#1f8fe5" },
    { type: "box", w: 18, d: 8, h: 5, z: 4, color: "#1f8fe5" }],
  paw: () => [
    { type: "cylinder", w: 14, d: 12, h: 5, z: 5, color: "#7a4a24" },
    ...[[-9, -3], [-3.5, -9], [3.5, -9], [9, -3]].map(([x, z]) => ({ type: "cylinder", w: 6, d: 7, h: 5, x, z, color: "#7a4a24" }))],
  note: () => [
    { type: "cylinder", w: 9, d: 7, h: 5, x: -2, z: 8, r: 20, color: BLACK },
    { type: "box", w: 2, d: 20, h: 5, x: 1.8, z: -1, color: BLACK },
    { type: "box", w: 7, d: 2.5, h: 5, x: 4.5, z: -10, r: -30, color: BLACK }],
  puzzle: () => [
    { type: "box", w: 20, d: 20, h: 5, color: "#2fa24a" },
    { type: "cylinder", w: 7, d: 7, h: 5, x: 12, color: "#2fa24a" },
    { type: "cylinder", w: 7, d: 7, h: 5, z: 12, color: "#2fa24a" },
    { type: "cylinder", w: 7.4, d: 7.4, h: 7, x: -8, y: -1, hole: true },
    { type: "cylinder", w: 7.4, d: 7.4, h: 7, z: -8, y: -1, hole: true }],
};
// Design starters and characters: simple parts made of basic shapes
const RED = "#e5352b", GREEN = "#2fa24a", BROWN = "#7a4a24", GOLD = "#f2c230", SKIN = "#f2c9a0", TAN = "#e0a85a";
const around = (n, rad, make) => Array.from({ length: n }, (_, i) => { const a = (i / n) * 360, t = (a * Math.PI) / 180; return make(Math.round(Math.sin(t) * rad * 100) / 100, Math.round(Math.cos(t) * rad * 100) / 100, a); });
// food slices, built from circle slices that all share the same point (tip at the front).
// slicePart(angle, tipZ)(radius, hollow %, extra) places one slice or curved band by its real outline.
const slicePart = (A, tip) => (R, inner, extra) => {
const half = (A * Math.PI) / 360, r = (R * inner) / 100;
const near = inner ? r * Math.cos(half) : 0; // the end of the outline nearest the point
const round2 = (v) => Math.round(v * 100) / 100;
return { type: "pie", angle: A, inner, w: round2(2 * R * Math.sin(half)), d: round2(R - near), z: round2(tip - (R + near) / 2), ...extra };
};
Object.assign(KITS, {
  gift: () => [
    { type: "box", w: 20, d: 20, h: 16, color: RED },
    { type: "box", w: 20.4, d: 4, h: 16.2, color: GREEN }, { type: "box", w: 4, d: 20.4, h: 16.2, color: GREEN },
    { type: "torus", w: 8, d: 4, h: 3, x: -3, y: 15.5, r: 30, t: 90, color: GREEN }, { type: "torus", w: 8, d: 4, h: 3, x: 3, y: 15.5, r: -30, t: 90, color: GREEN }],
  cubeframe: () => {
    const L = 20, t = 3, o = (L - t) / 2, out = [];
    for (const a of [-o, o]) for (const b of [-o, o]) {
      out.push({ type: "box", w: t, d: t, h: L, x: a, z: b, color: RED });
      out.push({ type: "box", w: L, d: t, h: t, z: a, y: b + o, color: RED });
      out.push({ type: "box", w: t, d: L, h: t, x: a, y: b + o, color: RED });
    }
    return out;
  },
  staroutline: () => [{ type: "star", w: 30, d: 30, h: 4, color: GOLD }, { type: "star", w: 21, d: 21, h: 6, y: -1, hole: true }],
  heartoutline: () => [{ type: "heart", w: 30, d: 30, h: 4, color: RED }, { type: "heart", w: 21, d: 21, h: 6, y: -1, z: -1, hole: true }],
  // a shamrock: three heart-shaped leaves with their points meeting in the middle, and a curved stem.
  // The leaves differ in height by a hair so their tops never lie exactly level (no flicker or gaps).
  clover: () => [
    ...[180, 60, 300].map((a, i) => { const t = (a * Math.PI) / 180; return { type: "heart", w: 13, d: 13, h: 4 + i * 0.03, x: Math.round(Math.sin(t) * 6.2 * 100) / 100, z: Math.round(Math.cos(t) * 6.2 * 100) / 100, r: a + 180, color: GREEN }; }),
    { type: "box", w: 2.2, d: 9, h: 3.9, x: 1.2, z: 9.5, r: 18, color: GREEN }, { type: "cylinder", w: 3.4, d: 3.4, h: 3.95, color: GREEN }],
  fan: () => [{ type: "cylinder", w: 7, d: 7, h: 4, color: "#333333" },
    ...around(3, 8, (x, z, a) => ({ type: "box", w: 6, d: 13, h: 1.5, x, z, r: a, y: 1, color: "#333333" }))],
  book: () => [{ type: "box", w: 30, d: 22, h: 5, color: "#1f8fe5" }, { type: "box", w: 28, d: 21, h: 4, x: 1.2, y: 0.5, color: WHITE }],
  power: () => [
    { type: "tube", w: 24, d: 24, h: 3, wall: 18, color: "#1f8fe5" },
    { type: "box", w: 7, d: 13, h: 5, z: -8, y: -1, hole: true },
    { type: "box", w: 3.5, d: 13, h: 3, z: -6.5, color: "#1f8fe5" }],
  table: () => [{ type: "box", w: 40, d: 24, h: 3, y: 20, color: BROWN },
    ...[[-17, -9], [17, -9], [-17, 9], [17, 9]].map(([x, z]) => ({ type: "box", w: 3, d: 3, h: 20, x, z, color: BROWN }))],
  window: () => [{ type: "frame", w: 30, d: 30, h: 3, wall: 14, color: WHITE },
    { type: "box", w: 2, d: 28, h: 3, color: WHITE }, { type: "box", w: 28, d: 2, h: 3, color: WHITE }],
  beadring: () => around(10, 12, (x, z, a) => ({ type: "box", w: 5, d: 5, h: 5, x, z, r: a, color: "#f08a1c" })),
  cubestack: () => { const out = []; for (const x of [-5, 5]) for (const z of [-5, 5]) for (const y of [0, 10]) out.push({ type: "box", w: 10, d: 10, h: 10, x, z, y, color: RED }); return out; },
  stairs: () => Array.from({ length: 6 }, (_, i) => ({ type: "box", w: 20, d: 5, h: 5 * (i + 1), z: 12.5 - i * 5, color: GREEN })),
  ladder: () => [{ type: "box", w: 3, d: 3, h: 60, x: -10, color: BROWN }, { type: "box", w: 3, d: 3, h: 60, x: 10, color: BROWN },
    ...Array.from({ length: 7 }, (_, i) => ({ type: "box", w: 17, d: 2, h: 2, y: 6 + i * 8, color: BROWN }))],
  fence: () => [...Array.from({ length: 8 }, (_, i) => ({ type: "box", w: 4, d: 2, h: 24, x: -21 + i * 6, color: WHITE })),
    { type: "box", w: 48, d: 1.5, h: 3, y: 6, z: 1.6, color: WHITE }, { type: "box", w: 48, d: 1.5, h: 3, y: 16, z: 1.6, color: WHITE }],
  bricks: () => { const out = []; for (let row = 0; row < 4; row++) for (let i = 0; i < 4; i++) out.push({ type: "box", w: 9.4, d: 5, h: 4.4, x: -15 + i * 10 + (row % 2 ? 5 : 0), y: row * 5, color: "#b5452e" }); return out; },
  house: () => [{ type: "box", w: 20, d: 20, h: 16, color: WHITE }, { type: "roof", w: 23, d: 22, h: 10, y: 16, color: BROWN },
    { type: "box", w: 5, d: 1, h: 9, z: 10.2, color: BROWN }, { type: "box", w: 4, d: 1, h: 4, x: 6, y: 9, z: 10.2, color: "#7cc0ff" }],
  tree: () => [{ type: "cylinder", w: 4, d: 4, h: 8, color: BROWN }, { type: "cone", w: 16, d: 16, h: 20, y: 7, color: GREEN }],
  burger: () => [{ type: "cylinder", w: 24, d: 24, h: 4, color: TAN }, { type: "cylinder", w: 24, d: 24, h: 4, y: 4, color: BROWN },
    { type: "box", w: 21, d: 21, h: 1, y: 7.8, r: 45, color: GOLD }, { type: "halfsphere", w: 24, d: 24, h: 9, y: 8.6, color: TAN }],
  flange: () => [{ type: "cylinder", w: 30, d: 30, h: 3, color: SILVER }, { type: "tube", w: 14, d: 14, h: 15, wall: 25, y: 3, color: SILVER },
    { type: "cylinder", w: 7, d: 7, h: 20, y: -1, hole: true },
    ...around(4, 11, (x, z) => ({ type: "cylinder", w: 3.4, d: 3.4, h: 5, x, z, y: -1, hole: true }))],
  pizza: () => {
    const A = 40, sl = slicePart(A, 20);
    return [
      sl(40, 0, { h: 2.5, color: TAN }),
      sl(40, 86, { h: 5, color: "#c98a3e" }),
      sl(35, 0, { h: 0.8, y: 2.5, color: "#ffd34d" }),
      ...[[12, 0], [21, -3.2], [22, 3.6], [30, 0.2]].map(([dist, side]) => ({ type: "cylinder", w: 4.6, d: 4.6, h: 0.7, y: 3.2, x: side, z: 20 - dist, color: "#c0392b" }))];
  },
  pieslice: () => {
    const A = 50, sl = slicePart(A, 20), half = (A * Math.PI) / 360;
    return [
      sl(40, 0, { h: 2, color: TAN }),
      sl(38, 0, { h: 9, y: 2, color: "#8e1b3a" }),
      sl(40, 92, { h: 12, color: "#c98a3e" }),
      sl(40, 0, { h: 2, y: 11, color: "#f0c27a" }),
      ...[0.35, 0.6, 0.85].map((f) => ({ type: "box", w: Math.round(40 * f * Math.tan(half) * 2 * 0.9 * 100) / 100, d: 1.4, h: 0.8, y: 13, z: 20 - 40 * f, color: "#c98a3e" }))];
  },
  // characters and creatures
  eye: () => [{ type: "halfsphere", w: 16, d: 16, h: 8, color: WHITE }, { type: "halfsphere", w: 7, d: 7, h: 3, y: 6.2, z: 2, t: -20, color: "#333333" }],
  glasses: () => [{ type: "tube", w: 16, d: 16, h: 2, wall: 12, x: -10, color: "#e8306e" }, { type: "tube", w: 16, d: 16, h: 2, wall: 12, x: 10, color: "#e8306e" },
    { type: "box", w: 5, d: 2, h: 2, z: -2, color: "#e8306e" }, { type: "box", w: 2, d: 22, h: 2, x: -17, z: -11, color: "#e8306e" }, { type: "box", w: 2, d: 22, h: 2, x: 17, z: -11, color: "#e8306e" }],
  tophat: () => [{ type: "cylinder", w: 30, d: 30, h: 1.5, color: "#333333" }, { type: "cylinder", w: 18, d: 18, h: 18, y: 1.5, color: "#333333" },
    { type: "cylinder", w: 18.6, d: 18.6, h: 3, y: 2, color: RED }],
  crown: () => [{ type: "tube", w: 24, d: 24, h: 8, wall: 12, color: GOLD },
    ...around(6, 11, (x, z) => ({ type: "cone", w: 4.5, d: 4.5, h: 7, x, z, y: 7.5, color: GOLD })),
    ...around(6, 11, (x, z) => ({ type: "sphere", w: 2.6, d: 2.6, h: 2.6, x, z, y: 3, color: RED }))],
  icecream: () => [{ type: "cone", w: 12, d: 12, h: 20, fy: -1, color: TAN }, { type: "sphere", w: 14, d: 14, h: 13, y: 16, color: "#f58db0" }],
  sword: () => [{ type: "box", w: 4, d: 40, h: 1.5, z: -10, color: SILVER }, { type: "pyramid", w: 4, d: 4, h: 4, z: -32, t: -90, y: 0.75, color: SILVER },
    { type: "box", w: 16, d: 3, h: 3, z: 11, color: GOLD }, { type: "cylinder", w: 3, d: 3, h: 10, t: 90, z: 12.5, y: 1.5, color: BROWN },
    { type: "sphere", w: 5, d: 5, h: 5, z: 24, y: -1, color: GOLD }],
  snowman: () => [{ type: "sphere", w: 20, d: 20, h: 20, color: WHITE }, { type: "sphere", w: 15, d: 15, h: 15, y: 15, color: WHITE },
    { type: "sphere", w: 11, d: 11, h: 11, y: 26.5, color: WHITE }, { type: "cone", w: 2.2, d: 2.2, h: 6, t: 90, y: 32, z: 5, color: "#f08a1c" },
    { type: "sphere", w: 1.8, d: 1.8, h: 1.8, x: -2, y: 33.5, z: 4.4, color: "#333333" }, { type: "sphere", w: 1.8, d: 1.8, h: 1.8, x: 2, y: 33.5, z: 4.4, color: "#333333" }],
  person: () => [{ type: "cylinder", w: 14, d: 14, h: 18, color: "#1f8fe5" }, { type: "sphere", w: 13, d: 13, h: 13, y: 17, color: SKIN }],
  hardhat: () => [{ type: "halfsphere", w: 22, d: 24, h: 12, color: GOLD }, { type: "cylinder", w: 26, d: 30, h: 1.5, z: 1.5, color: GOLD }],
  propeller: () => [{ type: "halfsphere", w: 20, d: 20, h: 10, color: RED }, { type: "cylinder", w: 2, d: 2, h: 4, y: 9.5, color: SILVER },
    { type: "box", w: 22, d: 4, h: 1, y: 13.5, color: "#1f8fe5" }, { type: "box", w: 4, d: 22, h: 1, y: 13.6, color: GOLD }],
  mustache: () => [{ type: "cylinder", w: 14, d: 6, h: 3, x: -6, r: 15, color: BROWN }, { type: "cylinder", w: 14, d: 6, h: 3, x: 6, r: -15, color: BROWN }],
});

// ---------- Electronics, hardware, scenery and vehicles (simplified parts, our own designs) ----------
const DARK = "#2b2f36", BLUE_PCB = "#1f5fbf", GREEN_PCB = "#1f7a36", NAVY = "#1d3a8a", ORANGE = "#f08a1c", YELLOW = "#f2c230", WOOD = "#a0683a";
const spunPart = (path, extra) => ({ type: "spun", path, ...extra });
const P2 = {
  bulb: [[0, 0], [0.42, 0], [0.42, 0.12], [0.55, 0.3], [0.95, 0.55], [1, 0.72], [0.85, 0.9], [0.5, 0.99], [0, 1]],
  cup: [[0, 0], [1, 0], [0.96, 0.1], [0.4, 0.42], [0.22, 0.55], [0.22, 0.8], [0.42, 0.86], [0.42, 1], [0, 1]],
  foot: [[0, 0], [1, 0], [1, 0.45], [0.82, 0.92], [0.6, 1], [0, 1]],
  knob: [[0, 0], [0.32, 0], [0.32, 0.45], [0.9, 0.52], [1, 0.7], [0.85, 0.92], [0.5, 1], [0, 1]],
  barrel: [[0, 0], [0.84, 0], [0.95, 0.25], [1, 0.5], [0.95, 0.75], [0.84, 1], [0, 1]],
  pulley: [[0, 0], [1, 0], [1, 0.2], [0.62, 0.42], [0.62, 0.58], [1, 0.8], [1, 1], [0, 1]],
  hull: [[0.5, 0], [0.9, 0.25], [1, 0.45], [1, 1], [0, 1], [0, 0.45], [0.1, 0.25]],
};
Object.assign(KITS, {
  // electronics
  battery9v: () => [{ type: "roundedbox", radius: 1.5, w: 26.5, d: 17.5, h: 46, color: DARK }, { type: "box", w: 26.6, d: 17.6, h: 14, y: 30, color: ORANGE },
    { type: "cylinder", w: 7.6, d: 7.6, h: 3, x: -6.4, y: 46, color: SILVER }, { type: "polygon", sides: 6, w: 8.6, d: 8.6, h: 3, x: 6.4, y: 46, color: SILVER }],
  cell18650: () => [{ type: "cylinder", w: 18.4, d: 18.4, h: 64, color: "#1f8fe5" }, { type: "cylinder", w: 7, d: 7, h: 1.2, y: 64, color: SILVER },
    { type: "tube", wall: 8, w: 18.6, d: 18.6, h: 3, y: 61, color: WHITE }],
  bulb: () => [{ type: "screw", threads: 5, depth: 10, w: 13, d: 13, h: 12, color: SILVER }, { type: "cylinder", w: 6, d: 6, h: 2, y: -2, color: DARK },
    spunPart(P2.bulb, { w: 30, d: 30, h: 36, y: 11.5, color: "#fff7d6", clear: true })],
  dcmotor: () => [{ type: "cylinder", sides: 40, t: 90, w: 24, d: 24, h: 30, y: 12, z: -15, color: SILVER },
    { type: "cylinder", sides: 24, t: 90, w: 7, d: 7, h: 2, y: 12, z: 15, color: SILVER }, { type: "cylinder", sides: 16, t: 90, w: 2, d: 2, h: 10, y: 12, z: 17, color: "#6b7280" },
    { type: "box", w: 2, d: 1, h: 5, x: -5, y: 10, z: -16, color: "#c4a24a" }, { type: "box", w: 2, d: 1, h: 5, x: 5, y: 10, z: -16, color: "#c4a24a" }],
  gearmotor: () => [{ type: "box", w: 22, d: 37, h: 19, color: YELLOW }, { type: "cylinder", t: 90, w: 18, d: 18, h: 25, y: 9.5, z: 18.5, color: SILVER },
    { type: "box", l: 90, w: 5.4, d: 3.6, h: 8, x: -11, y: 9.5, z: -9, color: WHITE }, { type: "box", l: -90, w: 5.4, d: 3.6, h: 8, x: 11, y: 9.5, z: -9, color: WHITE }],
  sevenseg: () => [{ type: "box", w: 12.6, d: 19, h: 8, color: DARK },
    ...[-7, 0, 7].map((z) => ({ type: "box", w: 6, d: 1.2, h: 0.3, y: 8, z, color: RED })),
    ...[[-3.5, -3.5], [3.5, -3.5], [-3.5, 3.5], [3.5, 3.5]].map(([x, z]) => ({ type: "box", w: 1.2, d: 6, h: 0.3, x, z, y: 8, color: RED }))],
  lcd: () => [{ type: "box", w: 80, d: 36, h: 1.6, color: GREEN_PCB }, { type: "box", w: 71, d: 24, h: 7, y: 1.6, color: DARK },
    { type: "box", w: 64, d: 14, h: 0.4, y: 8.6, color: "#8fd14f" }, ...Array.from({ length: 16 }, (_, i) => ({ type: "box", w: 0.64, d: 0.64, h: 6, x: -34 + i * 2.54, z: -16, y: 1.6, color: "#c4a24a" }))],
  oled: () => [{ type: "box", w: 27, d: 27, h: 1.6, color: BLUE_PCB }, { type: "box", w: 26, d: 16, h: 1.5, y: 1.6, z: 2, color: DARK },
    { type: "box", w: 22, d: 11, h: 0.3, y: 3.1, z: 1.5, color: "#5ec8ff" }, ...[0, 1, 2, 3].map((i) => ({ type: "box", w: 0.64, d: 0.64, h: 6, x: -3.8 + i * 2.54, z: -11.5, y: 1.6, color: "#c4a24a" }))],
  ultrasonic: () => [{ type: "box", w: 45, d: 20, h: 1.6, color: BLUE_PCB },
    { type: "cylinder", w: 16, d: 16, h: 12, x: -13, y: 1.6, color: SILVER }, { type: "cylinder", w: 16, d: 16, h: 12, x: 13, y: 1.6, color: SILVER },
    { type: "cylinder", w: 11, d: 11, h: 12.2, x: -13, y: 1.6, color: DARK }, { type: "cylinder", w: 11, d: 11, h: 12.2, x: 13, y: 1.6, color: DARK },
    { type: "box", w: 10, d: 4, h: 3.5, z: -6, y: 1.6, color: SILVER }],
  toggle: () => [{ type: "box", w: 13, d: 8, h: 10, color: "#1f8fe5" }, { type: "cylinder", w: 6, d: 6, h: 6, y: 10, color: SILVER },
    { type: "cylinder", w: 2.4, d: 2.4, h: 11, y: 15, t: 20, color: SILVER }, ...[-4.7, 0, 4.7].map((x) => ({ type: "box", w: 0.8, d: 2.5, h: 4, x, y: -4, color: "#c4a24a" }))],
  pot: () => [{ type: "box", w: 11, d: 12, h: 7, color: "#4a6fa5" }, { type: "cylinder", w: 7, d: 7, h: 5, y: 7, color: SILVER },
    { type: "gear", teeth: 24, w: 6, d: 6, h: 14, y: 12, color: SILVER }, ...[-2.5, 0, 2.5].map((x) => ({ type: "box", w: 0.8, d: 0.6, h: 5, x, z: 5, y: -5, color: "#c4a24a" }))],
  buzzer: () => [{ type: "cylinder", w: 12, d: 12, h: 9.5, color: DARK }, { type: "cylinder", w: 2.5, d: 2.5, h: 4, y: 7, hole: true },
    { type: "box", w: 0.6, d: 0.6, h: 6, x: -3.25, y: -6, color: SILVER }, { type: "box", w: 0.6, d: 0.6, h: 6, x: 3.25, y: -6, color: SILVER }],
  coolfan: () => [{ type: "tube", wall: 6, w: 40, d: 40, h: 10, color: DARK },
    ...[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([a, b]) => ({ type: "box", w: 7, d: 7, h: 10, x: a * 16.5, z: b * 16.5, color: DARK })),
    ...[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([a, b]) => ({ type: "cylinder", w: 3.4, d: 3.4, h: 12, x: a * 16, z: b * 16, y: -1, hole: true })),
    { type: "cylinder", w: 14, d: 14, h: 9, y: 0.5, color: DARK }, ...around(7, 10, (x, z, a) => ({ type: "box", w: 7, d: 12, h: 1.2, x, z, y: 4.4, r: a + 25, t: 25, color: DARK }))],
  solar: () => [{ type: "box", w: 60, d: 40, h: 2, color: SILVER },
    ...Array.from({ length: 12 }, (_, i) => ({ type: "box", w: 13.6, d: 11.6, h: 0.3, x: -22.2 + (i % 4) * 14.8, z: -12.6 + Math.floor(i / 4) * 12.6, y: 2, color: NAVY }))],
  stepper: () => [{ type: "roundedbox", radius: 3, w: 42, d: 42, h: 40, color: DARK }, { type: "box", w: 42.2, d: 42.2, h: 8, y: 16, color: SILVER },
    { type: "cylinder", w: 22, d: 22, h: 2, y: 40, color: SILVER }, { type: "cylinder", w: 5, d: 5, h: 22, y: 42, color: SILVER }],
  joystick: () => [{ type: "box", w: 34, d: 26, h: 1.6, color: BLUE_PCB }, { type: "box", w: 20, d: 20, h: 10, y: 1.6, color: DARK },
    { type: "halfsphere", w: 18, d: 18, h: 7, y: 11.6, color: DARK }, { type: "cylinder", w: 4, d: 4, h: 10, y: 15, color: DARK },
    { type: "cylinder", w: 14, d: 14, h: 7, y: 24, color: DARK }, ...[0, 1, 2, 3, 4].map((i) => ({ type: "box", w: 0.64, d: 0.64, h: 6, x: -5.08 + i * 2.54, z: 11, y: 1.6, color: "#c4a24a" }))],
  resistor: () => [{ type: "capsule", t: 90, w: 2.6, d: 2.6, h: 7, y: 1.3, z: -3.5, color: "#d9b38c" },
    { type: "box", w: 0.6, d: 28, h: 0.6, y: 1, color: SILVER },
    ...[[-1.8, RED], [-0.6, "#8a4fd8"], [0.6, "#7a4a24"], [2.2, GOLD]].map(([z, c]) => ({ type: "cylinder", t: 90, w: 2.8, d: 2.8, h: 0.6, y: 1.3, z, color: c }))],
  capacitor: () => [{ type: "cylinder", w: 8, d: 8, h: 13, color: "#1f5fbf" }, { type: "box", w: 1.6, d: 8.1, h: 13.1, x: 3.2, color: "#c4c9d0" },
    { type: "box", w: 0.6, d: 0.6, h: 15, x: -1.75, y: -15, color: SILVER }, { type: "box", w: 0.6, d: 0.6, h: 13, x: 1.75, y: -13, color: SILVER }],
  heatsink: () => [{ type: "box", w: 30, d: 30, h: 3, color: SILVER }, ...Array.from({ length: 7 }, (_, i) => ({ type: "box", w: 1.6, d: 30, h: 15, x: -13.2 + i * 4.4, y: 3, color: SILVER }))],
  header: () => [{ type: "box", w: 20.32, d: 2.54, h: 2.5, color: DARK }, ...Array.from({ length: 8 }, (_, i) => ({ type: "box", w: 0.64, d: 0.64, h: 11.5, x: -8.89 + i * 2.54, y: -3, color: "#c4a24a" }))],
  jack: () => [{ type: "box", w: 9, d: 14, h: 11, color: DARK }, { type: "cylinder", t: 90, w: 6.3, d: 6.3, h: 10, y: 5.5, z: -2, hole: true },
    { type: "cylinder", t: 90, w: 2, d: 2, h: 10, y: 5.5, z: -3, color: SILVER }],
  matrix: () => [{ type: "box", w: 32, d: 32, h: 8, color: WHITE },
    ...Array.from({ length: 64 }, (_, i) => ({ type: "cylinder", sides: 8, w: 3, d: 3, h: 0.4, x: -14 + (i % 8) * 4, z: -14 + Math.floor(i / 8) * 4, y: 8, color: RED }))],
  // hardware
  bearing: () => [{ type: "tube", wall: 14, w: 22, d: 22, h: 7, color: SILVER }, { type: "tube", wall: 12, w: 16, d: 16, h: 6.6, y: 0.2, color: DARK },
    { type: "tube", wall: 25, w: 12, d: 12, h: 7, color: SILVER }],
  eyebolt: () => [{ type: "torus", tube: 22, w: 16, d: 16, h: 3, z: -8, color: SILVER }, { type: "cylinder", t: 90, w: 3, d: 3, h: 25, y: 1.5, z: -1, color: SILVER }],
  dring: () => { const sl = slicePart(180, 0); return [sl(14, 78, { h: 3, color: SILVER }), { type: "box", w: 28, d: 3, h: 3, z: -1.5, color: SILVER }]; },
  snapball: () => [{ type: "sphere", w: 12, d: 12, h: 12, color: "#16b6b0" }, { type: "cylinder", w: 6, d: 6, h: 6, y: 9, color: "#16b6b0" }, { type: "sphere", w: 12, d: 12, h: 12, y: 12, color: "#16b6b0" }],
  balllink: () => [{ type: "cylinder", t: 90, w: 3.2, d: 3.2, h: 24, y: 3, z: -12, color: "#1f8fe5" },
    { type: "sphere", w: 6, d: 6, h: 6, z: -13, color: "#1f8fe5" }, { type: "sphere", w: 6, d: 6, h: 6, z: 13, color: "#1f8fe5" }],
  hinge: () => [{ type: "box", w: 20, d: 30, h: 1.5, x: -11, color: SILVER }, { type: "box", w: 20, d: 30, h: 1.5, x: 11, color: SILVER },
    ...Array.from({ length: 5 }, (_, i) => ({ type: "cylinder", t: 90, w: 4, d: 4, h: 5.6, y: 2, z: -15 + i * 6, x: i % 2 ? 0.01 : 0, color: SILVER })),
    ...[-1, 1].flatMap((side) => [-8, 8].map((z) => ({ type: "cylinder", w: 3.4, d: 3.4, h: 3, x: side * 13, z, y: -1, hole: true })))],
  clip: () => [{ type: "tube", wall: 18, w: 10, d: 10, h: 6, color: SILVER }, { type: "box", w: 4, d: 4, h: 8, z: -4.5, y: -1, hole: true },
    { type: "box", w: 20, d: 2, h: 6, z: 5.5, color: SILVER }],
  hub: () => [{ type: "box", w: 12, d: 12, h: 12, color: "#e8306e" }, { type: "cylinder", w: 6, d: 6, h: 14, y: -1, hole: true },
    { type: "cylinder", l: 90, w: 6, d: 6, h: 14, x: 7, y: 6, hole: true }, { type: "cylinder", t: 90, w: 6, d: 6, h: 14, y: 6, z: -7, hole: true }],
  chain: () => [0, 1, 2, 3].map((i) => (i % 2
    ? { type: "torus", tube: 28, w: 14, d: 8, h: 2.5, x: i * 10, y: 4, z: -1.25, t: 90, color: SILVER }
    : { type: "torus", tube: 28, w: 14, d: 8, h: 2.5, x: i * 10, y: 2.75, color: SILVER })),
  // structures and scenery
  roundtree: () => [{ type: "cylinder", w: 4, d: 4, h: 12, color: BROWN }, { type: "sphere", w: 18, d: 18, h: 18, y: 10, color: GREEN }],
  pine: () => [{ type: "cylinder", w: 4, d: 4, h: 6, color: BROWN }, ...[[22, 5], [17, 11], [12, 17]].map(([w, y]) => ({ type: "cone", w, d: w, h: 10, y, color: "#1f7a36" }))],
  palm: () => [{ type: "cylinder", w: 3, d: 3, h: 30, color: WOOD }, { type: "sphere", w: 5, d: 5, h: 5, y: 28, color: BROWN },
    ...around(6, 7, (x, z, a) => ({ type: "box", w: 3.5, d: 15, h: 0.8, x, z, y: 29, r: a, t: -14, color: GREEN }))],
  cactus: () => [{ type: "capsule", w: 8, d: 8, h: 30, color: GREEN }, { type: "capsule", w: 5, d: 5, h: 13, x: -8, y: 11, color: GREEN },
    { type: "capsule", w: 5, d: 5, h: 11, x: 8, y: 15, color: GREEN }, { type: "box", w: 8, d: 4, h: 4, x: -5, y: 11, color: GREEN }, { type: "box", w: 8, d: 4, h: 4, x: 5, y: 15, color: GREEN }],
  bed: () => [{ type: "box", w: 30, d: 50, h: 8, color: BROWN }, { type: "box", w: 28, d: 46, h: 5, y: 8, color: WHITE },
    { type: "roundedbox", radius: 1.5, w: 20, d: 8, h: 4, y: 12.5, z: -18, color: WHITE }, { type: "box", w: 28.6, d: 30, h: 5.6, y: 7.9, z: 8, color: "#1f8fe5" },
    { type: "box", w: 30, d: 2, h: 20, z: -25, color: BROWN }],
  sofa: () => [{ type: "box", w: 50, d: 22, h: 10, color: "#8e5a3a" }, { type: "box", w: 50, d: 6, h: 16, y: 10, z: -8, color: "#8e5a3a" },
    { type: "box", w: 5, d: 22, h: 15, x: -22.5, color: "#7a4a30" }, { type: "box", w: 5, d: 22, h: 15, x: 22.5, color: "#7a4a30" },
    { type: "roundedbox", radius: 1, w: 19.5, d: 15, h: 3, x: -10, y: 10, z: 3, color: "#a06a48" }, { type: "roundedbox", radius: 1, w: 19.5, d: 15, h: 3, x: 10, y: 10, z: 3, color: "#a06a48" }],
  armchair: () => [{ type: "box", w: 26, d: 22, h: 10, color: "#8e5a3a" }, { type: "box", w: 26, d: 6, h: 16, y: 10, z: -8, color: "#8e5a3a" },
    { type: "box", w: 5, d: 22, h: 15, x: -10.5, color: "#7a4a30" }, { type: "box", w: 5, d: 22, h: 15, x: 10.5, color: "#7a4a30" }],
  chair: () => [{ type: "box", w: 16, d: 16, h: 2, y: 12, color: WOOD }, { type: "box", w: 16, d: 2, h: 16, y: 14, z: -7, color: WOOD },
    ...[[-7, -7], [7, -7], [-7, 7], [7, 7]].map(([x, z]) => ({ type: "box", w: 2, d: 2, h: 12, x, z, color: WOOD }))],
  roundtable: () => [{ type: "cylinder", w: 30, d: 30, h: 2, y: 18, color: TAN }, { type: "cylinder", w: 3, d: 3, h: 18, color: "#6b7280" },
    { type: "cylinder", w: 14, d: 14, h: 1.5, color: "#6b7280" }],
  bookshelf: () => [{ type: "box", w: 2, d: 12, h: 40, x: -14, color: WOOD }, { type: "box", w: 2, d: 12, h: 40, x: 14, color: WOOD },
    ...[0, 13, 26, 38].map((y) => ({ type: "box", w: 26, d: 12, h: 2, y, color: WOOD })), { type: "box", w: 30, d: 1, h: 40, z: -5.5, color: WOOD },
    ...[[-10, 2, RED, 9], [-7, 2, "#1f8fe5", 10], [-4, 2, GREEN, 8], [3, 15, YELLOW, 9], [6, 15, "#8a4fd8", 10], [9.5, 15, ORANGE, 9]].map(([x, y, c, h]) => ({ type: "box", w: 2.6, d: 9, h, x, y, color: c }))],
  door: () => [{ type: "box", w: 20, d: 2, h: 40, color: WOOD }, { type: "box", w: 14, d: 2.2, h: 14, y: 22, color: "#8c5a30" },
    { type: "box", w: 14, d: 2.2, h: 14, y: 4, color: "#8c5a30" }, { type: "sphere", w: 2.5, d: 2.5, h: 2.5, x: 7, y: 18, z: 1.5, color: GOLD }],
  tablelamp: () => [{ type: "cylinder", w: 10, d: 10, h: 2, color: "#6b7280" }, { type: "cylinder", w: 2, d: 2, h: 14, y: 2, color: "#6b7280" },
    { type: "cone", top: 55, w: 18, d: 18, h: 12, y: 12, color: "#f5e6c4" }],
  lamppost: () => [{ type: "cylinder", w: 6, d: 6, h: 4, color: DARK }, { type: "cylinder", w: 2.5, d: 2.5, h: 46, color: DARK },
    { type: "cone", top: 50, fy: -1, w: 7, d: 7, h: 4, y: 45, color: DARK }, { type: "sphere", w: 6, d: 6, h: 6, y: 49, color: "#fff2a8" }],
  bench: () => [...[-4, 0, 4].map((z) => ({ type: "box", w: 40, d: 3, h: 1.5, y: 10, z, color: WOOD })),
    ...[14, 18].map((y) => ({ type: "box", w: 40, d: 1.5, h: 3, y, z: -6, color: WOOD })),
    ...[-17, 17].flatMap((x) => [{ type: "box", w: 2, d: 10, h: 10, x, color: DARK }, { type: "box", w: 2, d: 2, h: 12, x, y: 10, z: -6.5, color: DARK }])],
  picnic: () => [...[-6, 0, 6].map((z) => ({ type: "box", w: 40, d: 5, h: 2, y: 14, z, color: WOOD })),
    ...[-16, 16].map((z) => ({ type: "box", w: 40, d: 6, h: 2, y: 8, z, color: WOOD })),
    ...[-15, 15].flatMap((x) => [{ type: "box", w: 2, d: 2, h: 14, x, z: -4, color: WOOD }, { type: "box", w: 2, d: 2, h: 14, x, z: 4, color: WOOD }, { type: "box", w: 2, d: 38, h: 2, x, y: 6, color: WOOD }])],
  mailbox: () => [{ type: "box", w: 4, d: 4, h: 30, color: WOOD }, { type: "box", w: 10, d: 20, h: 8, y: 30, color: "#1f5fbf" },
    { type: "roundroof", w: 10, d: 20, h: 5, y: 38, color: "#1f5fbf" }, { type: "box", w: 1, d: 3, h: 8, x: 5.5, y: 34, z: 4, color: RED }],
  hydrant: () => [{ type: "cylinder", w: 13, d: 13, h: 2, color: RED }, { type: "cylinder", w: 10, d: 10, h: 20, color: RED },
    { type: "halfsphere", w: 10, d: 10, h: 5, y: 20, color: RED }, { type: "cylinder", w: 3, d: 3, h: 3, y: 24, color: RED },
    { type: "cylinder", t: 90, w: 4, d: 4, h: 4, y: 14, z: 4, color: RED }, { type: "cylinder", l: 90, w: 3.5, d: 3.5, h: 4, x: -4, y: 14, color: RED }, { type: "cylinder", l: -90, w: 3.5, d: 3.5, h: 4, x: 4, y: 14, color: RED }],
  trafficcone: () => [{ type: "box", w: 18, d: 18, h: 1.5, color: ORANGE }, { type: "cone", top: 18, w: 14, d: 14, h: 24, y: 1.5, color: ORANGE },
    { type: "cone", top: 70, w: 10.2, d: 10.2, h: 4, y: 10, color: WHITE }],
  barrel: () => [spunPart(P2.barrel, { w: 20, d: 20, h: 26, color: WOOD }), { type: "tube", wall: 5, w: 18.9, d: 18.9, h: 2, y: 4, color: DARK }, { type: "tube", wall: 5, w: 18.9, d: 18.9, h: 2, y: 20, color: DARK }],
  pumpkin: () => [...around(6, 4, (x, z, a) => ({ type: "sphere", w: 14, d: 22, h: 18, x, z, r: a, color: ORANGE })), { type: "cylinder", w: 3, d: 3, h: 6, y: 16, t: 10, color: GREEN }],
  pool: () => [{ type: "cylinder", w: 36, d: 36, h: 1, color: "#7cc0ff" }, ...[[0, "#1f8fe5"], [5, YELLOW], [10, "#e8306e"]].map(([y, c]) => ({ type: "torus", tube: 30, w: 40, d: 40, h: 6, y, color: c }))],
  arch: () => [{ type: "box", w: 5, d: 6, h: 20, x: -12.5, color: "#c4b8a8" }, { type: "box", w: 5, d: 6, h: 20, x: 12.5, color: "#c4b8a8" },
    { type: "roundroof", w: 30, d: 6, h: 15, y: 20, color: "#c4b8a8" }, { type: "roundroof", w: 20, d: 8, h: 10, y: 19.95, hole: true }],
  tower: () => [{ type: "cylinder", w: 18, d: 18, h: 30, color: "#9aa0a8" }, ...around(8, 7.5, (x, z, a) => ({ type: "box", w: 4, d: 3.5, h: 4, x, z, r: a, y: 30, color: "#9aa0a8" })),
    { type: "box", w: 3, d: 2, h: 6, y: 18, z: 8.6, color: DARK }],
  // vehicles and machines
  wheel: () => [{ type: "torus", tube: 36, t: 90, w: 30, d: 30, h: 12, y: 15, z: -6, color: DARK }, { type: "cylinder", t: 90, w: 20, d: 20, h: 10, y: 15, z: -5, color: SILVER },
    { type: "cylinder", t: 90, w: 6, d: 6, h: 13, y: 15, z: -6.5, color: "#6b7280" }],
  tire: () => [{ type: "gear", teeth: 26, t: 90, w: 32, d: 32, h: 14, y: 16, z: -7, color: DARK }, { type: "cylinder", t: 90, w: 20, d: 20, h: 14.4, y: 16, z: -7.2, color: YELLOW },
    { type: "cylinder", t: 90, w: 5, d: 5, h: 16, y: 16, z: -8, hole: true }],
  spokewheel: () => [{ type: "tube", wall: 9, t: 90, w: 30, d: 30, h: 4, y: 15, z: -2, color: WOOD }, { type: "cylinder", t: 90, w: 6, d: 6, h: 6, y: 15, z: -3, color: WOOD },
    ...[0, 45, 90, 135].map((a) => ({ type: "box", w: 27, d: 2, h: 2, y: 14, l: a, color: WOOD }))],
  axle: () => [{ type: "cylinder", t: 90, w: 4, d: 4, h: 60, y: 2, z: -30, color: SILVER }],
  rocket: () => [{ type: "cylinder", w: 10, d: 10, h: 34, y: 4, color: WHITE }, { type: "cone", w: 10, d: 10, h: 14, y: 38, color: RED },
    { type: "cylinder", w: 6, d: 6, h: 4, color: "#6b7280" }, ...around(3, 6.5, (x, z, a) => ({ type: "wedge", w: 1.2, d: 8, h: 12, x, z, r: a + 180, color: RED })),
    { type: "cylinder", t: 90, w: 4, d: 4, h: 1, y: 26, z: 4.6, color: "#1f8fe5" }],
  car: () => [{ type: "box", w: 40, d: 18, h: 9, y: 4, color: ORANGE }, { type: "box", w: 20, d: 16, h: 8, x: -3, y: 12.5, color: "#cfe6ff" },
    { type: "wedge", w: 6, d: 16, h: 8, x: 10, y: 12.5, color: "#cfe6ff" },
    ...[-13, 13].flatMap((x) => [{ type: "cylinder", t: 90, w: 10, d: 10, h: 3, x, y: 5, z: 9, color: DARK }, { type: "cylinder", t: 90, w: 10, d: 10, h: 3, x, y: 5, z: -12, color: DARK }])],
  plane: () => [{ type: "capsule", t: 90, w: 6, d: 6, h: 40, y: 3, z: -20, color: RED }, { type: "box", w: 40, d: 8, h: 1.2, y: 2.6, z: -4, color: YELLOW },
    { type: "box", w: 14, d: 5, h: 1, y: 2.8, z: 14, color: YELLOW }, { type: "box", w: 1, d: 5, h: 7, y: 3, z: 14, color: RED },
    { type: "box", w: 1, d: 1, h: 12, y: -3, z: -21, color: DARK }],
  boat: () => [{ type: "scribble", path: P2.hull, w: 16, d: 36, h: 6, color: ORANGE }, { type: "box", w: 9, d: 10, h: 6, y: 6, z: 4, color: WHITE },
    { type: "cylinder", w: 1.5, d: 1.5, h: 14, y: 6, z: -4, color: WOOD }],
  windupkey: () => [{ type: "tube", wall: 22, w: 12, d: 12, h: 2.5, x: -5.5, z: -6, color: GOLD }, { type: "tube", wall: 22, w: 12, d: 12, h: 2.5, x: 5.5, z: -6, color: GOLD },
    { type: "box", w: 3.5, d: 18, h: 2.5, z: 7, color: GOLD }, { type: "box", w: 3, d: 2, h: 2.5, x: 2.5, z: 14, color: GOLD }],
  camera: () => [{ type: "roundedbox", radius: 2, w: 40, d: 14, h: 25, color: DARK }, { type: "box", w: 40.2, d: 14.2, h: 6, y: 16, color: SILVER },
    { type: "cylinder", t: 90, w: 14, d: 14, h: 10, y: 12, z: 6, color: DARK }, { type: "cylinder", t: 90, w: 10, d: 10, h: 10.2, y: 12, z: 6, color: "#5ec8ff" },
    { type: "box", w: 7, d: 5, h: 4, x: -12, y: 25, color: SILVER }, { type: "cylinder", w: 4, d: 4, h: 2, x: 13, y: 25, color: RED }],
});
// ---------- Fun & games, everyday objects, featured, sim lab, generators (simplified, our own designs) ----------
const CREAM = "#f3ead8", PINK = "#f58db0", PURPLE = "#8a4fd8";
const RAINBOW = [RED, ORANGE, YELLOW, GREEN, "#1f8fe5", PURPLE];
const P3 = {
  trophy: [[0, 0], [1, 0], [1, 0.08], [0.55, 0.12], [0.18, 0.2], [0.14, 0.42], [0.25, 0.48], [0.75, 0.6], [0.9, 0.8], [0.92, 1], [0.8, 1], [0.7, 0.72], [0, 0.66]],
  balloon: [[0, 0], [0.12, 0], [0.12, 0.05], [0.4, 0.15], [0.85, 0.42], [1, 0.62], [0.88, 0.85], [0.5, 0.99], [0, 1]],
  bat: [[0, 0], [0.42, 0], [0.42, 0.03], [0.22, 0.05], [0.22, 0.35], [0.55, 0.65], [1, 0.9], [0.92, 1], [0, 1]],
  football: [[0, 0], [0.45, 0.06], [0.85, 0.25], [1, 0.5], [0.85, 0.75], [0.45, 0.94], [0, 1]],
  mugbody: [[0, 0], [1, 0], [1, 1], [0.86, 1], [0.86, 0.08], [0, 0.08]],
  glass: [[0, 0], [0.8, 0], [1, 1], [0.92, 1], [0.73, 0.1], [0, 0.1]],
  plate: [[0, 0], [0.6, 0], [1, 0.75], [1, 1], [0.94, 1], [0.58, 0.32], [0, 0.32]],
  cauldron: [[0, 0], [0.4, 0], [0.88, 0.25], [1, 0.55], [0.86, 0.9], [0.92, 1], [0.8, 1], [0.76, 0.9], [0.86, 0.55], [0.76, 0.3], [0.35, 0.12], [0, 0.12]],
  bottle: [[0, 0], [1, 0], [1, 0.6], [0.92, 0.66], [0.4, 0.8], [0.4, 0.94], [0.48, 0.95], [0.48, 1], [0, 1]],
  candle: [[0, 0], [1, 0], [1, 0.98], [0.3, 0.98], [0.3, 1], [0, 1]],
  funnel: [[0, 0], [0.24, 0], [0.24, 0.45], [1, 1], [0.9, 1], [0.16, 0.48], [0.16, 0.06], [0, 0.06]],
  ogive: [[0, 0], ...Array.from({ length: 16 }, (_, i) => { const y = i / 16; return [Math.round(Math.sqrt(Math.max(0, 1 - y * y)) * (1 - 0.25 * y * y) * 1000) / 1000, y]; }), [0, 1]],
  heartspin: [[0, 0], [0.35, 0.08], [0.8, 0.35], [1, 0.62], [0.9, 0.88], [0.6, 0.98], [0.3, 0.92], [0, 0.8]],
  limpet: [[0, 0], [1, 0], [0.55, 0.65], [0.2, 0.95], [0, 1]],
  top: [[0, 0], [0.15, 0.05], [0.6, 0.3], [1, 0.45], [0.9, 0.55], [0.25, 0.62], [0.1, 0.65], [0.1, 1], [0, 1]],
  pot: [[0, 0], [0.75, 0], [1, 1], [0, 1]],
};
const pip = (x, y, z) => ({ type: "sphere", steps: 8, w: 3.6, d: 3.6, h: 3.6, x, y, z, hole: true });
Object.assign(KITS, {
  dice: () => {
    const S = 16, o = 4.2, c = S / 2 - 1.8, out = [{ type: "roundedbox", radius: 1.6, w: S, d: S, h: S, color: WHITE }];
    const P = { 1: [[0, 0]], 2: [[-o, -o], [o, o]], 3: [[-o, -o], [0, 0], [o, o]], 4: [[-o, -o], [o, -o], [-o, o], [o, o]], 5: [[-o, -o], [o, -o], [0, 0], [-o, o], [o, o]], 6: [[-o, -o], [o, -o], [-o, 0], [o, 0], [-o, o], [o, o]] };
    P[1].forEach(([a, b]) => out.push(pip(a, S - 1.8, b)));
    P[6].forEach(([a, b]) => out.push(pip(a, -1.8, b)));
    P[2].forEach(([a, b]) => out.push(pip(a, c + b, S / 2)));
    P[5].forEach(([a, b]) => out.push(pip(a, c + b, -S / 2)));
    P[3].forEach(([a, b]) => out.push(pip(S / 2, c + a, b)));
    P[4].forEach(([a, b]) => out.push(pip(-S / 2, c + a, b)));
    return out;
  },
  brick2x2: () => [{ type: "box", w: 15.8, d: 15.8, h: 9.6, color: RED }, ...[[-4, -4], [4, -4], [-4, 4], [4, 4]].map(([x, z]) => ({ type: "cylinder", w: 4.8, d: 4.8, h: 1.8, x, z, y: 9.6, color: RED })),
    { type: "box", w: 12.6, d: 12.6, h: 8.4, y: -0.1, hole: true }],
  soccer: () => [{ type: "polyhedron", kind: "truncicosa", w: 22, d: 22, h: 22, color: WHITE }],
  trophy: () => [{ type: "box", w: 16, d: 16, h: 6, color: DARK }, spunPart(P3.trophy, { w: 22, d: 22, h: 26, y: 6, color: GOLD }),
    { type: "torus", tube: 25, t: 90, w: 10, d: 12, h: 2, x: -11, y: 25, z: -1, color: GOLD }, { type: "torus", tube: 25, t: 90, w: 10, d: 12, h: 2, x: 11, y: 25, z: -1, color: GOLD }],
  skateboard: () => [{ type: "roundedbox", radius: 1, w: 18, d: 60, h: 2, y: 6, color: "#1f8fe5" },
    ...[[-1, -22], [1, -22], [-1, 22], [1, 22]].map(([a, z]) => ({ type: "cylinder", l: 90 * a, w: 5, d: 5, h: 3, x: a * 8, y: 2.5, z, color: WHITE })),
    { type: "box", w: 14, d: 3, h: 3, y: 3, z: -22, color: SILVER }, { type: "box", w: 14, d: 3, h: 3, y: 3, z: 22, color: SILVER }],
  balloon: () => [spunPart(P3.balloon, { w: 24, d: 24, h: 30, color: GREEN }), { type: "cylinder", w: 0.8, d: 0.8, h: 20, y: -20, color: DARK }],
  bat: () => [spunPart(P3.bat, { t: 90, w: 7, d: 7, h: 70, y: 3.5, z: -35, color: "#e0b98a" })],
  football: () => [spunPart(P3.football, { t: 90, w: 18, d: 18, h: 28, y: 9, z: -14, color: "#7a3f1d" }), { type: "box", w: 1.2, d: 10, h: 1.2, y: 17.6, color: WHITE }],
  basketball: () => [{ type: "sphere", w: 24, d: 24, h: 24, color: ORANGE }, { type: "torus", tube: 4, w: 24.3, d: 24.3, h: 0.8, y: 11.6, color: DARK },
    { type: "torus", tube: 4, t: 90, w: 24.3, d: 24.3, h: 0.8, y: 12, z: -0.4, color: DARK }],
  tennis: () => [{ type: "sphere", w: 7, d: 7, h: 7, color: "#d9ef4a" }],
  paddle: () => [{ type: "cylinder", w: 16, d: 16, h: 1.2, color: RED }, { type: "box", w: 3, d: 10, h: 2.4, z: 12, y: -0.6, color: WOOD }],
  drum: () => [{ type: "cylinder", w: 30, d: 30, h: 20, color: RED }, { type: "cylinder", w: 30.6, d: 30.6, h: 2, color: WHITE }, { type: "cylinder", w: 30.6, d: 30.6, h: 2, y: 18, color: WHITE },
    { type: "cylinder", w: 29.5, d: 29.5, h: 0.4, y: 20, color: CREAM }],
  // the yellow core comes first, so the cut-out face shows yellow, as if lit from inside
  jackolantern: () => [{ type: "sphere", steps: 16, w: 16, d: 16, h: 12, y: 3, color: "#ffd23f" },
    ...around(6, 4, (x, z, a) => ({ type: "sphere", steps: 14, w: 14, d: 22, h: 18, x, z, r: a, color: ORANGE })), { type: "cylinder", w: 3, d: 3, h: 6, y: 16, t: 10, color: GREEN },
    // eyes and nose: triangles pointing up; mouth: a wide grin with turned-up corners. All reach right through the skin.
    ...[-4.6, 4.6].map((x) => ({ type: "cylinder", sides: 3, w: 5.4, d: 5.4, h: 16, x, y: 11.2, z: 4, t: -90, l: 180, hole: true })),
    { type: "cylinder", sides: 3, w: 3, d: 3, h: 16, y: 8, z: 4, t: -90, l: 180, hole: true },
    { type: "box", w: 11, d: 16, h: 2.2, y: 3.4, z: 12, hole: true }, { type: "box", w: 7, d: 16, h: 1.2, y: 2.6, z: 12, hole: true },
    ...[-5.2, 5.2].map((x) => ({ type: "box", w: 2.2, d: 16, h: 1.8, x, y: 4.8, z: 12, hole: true }))],
  keyboard: () => [{ type: "box", w: 56, d: 20, h: 4, color: DARK }, ...Array.from({ length: 14 }, (_, i) => ({ type: "box", w: 3.6, d: 14, h: 1.5, x: Math.round((-25.4 + i * 3.9) * 100) / 100, y: 4, z: 2, color: WHITE })),
    ...[0, 1, 3, 4, 5, 7, 8, 10, 11, 12].map((i) => ({ type: "box", w: 2.2, d: 8, h: 1.5, x: Math.round((-23.45 + i * 3.9) * 100) / 100, y: 5.5, z: -1, color: DARK }))],
  flag: () => [{ type: "cylinder", w: 1.6, d: 1.6, h: 40, color: SILVER },
    ...Array.from({ length: 16 }, (_, i) => ({ type: "box", w: 5, d: 1, h: 5, x: 3.3 + (i % 4) * 5, y: 20 + Math.floor(i / 4) * 5, color: (i + Math.floor(i / 4)) % 2 ? WHITE : DARK }))],
  controller: () => [{ type: "roundedbox", radius: 3, w: 40, d: 22, h: 7, color: DARK }, { type: "cylinder", w: 12, d: 12, h: 7, x: -16, z: 6, color: DARK }, { type: "cylinder", w: 12, d: 12, h: 7, x: 16, z: 6, color: DARK },
    { type: "box", w: 7, d: 2.2, h: 1, x: -11, y: 7, color: "#9aa0a8" }, { type: "box", w: 2.2, d: 7, h: 1, x: -11, y: 7, color: "#9aa0a8" },
    ...[[11, -2.5, GREEN], [14, 0, RED], [11, 2.5, "#1f8fe5"], [8, 0, YELLOW]].map(([x, z, c]) => ({ type: "cylinder", w: 2.4, d: 2.4, h: 1, x, z, y: 7, color: c }))],
  hammer: () => [{ type: "box", w: 3.4, d: 40, h: 3.4, z: 4, y: 0.1, color: WOOD }, { type: "box", w: 16, d: 6, h: 6, z: -17, y: -1.2, color: SILVER }],
  toybox: () => [{ type: "box", w: 40, d: 26, h: 22, color: "#1f8fe5" }, { type: "box", w: 34, d: 20, h: 21, y: 2, hole: true }, { type: "box", w: 40.4, d: 3, h: 3, y: 9, z: 12, color: YELLOW }],
  // everyday objects
  pencil: () => [{ type: "polygon", sides: 6, t: 90, w: 7, d: 7, h: 70, y: 3.5, z: -38, color: YELLOW }, { type: "cone", t: 90, w: 7, d: 7, h: 8, y: 3.5, z: 32, color: "#e8c89a" },
    { type: "cone", t: 90, w: 2, d: 2, h: 2.6, y: 3.5, z: 37.4, color: DARK }, { type: "cylinder", t: 90, w: 7, d: 7, h: 6, y: 3.5, z: -44, color: PINK }],
  crayon: () => [{ type: "cylinder", t: 90, w: 8, d: 8, h: 80, y: 4, z: -44, color: PURPLE }, { type: "cone", top: 30, t: 90, w: 8, d: 8, h: 9, y: 4, z: 36, color: PURPLE },
    { type: "cylinder", t: 90, w: 8.2, d: 8.2, h: 50, y: 4, z: -32, color: WHITE }],
  pen: () => [{ type: "cylinder", t: 90, w: 9, d: 9, h: 110, y: 4.5, z: -58, color: "#1f8fe5" }, { type: "cone", top: 25, t: 90, w: 9, d: 9, h: 10, y: 4.5, z: 52, color: WHITE }, { type: "box", w: 1.6, d: 40, h: 2, y: 9, z: -38, color: SILVER }],
  tack: () => [{ type: "cone", w: 1.2, d: 1.2, h: 9, fy: -1, y: -9, color: SILVER }, { type: "cylinder", w: 10, d: 10, h: 1.5, color: "#1f8fe5" }, { type: "cone", top: 70, w: 6, d: 6, h: 6, y: 1.5, color: "#1f8fe5" },
    { type: "cylinder", w: 8, d: 8, h: 2, y: 7.5, color: "#1f8fe5" }],
  mug: () => [spunPart(P3.mugbody, { w: 30, d: 30, h: 36, color: WHITE }), { type: "torus", tube: 22, t: 90, w: 20, d: 22, h: 4.5, x: 16, y: 18, z: -2.25, color: WHITE }],
  glass: () => [spunPart(P3.glass, { w: 28, d: 28, h: 40, color: "#cfe6ff", clear: true })],
  plate: () => [spunPart(P3.plate, { w: 60, d: 60, h: 6, color: WHITE })],
  apple: () => [{ type: "sphere", w: 26, d: 26, h: 24, color: RED }, { type: "cylinder", w: 2, d: 2, h: 7, y: 22, t: 10, color: BROWN }, { type: "sphere", w: 8, d: 3, h: 1.5, x: 4, y: 26, r: 30, color: GREEN }],
  orange: () => [{ type: "sphere", w: 26, d: 26, h: 25, color: ORANGE }, { type: "cylinder", w: 3, d: 3, h: 1.4, y: 24.5, color: GREEN }],
  watermelon: () => [{ type: "sphere", w: 30, d: 40, h: 30, color: "#1f7a36" }],
  pineapple: () => [{ type: "sphere", w: 22, d: 22, h: 30, color: "#d9a420" }, ...around(7, 2, (x, z, a) => ({ type: "cone", w: 4, d: 2, h: 16, x, z, y: 26, r: a, t: 22, color: GREEN }))],
  // holes break through the top, both cut sides and the rind, so they show (centre x, y, z and size)
  cheese: () => { const sl = slicePart(45, 15); return [sl(30, 0, { h: 16, color: "#f7d046" }), ...[[0, 16, -2, 6], [3, 16, -9, 5], [8.3, 8, -5, 6], [-5.4, 4.5, 2, 5], [0, 10, -15, 6], [-4, 4, -14.6, 4.5], [-10.3, 12, -10, 4.5]].map(([x, cy, z, d]) => ({ type: "sphere", w: d, d, h: d, x, y: cy - d / 2, z, hole: true }))]; },
  popsicle: () => [{ type: "roundedbox", radius: 4, w: 20, d: 8, h: 34, y: 14, color: ORANGE }, { type: "box", w: 6, d: 1.6, h: 22, color: "#e8c89a" }],
  phone: () => [{ type: "roundedbox", radius: 3, w: 36, d: 74, h: 8, color: DARK }, { type: "box", w: 32, d: 66, h: 0.4, y: 8, color: "#2a72c8" }],
  laptop: () => [{ type: "box", w: 60, d: 40, h: 3, color: SILVER }, { type: "box", w: 52, d: 16, h: 0.4, y: 3, z: -6, color: DARK }, { type: "box", w: 60, d: 2, h: 38, z: -20, y: 2.4, t: -15, color: SILVER }],
  headphones: () => { const sl = slicePart(180, 0); return [{ ...sl(26, 88, { h: 4, color: DARK }), t: 90, y: 18, z: -2 }, { type: "cylinder", l: 90, w: 14, d: 14, h: 6, x: -20, y: 4, color: "#1f8fe5" }, { type: "cylinder", l: -90, w: 14, d: 14, h: 6, x: 20, y: 4, color: "#1f8fe5" }]; },
  clock: () => [{ type: "cylinder", t: 90, w: 30, d: 30, h: 10, y: 15, z: -5, color: RED }, { type: "cylinder", t: 90, w: 25, d: 25, h: 0.6, y: 15, z: 5, color: WHITE },
    { type: "halfsphere", w: 10, d: 10, h: 5, x: -9, y: 28, color: RED }, { type: "halfsphere", w: 10, d: 10, h: 5, x: 9, y: 28, color: RED },
    { type: "box", w: 1.4, d: 0.6, h: 9, y: 15, z: 5.6, color: DARK }, { type: "box", w: 7, d: 0.6, h: 1.4, x: 3.5, y: 14.3, z: 5.6, color: DARK }],
  toiletroll: () => [{ type: "tube", wall: 34, w: 40, d: 40, h: 40, color: WHITE }],
  bottle: () => [spunPart(P3.bottle, { w: 26, d: 26, h: 80, clear: true, color: "#7cc0ff" }), { type: "cylinder", w: 14, d: 14, h: 6, y: 80, color: "#1f8fe5" }],
  milk: () => [{ type: "box", w: 30, d: 30, h: 60, color: WHITE }, { type: "roof", w: 30, d: 30, h: 12, y: 60, color: WHITE }, { type: "box", w: 30.2, d: 30.2, h: 20, y: 18, color: "#1f8fe5" }],
  sticky: () => [{ type: "box", w: 30, d: 30, h: 8, color: "#ffef7a" }],
  eraser: () => [{ type: "roundedbox", radius: 1, w: 30, d: 12, h: 8, color: PINK }],
  ruler: () => [{ type: "box", w: 150, d: 25, h: 1.6, color: YELLOW }, ...Array.from({ length: 15 }, (_, i) => ({ type: "box", w: 0.6, d: i % 5 ? 4 : 7, h: 0.3, x: -70 + i * 10, z: -12.5 + (i % 5 ? 2 : 3.5), y: 1.6, color: DARK }))],
  screwdriver: () => [{ type: "cylinder", sides: 8, t: 90, w: 14, d: 14, h: 40, y: 7, z: -40, color: RED }, { type: "cylinder", t: 90, w: 4, d: 4, h: 50, y: 7, z: 0, color: SILVER }, { type: "box", w: 5, d: 6, h: 1, y: 6.5, z: 50, color: SILVER }],
  comb: () => [{ type: "box", w: 70, d: 6, h: 3, z: -8, color: "#1d3a8a" }, ...Array.from({ length: 22 }, (_, i) => ({ type: "box", w: 1.5, d: 16, h: 3, x: Math.round((-33 + i * 3.15) * 100) / 100, z: 2, color: "#1d3a8a" }))],
  umbrella: () => [{ type: "cone", sides: 8, w: 60, d: 60, h: 18, y: 50, color: RED }, { type: "cylinder", w: 2, d: 2, h: 68, color: DARK }],
  candle: () => [spunPart(P3.candle, { w: 38, d: 38, h: 16, color: WHITE }), { type: "cylinder", w: 1, d: 1, h: 4, y: 15.6, color: DARK }, { type: "drop", t: 90, w: 5, d: 8, h: 2, y: 23.5, z: -1, color: "#ffb400" }],
  chest: () => [{ type: "box", w: 40, d: 24, h: 18, color: BROWN }, { type: "roundroof", r: 90, w: 24, d: 40, h: 10, y: 18, color: BROWN }, { type: "box", w: 6, d: 2, h: 8, y: 14, z: 12, color: GOLD }],
  cauldron: () => [spunPart(P3.cauldron, { w: 40, d: 40, h: 34, color: DARK }), ...around(3, 13, (x, z) => ({ type: "cylinder", w: 4, d: 4, h: 5, x, z, y: -4, color: DARK }))],
  extinguisher: () => [{ type: "capsule", w: 16, d: 16, h: 50, color: RED }, { type: "cylinder", w: 6, d: 6, h: 6, y: 48, color: DARK }, { type: "box", w: 14, d: 3, h: 2, x: 4, y: 53, color: DARK }],
  qtip: () => [{ type: "cylinder", t: 90, w: 2, d: 2, h: 60, y: 2, z: -30, color: WHITE }, { type: "capsule", t: 90, w: 4, d: 4, h: 10, y: 2, z: -36, color: WHITE }, { type: "capsule", t: 90, w: 4, d: 4, h: 10, y: 2, z: 26, color: WHITE }],
  nametag: () => [{ type: "roundedbox", radius: 3, w: 60, d: 25, h: 3, color: "#1f8fe5" }, { type: "cylinder", w: 5, d: 5, h: 5, x: -24, y: -1, hole: true }],
  baguette: () => [{ type: "capsule", t: 90, w: 12, d: 12, h: 80, y: 6, z: -40, color: "#d9a05a" }],
  // featured
  stool: () => [{ type: "cylinder", w: 26, d: 26, h: 3, y: 30, color: WOOD }, ...around(3, 9, (x, z) => ({ type: "cylinder", w: 3, d: 3, h: 30, x, z, color: WOOD }))],
  cushion: () => [{ type: "roundedbox", radius: 4, w: 30, d: 30, h: 9, color: "#c96b5a" }],
  houseplant: () => [spunPart(P3.pot, { w: 22, d: 22, h: 20, color: "#c96b3a" }), { type: "cylinder", w: 19, d: 19, h: 1, y: 19, color: BROWN },
    ...around(7, 4, (x, z, a) => ({ type: "sphere", steps: 10, w: 8, d: 22, h: 4, x, z, y: 24, r: a, t: -35, color: GREEN }))],
  arcade: () => [{ type: "box", w: 30, d: 30, h: 70, color: PURPLE }, { type: "box", w: 24, d: 2, h: 20, y: 38, z: 14.5, t: -15, color: DARK },
    { type: "box", w: 30.4, d: 10, h: 4, y: 28, z: 15, color: PURPLE }, { type: "cylinder", w: 2, d: 2, h: 6, x: -6, y: 32, z: 16, color: DARK },
    { type: "sphere", w: 4, d: 4, h: 4, x: -6, y: 37, z: 16, color: RED }, { type: "cylinder", w: 3, d: 3, h: 1, x: 4, y: 32, z: 16, color: YELLOW }],
  // sim lab
  domino: () => [{ type: "box", w: 24, d: 8, h: 48, color: WHITE }],
  dominoline: () => Array.from({ length: 20 }, (_, i) => ({ type: "box", w: 12, d: 4, h: 24, z: -95 + i * 10, color: RAINBOW[i % 6] })),
  dominocircle: () => around(24, 60, (x, z, a) => ({ type: "box", w: 4, d: 12, h: 24, x, z, r: a + 90, color: RAINBOW[Math.floor(a / 15) % 6] })),
  dominos: () => Array.from({ length: 24 }, (_, i) => {
    const t = (i / 23) * Math.PI * 2, x = Math.round(Math.sin(t) * 40 * 100) / 100, z = Math.round(((i / 23) * 160 - 80) * 100) / 100;
    const a = Math.round((Math.atan(Math.cos(t) * 40 * (Math.PI * 2) / 160) * 180) / Math.PI);
    return { type: "box", w: 12, d: 4, h: 24, x, z, r: -a, color: RAINBOW[i % 6] };
  }),
  axleconn: () => [{ type: "cylinder", w: 12, d: 12, h: 10, color: "#9aa0a8" }, { type: "plus", thick: 30, w: 5, d: 5, h: 12, y: -1, hole: true }],
  pivotconn: () => [{ type: "roundedbox", radius: 2, w: 30, d: 10, h: 5, color: "#1f8fe5" }, { type: "cylinder", w: 5, d: 5, h: 7, x: -10, y: -1, hole: true }, { type: "cylinder", w: 5, d: 5, h: 7, x: 10, y: -1, hole: true }],
  sliderconn: () => [{ type: "box", w: 14, d: 30, h: 8, color: ORANGE }, { type: "box", w: 6, d: 32, h: 5, y: 4, hole: true }],
  // generators: arrangements
  piechart: () => [[0, RED, 6], [120, "#1f8fe5", 8], [240, YELLOW, 10]].map(([r, c, h]) => {
    const a = (r * Math.PI) / 180, R = 20; // each wedge's box centre sits half a radius out from the middle, turned with it
    return { type: "pie", angle: 120, inner: 0, w: Math.round(2 * R * Math.sin(Math.PI / 3) * 100) / 100, d: R, h, r, x: Math.round(-Math.sin(a) * (R / 2) * 100) / 100, z: Math.round(-Math.cos(a) * (R / 2) * 100) / 100, color: c };
  }),
  barchart: () => [[8, RED], [18, "#1f8fe5"], [12, YELLOW], [26, GREEN]].map(([h, c], i) => ({ type: "box", w: 8, d: 8, h, x: -15 + i * 10, color: c })).concat([{ type: "box", w: 44, d: 12, h: 1.5, y: -1.5, color: DARK }]),
  heartsring: () => around(8, 22, (x, z, a) => ({ type: "heart", w: 10, d: 10, h: 4, x, z, r: a + 180, color: RED })),
  dna: () => Array.from({ length: 14 }, (_, i) => { const a = i * 0.6, y = i * 4;
    return [{ type: "sphere", steps: 8, w: 4, d: 4, h: 4, x: Math.round(Math.cos(a) * 9 * 100) / 100, y, z: Math.round(Math.sin(a) * 9 * 100) / 100, color: "#1f8fe5" },
      { type: "sphere", steps: 8, w: 4, d: 4, h: 4, x: Math.round(-Math.cos(a) * 9 * 100) / 100, y, z: Math.round(-Math.sin(a) * 9 * 100) / 100, color: RED },
      { type: "box", w: 17, d: 1.2, h: 1.2, y: y + 1.4, r: Math.round((-a * 180) / Math.PI), color: WHITE }]; }).flat(),
  projectbox: () => [{ type: "box", w: 60, d: 40, h: 30, color: "#9aa0a8" }, { type: "box", w: 56, d: 36, h: 30, y: 2, hole: true }],
  honeycomb: () => { const out = [{ type: "box", w: 50, d: 44, h: 3, color: YELLOW }]; for (let r = 0; r < 4; r++) for (let c = 0; c < 5; c++) out.push({ type: "polygon", sides: 6, w: 8.5, d: 8.5, h: 5, x: Math.round((-18.4 + c * 9.2 + (r % 2 ? 4.6 : 0)) * 100) / 100, z: -12 + r * 8, y: -1, hole: true }); return out; },
  meeple: () => [{ type: "scribble", path: [[0.5, 0], [0.62, 0.05], [0.66, 0.2], [0.62, 0.32], [0.95, 0.42], [1, 0.52], [0.9, 0.6], [0.7, 0.6], [0.9, 1], [0.6, 1], [0.5, 0.82], [0.4, 1], [0.1, 1], [0.3, 0.6], [0.1, 0.6], [0, 0.52], [0.05, 0.42], [0.38, 0.32], [0.34, 0.2], [0.38, 0.05]], w: 16, d: 16, h: 6, color: YELLOW }],
  butterfly: () => [{ type: "heart", w: 14, d: 14, h: 2, x: -6.5, r: 100, color: ORANGE }, { type: "heart", w: 14, d: 14, h: 2, x: 6.5, r: -100, color: ORANGE }, { type: "capsule", t: 90, w: 2.4, d: 2.4, h: 16, y: 1.2, z: -8, color: DARK }],
  crystal: () => [{ type: "polygon", sides: 6, w: 10, d: 10, h: 20, color: "#7cc0ff" }, { type: "pyramid", sides: 6, w: 11.5, d: 11.5, h: 7, y: 20, r: 30, color: "#7cc0ff" }],
});
// ---------- Design starters, batch 2 (our own simplified designs) ----------
// place a circle slice or curved band turned by r degrees around its point (tip) at (cx, cz)
const turnedSlice = (A, R, inner, r, extra, cx = 0, cz = 0) => {
  const half = (A * Math.PI) / 360, rr = (R * inner) / 100, near = inner ? rr * Math.cos(half) : 0, off = (R + near) / 2, a = (r * Math.PI) / 180;
  const round2 = (v) => Math.round(v * 100) / 100;
  return { type: "pie", angle: A, inner, w: round2(2 * R * Math.sin(Math.min(half, Math.PI / 2))), d: round2(R - near), r, x: round2(cx - Math.sin(a) * off), z: round2(cz - Math.cos(a) * off), ...extra };
};
const loop = (z, color) => ({ type: "torus", tube: 30, w: 7, d: 7, h: 2, z, color }); // a flat ring for a key ring or chain
const P4 = {
  vase: [[0, 0], [0.62, 0], [0.95, 0.3], [0.8, 0.62], [0.42, 0.82], [0.55, 1], [0.48, 1], [0.34, 0.83], [0.7, 0.62], [0.85, 0.3], [0.55, 0.05], [0, 0.05]],
  potion: [[0, 0], [0.7, 0], [1, 0.25], [0.95, 0.5], [0.45, 0.68], [0.3, 0.72], [0.3, 0.92], [0.38, 0.94], [0.38, 1], [0, 1]],
  basin: [[0, 0], [0.55, 0], [1, 0.6], [1, 1], [0.9, 1], [0.86, 0.75], [0, 0.75]],
  countersink: [[0, 0], [0.42, 0], [0.42, 0.62], [1, 1], [0, 1]],
};
const cardioid = Array.from({ length: 60 }, (_, i) => { const t = (i / 60) * Math.PI * 2, r = 1 - Math.cos(t); return [r * Math.cos(t), r * Math.sin(t)]; });
const superEllipse = Array.from({ length: 64 }, (_, i) => { const t = (i / 64) * Math.PI * 2, c = Math.cos(t), s = Math.sin(t); return [Math.sign(c) * Math.abs(c) ** 0.5, Math.sign(s) * Math.abs(s) ** 0.5]; });
const unitPath = (pts) => { const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]); const x0 = Math.min(...xs), y0 = Math.min(...ys), sx = Math.max(...xs) - x0, sy = Math.max(...ys) - y0;
  return pts.map(([x, y]) => [Math.round(((x - x0) / sx) * 1000) / 1000, Math.round(((y - y0) / sy) * 1000) / 1000]); };
Object.assign(KITS, {
  snowflake: () => [{ type: "cylinder", sides: 6, w: 7, d: 7, h: 2, color: "#7cc0ff" },
    ...around(6, 9, (x, z, a) => ({ type: "box", w: 2, d: 18, h: 2, x, z, r: a, color: "#7cc0ff" })),
    ...around(6, 11, (x, z, a) => ({ type: "box", w: 1.6, d: 7, h: 2, x: x + Math.cos((a * Math.PI) / 180) * 2.2, z: z - Math.sin((a * Math.PI) / 180) * 2.2, r: a + 50, color: "#7cc0ff" })),
    ...around(6, 11, (x, z, a) => ({ type: "box", w: 1.6, d: 7, h: 2, x: x - Math.cos((a * Math.PI) / 180) * 2.2, z: z + Math.sin((a * Math.PI) / 180) * 2.2, r: a - 50, color: "#7cc0ff" }))],
  atom: () => [{ type: "sphere", w: 8, d: 8, h: 8, y: 11, color: RED },
    ...[0, 60, 120].map((r) => ({ type: "torus", tube: 7, t: 90, r, w: 30, d: 12, h: 1.4, y: 15, z: 0, color: "#1f8fe5" }))],
  tesseract: () => {
    const frame = (L, t, y0, color) => { const o = (L - t) / 2, out = []; for (const a of [-o, o]) for (const b of [-o, o]) {
      out.push({ type: "box", w: t, d: t, h: L, x: a, z: b, y: y0, color }); out.push({ type: "box", w: L, d: t, h: t, z: a, y: y0 + b + o, color }); out.push({ type: "box", w: t, d: L, h: t, x: a, y: y0 + b + o, color }); }
      return out; };
    const bars = []; for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      const t = (Math.acos(sy / Math.sqrt(3)) * 180) / Math.PI, r = (Math.atan2(sx, sz) * 180) / Math.PI;
      bars.push({ type: "box", w: 1.6, d: 1.6, h: 15.6, x: sx * 6, y: 15 + sy * 6, z: sz * 6, t: Math.round(t * 100) / 100, r: Math.round(r * 100) / 100, color: "#8a4fd8" }); }
    return [...frame(30, 2.2, 0, "#8a4fd8"), ...frame(12, 1.6, 9, "#e8306e"), ...bars];
  },
  planetcharm: () => [{ type: "sphere", w: 14, d: 14, h: 14, color: "#f08a1c" }, { type: "torus", tube: 12, w: 26, d: 26, h: 1.6, y: 6.2, t: 18, color: YELLOW }, { type: "torus", tube: 30, t: 90, w: 7, d: 7, h: 2, y: 16.5, z: -1, color: YELLOW }],
  atomcharm: () => [{ type: "cylinder", w: 26, d: 26, h: 2, color: "#16b6b0" }, ...[0, 60, 120].map((r) => ({ type: "torus", tube: 12, r, w: 20, d: 8, h: 1.6, y: 2, color: WHITE })),
    { type: "sphere", w: 4, d: 4, h: 4, y: 1.8, color: RED }, loop(-14, "#16b6b0")],
  robocharm: () => [{ type: "roundedbox", radius: 2, w: 20, d: 18, h: 4, color: SILVER }, { type: "cylinder", w: 5, d: 5, h: 1, x: -4.5, z: -1, y: 4, color: "#5ec8ff" }, { type: "cylinder", w: 5, d: 5, h: 1, x: 4.5, z: -1, y: 4, color: "#5ec8ff" },
    { type: "box", w: 9, d: 2, h: 1, z: 5, y: 4, color: DARK }, loop(-11.5, SILVER)],
  starcharm: () => [{ type: "star", w: 24, d: 24, h: 3, color: GOLD }, loop(-13.5, GOLD)],
  radiation: () => [{ type: "cylinder", w: 34, d: 34, h: 2, color: YELLOW }, { type: "cylinder", w: 6, d: 6, h: 1, y: 2, color: DARK },
    ...[0, 120, 240].map((r) => turnedSlice(60, 15, 30, r, { h: 1, y: 2, color: DARK }))],
  kapow: () => [{ type: "star", points: 12, inner: 62, w: 44, d: 34, h: 3, color: YELLOW }, { type: "star", points: 12, inner: 62, w: 36, d: 27, h: 1, y: 3, color: RED }],
  fries: () => [{ type: "cone", sides: 4, top: 135, w: 18, d: 12, h: 18, r: 45, color: RED },
    ...[[-4, -2, 26, 10], [-1, 1, 30, -6], [2, -1, 28, 8], [5, 1, 25, -4], [0, -3, 24, 4], [3, 3, 27, -9], [-3, 2, 29, 6]].map(([x, z, h, r]) => ({ type: "box", w: 2.4, d: 2.4, h, x, z, y: 4, r, t: r / 2, color: "#f7d046" }))],
  multitri: () => [{ type: "polygon", sides: 3, w: 30, d: 30, h: 3, color: "#1f8fe5" }, { type: "polygon", sides: 3, w: 30, d: 30, h: 3, r: 180, y: 0.01, color: "#1f8fe5" },
    { type: "polygon", sides: 3, w: 18, d: 18, h: 5, y: -1, hole: true }, { type: "polygon", sides: 3, w: 18, d: 18, h: 5, r: 180, y: -1, hole: true }],
  border: () => [{ type: "tube", wall: 8, w: 50, d: 50, h: 3, color: GOLD }, ...around(24, 24.5, (x, z) => ({ type: "sphere", steps: 8, w: 3.4, d: 3.4, h: 3.4, x, z, y: 1, color: GOLD }))],
  doubletorus: () => [{ type: "torus", tube: 30, w: 26, d: 26, h: 7, x: -9, color: "#16b6b0" }, { type: "torus", tube: 30, w: 26, d: 26, h: 7, x: 9, color: "#16b6b0" }],
  tripletorus: () => around(3, 9, (x, z) => ({ type: "torus", tube: 30, w: 24, d: 24, h: 7, x, z, color: "#e8306e" })),
  sphericHelix: () => Array.from({ length: 30 }, (_, i) => { const t = i / 29, a = t * Math.PI * 6, rr = Math.sin(t * Math.PI) * 14;
    return { type: "sphere", steps: 8, w: 4, d: 4, h: 4, x: Math.round(Math.cos(a) * rr * 100) / 100, y: Math.round(t * 28 * 100) / 100, z: Math.round(Math.sin(a) * rr * 100) / 100, color: "#8a4fd8" }; }),
  fountain: () => [spunPart(P4.basin, { w: 50, d: 50, h: 10, color: "#c4b8a8" }), { type: "cylinder", w: 7, d: 7, h: 20, y: 7, color: "#c4b8a8" },
    spunPart(P4.basin, { w: 26, d: 26, h: 6, y: 26, color: "#c4b8a8" }), { type: "cylinder", w: 46, d: 46, h: 1, y: 7, color: "#7cc0ff" }, { type: "cylinder", w: 22, d: 22, h: 1, y: 30, color: "#7cc0ff" },
    { type: "drop", t: 0, w: 4, d: 4, h: 6, y: 31, color: "#7cc0ff" }],
  penny: () => [{ type: "cylinder", w: 19, d: 19, h: 1.5, color: "#c47a3a" }, { type: "tube", wall: 6, w: 19, d: 19, h: 1.8, color: "#c47a3a" }, { type: "cylinder", w: 8, d: 8, h: 0.4, y: 1.5, color: "#b36a2c" }],
  signet: () => [{ type: "tube", wall: 12, t: 90, w: 22, d: 22, h: 6, y: 11, z: -3, color: GOLD }, { type: "roundedbox", radius: 1, w: 12, d: 6, h: 3, y: 20.5, color: GOLD }],
  cashregister: () => [{ type: "box", w: 40, d: 30, h: 10, color: DARK }, { type: "box", w: 34, d: 18, h: 8, y: 10, z: -4, t: -20, color: SILVER },
    ...Array.from({ length: 12 }, (_, i) => ({ type: "box", w: 4, d: 3, h: 1.5, x: -9 + (i % 4) * 6, z: -8 + Math.floor(i / 4) * 4.5, y: 14, color: WHITE })),
    { type: "box", w: 14, d: 3, h: 9, y: 18, z: -14, color: DARK }, { type: "box", w: 12, d: 0.4, h: 5, y: 20, z: -12.4, color: "#5ec8ff" }, { type: "box", w: 30, d: 1, h: 3, y: 3, z: 15, color: SILVER }],
  shopcounter: () => [{ type: "box", w: 60, d: 20, h: 30, color: WOOD }, { type: "box", w: 64, d: 24, h: 2, y: 30, color: "#c49a6a" }, { type: "box", w: 50, d: 1, h: 18, y: 6, z: 10.2, color: "#8c5a30" }],
  papers: () => Array.from({ length: 8 }, (_, i) => ({ type: "box", w: 30, d: 21, h: 0.6, y: i * 0.62, r: ((i * 37) % 9) - 4, color: WHITE })),
  cloudballoon: () => [...KITS.cloud().map((c) => ({ ...c, color: WHITE })), { type: "sphere", w: 5, d: 5, h: 5, x: -10, z: 13, color: WHITE }, { type: "sphere", w: 3, d: 3, h: 3, x: -14, z: 17, color: WHITE }],
});
// ---------- Electronics, batch 2: families of LEDs, displays and small sensor boards (generic, our own designs) ----------
const GOLDPIN = "#c4a24a";
const ledOf = (dia, color) => () => [
  { type: "cylinder", w: dia * 1.16, d: dia * 1.16, h: dia * 0.2, color },
  { type: "cylinder", w: dia, d: dia, h: dia * 1.2, y: dia * 0.2, color },
  { type: "halfsphere", w: dia, d: dia, h: dia / 2, y: dia * 1.4, color },
  { type: "box", w: 0.5, d: 0.5, h: 17, x: -dia * 0.25, y: -17, color: GREY }, { type: "box", w: 0.5, d: 0.5, h: 15, x: dia * 0.25, y: -15, color: GREY }];
// a small sensor or module board, with a row of header pins along one edge
const board = (w, d, color = BLUE_PCB, pins = 3) => [{ type: "box", w, d, h: 1.6, color },
  ...Array.from({ length: pins }, (_, i) => ({ type: "box", w: 0.64, d: 0.64, h: 6, x: Math.round((-(pins - 1) * 1.27 + i * 2.54) * 100) / 100, z: -d / 2 + 1.5, y: -6, color: GOLDPIN }))];
const segDigits = (n) => () => {
  const W = 12.6, out = [{ type: "box", w: W * n, d: 19, h: 8, color: DARK }];
  for (let k = 0; k < n; k++) {
    const cx = -W * (n - 1) / 2 + k * W;
    [-7, 0, 7].forEach((z) => out.push({ type: "box", w: 6, d: 1.2, h: 0.3, x: cx, z, y: 8, color: RED }));
    [[-3.5, -3.5], [3.5, -3.5], [-3.5, 3.5], [3.5, 3.5]].forEach(([x, z]) => out.push({ type: "box", w: 1.2, d: 6, h: 0.3, x: cx + x, z, y: 8, color: RED }));
  }
  return out;
};
const screenOf = (w, d, sw, sd, color = BLUE_PCB, glass = "#2a72c8") => () => [...board(w, d, color, 4), { type: "box", w: sw, d: sd, h: 1.4, y: 1.6, z: 1.5, color: DARK }, { type: "box", w: sw - 2, d: sd - 2, h: 0.2, y: 3, z: 1.5, color: glass }];
const servoOf = (scale, horn) => () => {
  const k = scale, out = [{ type: "box", w: 22.5 * k, d: 12 * k, h: 22.7 * k, color: DARK }, { type: "box", w: 32.5 * k, d: 12 * k, h: 2.5 * k, y: 15.9 * k, color: DARK },
    { type: "cylinder", w: 11.8 * k, d: 11.8 * k, h: 4 * k, x: 5.35 * k, y: 22.7 * k, color: DARK }, { type: "cylinder", w: 4.8 * k, d: 4.8 * k, h: 3 * k, x: 5.35 * k, y: 26.7 * k, color: WHITE }];
  if (horn === "disc") out.push({ type: "cylinder", w: 20 * k, d: 20 * k, h: 1.5 * k, x: 5.35 * k, y: 29.7 * k, color: SILVER });
  else out.push({ type: "box", w: 20 * k, d: 5 * k, h: 1.5 * k, x: 5.35 * k, y: 29.7 * k, color: WHITE }, { type: "box", w: 5 * k, d: 20 * k, h: 1.5 * k, x: 5.35 * k, y: 29.75 * k, color: WHITE });
  return out;
};
Object.assign(KITS, {
  led3red: ledOf(3, RED), led3green: ledOf(3, GREEN), led3blue: ledOf(3, "#1f8fe5"), led3yellow: ledOf(3, YELLOW),
  led10red: ledOf(10, RED), led10green: ledOf(10, GREEN), led10blue: ledOf(10, "#1f8fe5"), led10yellow: ledOf(10, YELLOW),
  ledrgb: () => [...ledOf(5, "#f4f6f8")().slice(0, 3).map((p) => ({ ...p, clear: true })), ...[-1.9, -0.63, 0.63, 1.9].map((x, i) => ({ type: "box", w: 0.5, d: 0.5, h: 15 + (i === 1 ? 2 : 0), x, y: -15 - (i === 1 ? 2 : 0), color: GREY }))],
  smdled: () => [{ type: "box", w: 5, d: 5, h: 1.6, color: WHITE }, { type: "cylinder", w: 3.8, d: 3.8, h: 0.2, y: 1.6, color: "#fff7d6" }],
  ledstrip: () => [{ type: "box", w: 100, d: 10, h: 0.6, color: WHITE }, ...Array.from({ length: 6 }, (_, i) => ({ type: "box", w: 5, d: 5, h: 1.4, x: -41.5 + i * 16.6, y: 0.6, color: "#f4f6f8" }))],
  seg1: segDigits(1), seg3: segDigits(3), seg4: segDigits(4),
  hornplastic: () => [{ type: "cylinder", w: 7, d: 7, h: 4, color: WHITE }, { type: "box", w: 32, d: 5, h: 1.6, color: WHITE }, { type: "box", w: 5, d: 22, h: 1.6, color: WHITE },
    ...[-13, -8, 8, 13].map((x) => ({ type: "cylinder", w: 1.2, d: 1.2, h: 3, x, y: -1, hole: true }))],
  hornmetal: () => [{ type: "cylinder", w: 24, d: 24, h: 2.5, color: "#3a6fd8" }, { type: "cylinder", w: 8, d: 8, h: 5, color: "#3a6fd8" },
    ...around(8, 8.5, (x, z) => ({ type: "cylinder", w: 2.2, d: 2.2, h: 4, x, z, y: -1, hole: true }))],
  servostd: servoOf(1.75, "cross"), servostdmetal: servoOf(1.75, "disc"), servocont: servoOf(1.75, "cross"),
  minimotor: () => [{ type: "box", w: 12, d: 10, h: 9, color: SILVER }, { type: "cylinder", t: 90, w: 10, d: 10, h: 15, y: 4.5, z: 5, color: SILVER },
    { type: "box", l: 90, w: 3, d: 2.5, h: 9, x: -6, y: 4.5, color: SILVER }],
  vibemotor: () => [{ type: "cylinder", w: 10, d: 10, h: 3, color: SILVER }, { type: "box", w: 0.3, d: 15, h: 0.3, x: -1, z: 8, y: 1, color: RED }, { type: "box", w: 0.3, d: 15, h: 0.3, x: 1, z: 8, y: 1, color: "#1f8fe5" }],
  laser: () => [{ type: "cylinder", t: 90, w: 6, d: 6, h: 14, y: 3, z: -7, color: "#c49a4a" }, { type: "cylinder", t: 90, w: 2.4, d: 2.4, h: 0.4, y: 3, z: 7, color: RED }],
  ldr: () => [{ type: "cylinder", w: 5, d: 5, h: 2, color: "#d97b2a" }, { type: "box", w: 0.5, d: 0.5, h: 25, x: -1.5, y: -25, color: GREY }, { type: "box", w: 0.5, d: 0.5, h: 25, x: 1.5, y: -25, color: GREY }],
  reed: () => [{ type: "capsule", t: 90, w: 2.4, d: 2.4, h: 14, y: 1.2, z: -7, clear: true, color: "#cfe6ff" }, { type: "box", w: 0.5, d: 30, h: 0.5, y: 1, color: SILVER }],
  reedalarm: () => [{ type: "roundedbox", radius: 1, w: 28, d: 14, h: 8, color: WHITE }, { type: "roundedbox", radius: 1, w: 28, d: 10, h: 8, z: 15, color: WHITE }],
  irsensor: () => [...board(32, 14, BLUE_PCB, 3), { type: "cylinder", t: 90, w: 5, d: 5, h: 6, x: -3, y: 4.1, z: 7, color: DARK }, { type: "cylinder", t: 90, w: 5, d: 5, h: 6, x: 3, y: 4.1, z: 7, color: "#cfe6ff" },
    { type: "box", w: 6, d: 7, h: 4, x: 8, z: -2, y: 1.6, color: "#1f8fe5" }],
  pir: () => [...board(32, 24, GREEN_PCB, 3), { type: "box", w: 23, d: 23, h: 2, y: 1.6, color: WHITE }, { type: "halfsphere", w: 23, d: 23, h: 12, y: 3.6, color: WHITE }],
  dht11: () => [...board(28, 14, BLUE_PCB, 3), { type: "box", w: 12, d: 15.5, h: 5.5, y: 1.6, x: 6, color: "#3a8fe5" }],
  dht22: () => [{ type: "box", w: 15, d: 25, h: 7.7, color: WHITE }, ...Array.from({ length: 12 }, (_, i) => ({ type: "box", w: 1.6, d: 1.6, h: 3, x: -4.5 + (i % 4) * 3, z: -6 + Math.floor(i / 4) * 3, y: 5.5, hole: true })),
    ...Array.from({ length: 4 }, (_, i) => ({ type: "box", w: 0.6, d: 8, h: 0.4, x: -3.8 + i * 2.54, z: 16, y: 1, color: GOLDPIN }))],
  gassensor: () => [...board(32, 22, BLUE_PCB, 4), { type: "cylinder", w: 18, d: 18, h: 13, y: 1.6, color: SILVER }, { type: "cylinder", w: 16, d: 16, h: 0.6, y: 14.6, color: "#6b7280" }],
  soilprobe: () => [{ type: "box", w: 20, d: 12, h: 1.6, color: "#1f5fbf" }, { type: "box", w: 5, d: 40, h: 1.6, x: -6, z: 26, color: "#1f5fbf" }, { type: "box", w: 5, d: 40, h: 1.6, x: 6, z: 26, color: "#1f5fbf" },
    { type: "box", w: 3, d: 38, h: 0.2, x: -6, z: 26, y: 1.6, color: GOLDPIN }, { type: "box", w: 3, d: 38, h: 0.2, x: 6, z: 26, y: 1.6, color: GOLDPIN }],
  soilcap: () => [{ type: "box", w: 22, d: 98, h: 1.6, color: DARK }, { type: "pie", angle: 60, w: 22, d: 19, h: 1.6, z: 58.5, r: 180, color: DARK }, { type: "box", w: 14, d: 10, h: 3, y: 1.6, z: -38, color: DARK }],
  encoder: () => [...board(26, 19, BLUE_PCB, 5), { type: "box", w: 12, d: 12, h: 6, y: 1.6, color: SILVER }, { type: "cylinder", w: 7, d: 7, h: 4, y: 7.6, color: SILVER }, { type: "gear", teeth: 20, w: 6, d: 6, h: 12, y: 11.6, color: SILVER }],
  accel: () => [...board(20, 16, "#8a4fd8", 6), { type: "box", w: 4, d: 4, h: 1, y: 1.6, color: DARK }],
  bluetooth: () => [...board(37, 16, BLUE_PCB, 6), { type: "box", w: 27, d: 13, h: 2.2, y: 1.6, x: 3, color: GREEN_PCB }, { type: "box", w: 4, d: 3, h: 1.5, x: -13, y: 1.6, color: DARK }],
  l298n: () => [...board(43, 43, RED, 0), { type: "box", w: 25, d: 15, h: 23, y: 1.6, z: -10, color: DARK }, ...Array.from({ length: 6 }, (_, i) => ({ type: "box", w: 1.5, d: 15, h: 6, x: -10 + i * 4, z: -10, y: 24.6, color: DARK })),
    { type: "box", w: 10, d: 8, h: 10, x: -14, y: 1.6, z: 14, color: "#1f8fe5" }, { type: "box", w: 10, d: 8, h: 10, x: 14, y: 1.6, z: 14, color: "#1f8fe5" }, { type: "cylinder", w: 8, d: 8, h: 12, x: 10, y: 1.6, z: 0, color: DARK }],
  tp4056: () => [...board(26, 17, "#1f5fbf", 0), { type: "box", w: 8, d: 7.5, h: 3, x: -9, y: 1.6, color: SILVER }, { type: "box", w: 5, d: 4, h: 1.5, x: 2, y: 1.6, color: DARK }],
  microusb: () => [{ type: "box", w: 8, d: 6, h: 3, color: SILVER }, { type: "box", w: 6.8, d: 6, h: 1.8, y: 0.6, z: 0.5, hole: true }],
  tft: screenOf(30, 40, 28, 30), tft144: screenOf(33, 45, 30, 30, RED), oled2: screenOf(27, 28, 26, 16, DARK),
  holder2aa: () => [{ type: "box", w: 33, d: 58, h: 15, color: DARK }, { type: "cylinder", t: 90, w: 14.5, d: 14.5, h: 50.5, x: -8, y: 8.5, z: -25, color: "#1f8fe5" }, { type: "cylinder", t: 90, w: 14.5, d: 14.5, h: 50.5, x: 8, y: 8.5, z: -25, color: "#1f8fe5" }],
  holder2aaa: () => [{ type: "box", w: 26, d: 52, h: 14, color: DARK }, { type: "box", w: 4, d: 8, h: 3, y: 14, z: 18, color: WHITE }],
  mux: () => [...board(40, 18, RED, 0), { type: "box", w: 18, d: 7, h: 2, y: 1.6, color: DARK }, ...Array.from({ length: 12 }, (_, i) => ({ type: "box", w: 0.64, d: 0.64, h: 6, x: -14 + i * 2.54, z: 7.5, y: -6, color: GOLDPIN }))],
  nanoshield: () => [...board(57, 54, "#1f8fe5", 0), ...Array.from({ length: 30 }, (_, i) => ({ type: "box", w: 0.64, d: 0.64, h: 7, x: -18 + (i % 15) * 2.54, z: i < 15 ? -6 : 6, y: 1.6, color: GOLDPIN })),
    { type: "box", w: 9, d: 14, h: 11, x: -22, y: 1.6, z: 16, color: DARK }],
  minidriver: () => [...board(22, 20, "#8a4fd8", 6), { type: "box", w: 6, d: 6, h: 1.2, y: 1.6, color: DARK }],
  speedsensor: () => [...board(32, 14, BLUE_PCB, 4), { type: "box", w: 12, d: 6, h: 11, x: 8, z: 3, y: 1.6, color: DARK }, { type: "box", w: 3, d: 6.2, h: 8, x: 8, z: 3, y: 4.6, hole: true }],
  monitor: () => [{ type: "box", w: 70, d: 4, h: 42, y: 14, color: DARK }, { type: "box", w: 66, d: 0.4, h: 38, y: 16, z: 2.2, color: "#2a72c8" },
    { type: "box", w: 6, d: 4, h: 14, z: -3, color: DARK }, { type: "box", w: 26, d: 18, h: 2, z: -2, color: DARK }],
  tv: () => [{ type: "box", w: 90, d: 3, h: 52, y: 8, color: DARK }, { type: "box", w: 87, d: 0.4, h: 49, y: 9.5, z: 1.7, color: "#2a72c8" },
    { type: "box", w: 4, d: 16, h: 8, x: -32, color: DARK }, { type: "box", w: 4, d: 16, h: 8, x: 32, color: DARK }],
  calculator: () => [{ type: "roundedbox", radius: 2, w: 40, d: 70, h: 6, color: DARK }, { type: "box", w: 32, d: 14, h: 0.4, y: 6, z: -24, color: "#9ccc65" },
    ...Array.from({ length: 20 }, (_, i) => ({ type: "box", w: 6, d: 6, h: 1.2, x: -10.5 + (i % 4) * 7, z: -8 + Math.floor(i / 4) * 8, y: 6, color: i % 4 === 3 ? ORANGE : SILVER }))],
  pushbig: () => [{ type: "box", w: 12, d: 12, h: 4, color: DARK }, { type: "cylinder", w: 7, d: 7, h: 3, y: 4, color: DARK }, ...[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([a, b]) => ({ type: "box", w: 0.8, d: 0.4, h: 4, x: a * 6.25, z: b * 4.5, y: -4, color: SILVER }))],
  pushtall: () => [{ type: "box", w: 6, d: 6, h: 3.5, color: DARK }, { type: "cylinder", w: 3.5, d: 3.5, h: 8.5, y: 3.5, color: DARK }],
  dpdt: () => [{ type: "box", w: 8.5, d: 8.5, h: 9, color: DARK }, { type: "box", w: 4.4, d: 4.4, h: 4, y: 9, color: "#c4c9d0" }, ...Array.from({ length: 6 }, (_, i) => ({ type: "box", w: 0.6, d: 0.6, h: 3.5, x: -2.5 + (i % 3) * 2.5, z: i < 3 ? -2.5 : 2.5, y: -3.5, color: SILVER }))],
  irrecv: () => [...board(19, 15, DARK, 3), { type: "box", w: 6, d: 5, h: 7, y: 1.6, z: 3, color: DARK }, { type: "halfsphere", t: 90, w: 3.6, d: 3.6, h: 1.6, y: 5.5, z: 5.5, color: DARK }],
});
// ---------- Structures & scenery, batch 2 (our own simplified designs) ----------
const STONE = "#b8b0a4", GLASS = "#9fd3f5", SNOW = "#ffffff", BLOSSOM = "#f5a3c7";
// a door, standing up, facing the front: style "panels" | "glass" | "nine" | "arch" | "barn"
const doorOf = (w, h, color, style) => () => {
  const out = [{ type: "box", w, d: 2.5, h, color }];
  if (style === "panels") out.push({ type: "box", w: w * 0.7, d: 2.8, h: h * 0.35, y: h * 0.55, color: "#8c5a30" }, { type: "box", w: w * 0.7, d: 2.8, h: h * 0.35, y: h * 0.1, color: "#8c5a30" });
  if (style === "glass") out.push({ type: "box", w: w * 0.6, d: 2.8, h: h * 0.4, y: h * 0.5, color: GLASS });
  if (style === "nine") for (let i = 0; i < 9; i++) out.push({ type: "box", w: w * 0.22, d: 2.8, h: h * 0.15, x: (i % 3 - 1) * w * 0.27, y: h * 0.45 + Math.floor(i / 3) * h * 0.17, color: GLASS });
  if (style === "barn") out.push({ type: "box", w: w * 1.2, d: 2.8, h: 2.5, y: h / 2 - 1.25, r: 0, l: Math.round((Math.atan(h / w) * 180) / Math.PI), x: 0, color: "#8c5a30" }, { type: "box", w, d: 2.8, h: 2.5, y: h - 3, color: "#8c5a30" }, { type: "box", w, d: 2.8, h: 2.5, y: 0.5, color: "#8c5a30" });
  if (style === "arch") out.push({ type: "roundroof", w, d: 2.5, h: w / 2, y: h, color });
  out.push({ type: "sphere", steps: 10, w: 2.4, d: 2.4, h: 2.4, x: w * 0.35, y: h * 0.45, z: 1.6, color: GOLD });
  return out;
};
const doubleDoor = (w, h, color, style) => () => [...doorOf(w, h, color, style)().map((p) => ({ ...p, x: (p.x || 0) - w / 2 - 0.2 })), ...doorOf(w, h, color, style)().map((p) => ({ ...p, x: -(p.x || 0) + w / 2 + 0.2 }))];
// a window in a frame: cols × rows panes
const windowOf = (w, h, cols, rows, frame = WHITE) => () => {
  const out = [{ type: "frame", wall: Math.round((300 / Math.min(w, h)) * 10) / 10, t: 90, w, d: h, h: 2.5, y: h / 2, z: -1.25, color: frame }, { type: "box", w: w - 2, d: 0.6, h: h - 2, y: 1, color: GLASS, clear: true }];
  for (let i = 1; i < cols; i++) out.push({ type: "box", w: 1.4, d: 2.2, h, x: -w / 2 + (i * w) / cols, color: frame });
  for (let j = 1; j < rows; j++) out.push({ type: "box", w, d: 2.2, h: 1.4, y: (j * h) / rows - 0.7, color: frame });
  return out;
};
// one storey of a block of flats: ground (with door), middle or top (with roof edge)
const floorOf = (kind) => () => {
  const out = [{ type: "box", w: 40, d: 30, h: 20, color: "#e3c9a8" }];
  for (let i = 0; i < 3; i++) if (!(kind === "ground" && i === 1)) out.push({ type: "box", w: 8, d: 1, h: 9, x: -13 + i * 13, y: 6, z: 15, color: GLASS });
  if (kind === "ground") out.push({ type: "box", w: 8, d: 1, h: 14, y: 0, z: 15, color: BROWN }, { type: "box", w: 12, d: 6, h: 1, y: 15, z: 17, color: "#8a8f98" });
  if (kind === "top") out.push({ type: "box", w: 42, d: 32, h: 2, y: 20, color: "#8a8f98" });
  return out;
};
const streetLight = (n) => () => [{ type: "cylinder", w: 6, d: 6, h: 3, color: DARK }, { type: "cylinder", w: 2.4, d: 2.4, h: 50, color: DARK },
  ...Array.from({ length: n }, (_, i) => { const s = n === 1 ? 1 : i ? 1 : -1; return [{ type: "box", w: 14, d: 1.6, h: 1.6, x: s * 7, y: 48, color: DARK }, { type: "cone", top: 40, fy: -1, w: 8, d: 6, h: 3, x: s * 13, y: 45.5, color: DARK }, { type: "box", w: 6, d: 4, h: 0.6, x: s * 13, y: 45.4, color: "#fff2a8" }]; }).flat()];
const pointed = (w, h, t, color, thick = 3) => [ // a pointed (gothic) arch outline: two curved bands that meet at the top
  { type: "box", w: t, d: thick, h, x: -w / 2 + t / 2, color }, { type: "box", w: t, d: thick, h, x: w / 2 - t / 2, color },
  { type: "pie", angle: 60, inner: Math.round((1 - t / w) * 100), t: 90, w: Math.round(w * Math.sin(Math.PI / 6) * 2 * 100) / 100, d: w, h: thick, x: -w / 4 + w / 4, y: h, z: -thick / 2, color }];
Object.assign(KITS, {
  mountains: () => [{ type: "cone", sides: 7, w: 50, d: 40, h: 34, color: "#8a8f98" }, { type: "cone", sides: 7, w: 15.5, d: 12.4, h: 10.5, y: 23.5, color: SNOW },
    { type: "cone", sides: 6, w: 34, d: 28, h: 24, x: 22, z: 8, color: "#9aa0a8" }, { type: "cone", sides: 6, w: 11, d: 9, h: 7.8, x: 22, z: 8, y: 16.2, color: SNOW }],
  pagodaroof: () => [{ type: "pyramid", w: 48, d: 48, h: 12, color: RED }, { type: "box", w: 34, d: 34, h: 2, y: -2, color: "#8c2b1f" }, { type: "cone", w: 4, d: 4, h: 8, y: 11, color: GOLD }],
  pagodaterrace: () => [{ type: "box", w: 30, d: 30, h: 12, color: "#e3c9a8" }, { type: "pyramid", w: 46, d: 46, h: 8, y: 12, color: RED }, { type: "box", w: 22, d: 22, h: 8, y: 18, color: "#e3c9a8" },
    { type: "pyramid", w: 34, d: 34, h: 9, y: 26, color: RED }, { type: "cone", w: 3, d: 3, h: 7, y: 34, color: GOLD }],
  landingpad: () => [{ type: "cylinder", w: 60, d: 60, h: 2, color: "#6b7280" }, { type: "tube", wall: 4, w: 52, d: 52, h: 2.4, color: YELLOW },
    { type: "box", w: 4, d: 22, h: 2.4, x: -7, color: WHITE }, { type: "box", w: 4, d: 22, h: 2.4, x: 7, color: WHITE }, { type: "box", w: 14, d: 4, h: 2.4, color: WHITE }],
  flatsground: floorOf("ground"), flatsmiddle: floorOf("middle"), flatstop: floorOf("top"),
  skyscraper: () => [{ type: "box", w: 30, d: 30, h: 150, color: "#5b6d82" }, ...Array.from({ length: 16 }, (_, i) => ({ type: "box", w: 30.6, d: 30.6, h: 4, y: 6 + i * 9, color: GLASS })),
    { type: "box", w: 20, d: 20, h: 6, y: 150, color: "#5b6d82" }, { type: "cylinder", w: 1.5, d: 1.5, h: 20, y: 156, color: DARK }],
  trackstraight: () => [...[-7, 7].map((x) => ({ type: "box", w: 1.6, d: 60, h: 2.5, x, y: 1.5, color: SILVER })), ...Array.from({ length: 8 }, (_, i) => ({ type: "box", w: 22, d: 3, h: 1.5, z: -26.25 + i * 7.5, color: BROWN }))],
  trackcurve: () => { const out = [turnedSlice(45, 67, 98, 0, { h: 2.5, y: 1.5, color: SILVER }, 0, 60), turnedSlice(45, 53, 97, 0, { h: 2.5, y: 1.5, color: SILVER }, 0, 60)];
    for (let i = 0; i < 6; i++) { const a = (-22.5 + 4 + i * 7.4) * Math.PI / 180; out.push({ type: "box", w: 3, d: 22, h: 1.5, x: Math.round(-Math.sin(a) * 60 * 100) / 100, z: Math.round((60 - Math.cos(a) * 60) * 100) / 100, r: Math.round((a * 180) / Math.PI * 100) / 100, color: BROWN }); }
    return out; },
  ottoman: () => [{ type: "roundedbox", radius: 3, w: 30, d: 30, h: 16, y: 3, color: "#7a4a30" }, ...[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([a, b]) => ({ type: "cylinder", w: 3, d: 3, h: 3.2, x: a * 12, z: b * 12, color: DARK }))],
  streetlight1: streetLight(1), streetlight2: streetLight(2),
  poolsteps: () => [...[0, 1, 2].map((i) => ({ type: "box", w: 24, d: 8 * (3 - i), h: 5, y: i * 5, z: i * 4, color: WHITE })),
    ...[-13, 13].map((x) => ({ type: "torus", tube: 12, t: 90, l: 0, r: 90, w: 24, d: 20, h: 2, x: x - 1, y: 10, z: 0, color: SILVER }))],
  snowtree: () => [{ type: "cylinder", w: 4, d: 4, h: 6, color: BROWN }, ...[[22, 5], [17, 11], [12, 17]].map(([w, y]) => ({ type: "cone", w, d: w, h: 10, y, color: "#1f7a36" })),
    ...[[22, 5], [17, 11], [12, 17]].map(([w, y]) => ({ type: "cone", top: 0, w: w * 0.62, d: w * 0.62, h: 6.2, y: y + 3.9, color: SNOW }))],
  curtain: () => [{ type: "scribble", path: Array.from({ length: 41 }, (_, i) => [i / 40, 0.5 + 0.35 * Math.sin((i / 40) * Math.PI * 6)]).concat(Array.from({ length: 41 }, (_, i) => [1 - i / 40, 0.5 + 0.35 * Math.sin((1 - i / 40) * Math.PI * 6) + 0.15])).map(([x, y]) => [Math.round(x * 1000) / 1000, Math.round(Math.min(1, Math.max(0, y)) * 1000) / 1000]),
    w: 40, d: 5, h: 50, color: "#c0392b" }, { type: "cylinder", t: 90, l: 90, w: 2, d: 2, h: 46, x: 23, y: 51, color: GOLD }],
  rug: () => [{ type: "cylinder", w: 60, d: 40, h: 1, color: "#1d3a8a" }, { type: "torus", tube: 8, w: 52, d: 33, h: 1.4, color: "#e5352b" }, { type: "cylinder", w: 30, d: 18, h: 1.3, color: YELLOW }],
  bamboo: () => [...Array.from({ length: 5 }, (_, i) => ({ type: "cylinder", w: 5, d: 5, h: 11.6, y: i * 12, color: "#8cc152" })), ...Array.from({ length: 5 }, (_, i) => ({ type: "cylinder", w: 6, d: 6, h: 1.2, y: 11 + i * 12, color: "#6a9f3a" })),
    { type: "box", w: 1, d: 10, h: 3, x: 2.5, y: 38, t: -30, color: GREEN }],
  firewood: () => [{ type: "cylinder", sides: 24, t: 90, w: 14, d: 14, h: 40, y: 7, z: -20, color: "#6b4226" }, { type: "cylinder", t: 90, w: 12, d: 12, h: 40.4, y: 7, z: -20.2, color: "#c49a6a" }],
  crystals: () => [[0, 0, 0, 24, 0], [6, 2, -4, 16, 20], [-5, 3, 3, 14, -25], [2, -5, 4, 12, 35]].flatMap(([x, z, t, h, l]) => [
    { type: "polygon", sides: 6, w: 6, d: 6, h, x, z, t, l, color: "#9fd3f5" }, { type: "pyramid", sides: 6, w: 6.9, d: 6.9, h: 4, x: x + Math.round(-Math.sin((l * Math.PI) / 180) * h * 100) / 100, y: Math.round(Math.cos((l * Math.PI) / 180) * h * 100) / 100, z, t, l, r: 30, color: "#9fd3f5" }]),
  portcullis: () => [...Array.from({ length: 6 }, (_, i) => ({ type: "box", w: 2, d: 2, h: 40, x: -12.5 + i * 5, y: 5, color: DARK })), ...Array.from({ length: 5 }, (_, j) => ({ type: "box", w: 30, d: 2.4, h: 2, y: 10 + j * 8, color: DARK })),
    ...Array.from({ length: 6 }, (_, i) => ({ type: "cone", fy: -1, w: 2, d: 2, h: 5, x: -12.5 + i * 5, color: DARK }))],
  blossom: () => [{ type: "cylinder", w: 4, d: 4, h: 16, color: "#6b4226" }, ...[[0, 0, 20, 18], [-7, 3, 17, 12], [7, -2, 18, 13], [2, 7, 16, 11], [-2, -7, 18, 11]].map(([x, z, y, w]) => ({ type: "sphere", steps: 12, w, d: w, h: w * 0.85, x, z, y: y - w / 2, color: BLOSSOM }))],
  cave: () => [{ type: "halfsphere", w: 50, d: 40, h: 26, color: "#8a8f98" }, { type: "sphere", steps: 16, w: 22, d: 30, h: 30, z: 14, y: -15, hole: true }, { type: "halfsphere", w: 34, d: 26, h: 18, y: -0.5, hole: true }],
  container: () => [{ type: "box", w: 60, d: 24, h: 26, color: ORANGE }, ...Array.from({ length: 10 }, (_, i) => ({ type: "box", w: 2, d: 25, h: 24, x: -26 + i * 5.8, y: 1, color: "#d9741a" })), { type: "box", w: 1, d: 22, h: 24, x: 30.1, y: 1, color: "#c96a15" }],
  beachchair: (up) => () => [{ type: "box", w: 2, d: 30, h: 2, x: -11, y: 2, color: WOOD }, { type: "box", w: 2, d: 30, h: 2, x: 11, y: 2, color: WOOD },
    ...[-1, 1].map((s) => ({ type: "box", w: 2, d: 2, h: 22, x: s * 11, z: -12, t: up ? -10 : -40, color: WOOD })),
    ...Array.from({ length: 6 }, (_, i) => ({ type: "box", w: 20, d: 4, h: 0.8, y: 6 + i * (up ? 3.4 : 2.2), z: -6 - i * (up ? 1 : 2.6), t: up ? -73 : -47, color: i % 2 ? WHITE : "#e5352b" })),
    { type: "box", w: 20, d: 14, h: 0.8, y: 5, z: 4, color: "#e5352b" }],
  moroccan: () => [{ type: "box", w: 30, d: 30, h: 3, color: "#1f8fe5" }, { type: "box", w: 9, d: 9, h: 5, y: -1, r: 45, hole: true },
    ...[[0, -6], [0, 6], [-6, 0], [6, 0]].map(([x, z]) => ({ type: "cylinder", w: 8, d: 8, h: 5, x, z, y: -1, hole: true }))],
  stonewall: () => [{ type: "box", w: 50, d: 8, h: 24, color: STONE }, ...Array.from({ length: 5 }, (_, i) => ({ type: "box", w: 6, d: 8, h: 6, x: -21 + i * 10.5, y: 24, color: STONE })),
    ...Array.from({ length: 12 }, (_, i) => ({ type: "box", w: 11, d: 8.4, h: 0.8, x: -19.5 + (i % 4) * 13 + (Math.floor(i / 4) % 2 ? 6 : 0), y: 6 + Math.floor(i / 4) * 6, color: "#8a8378" }))],
  shelfunit: () => [...[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([a, b]) => ({ type: "box", w: 2, d: 2, h: 60, x: a * 19, z: b * 9, color: "#c0392b" })),
    ...[2, 20, 38, 56].map((y) => ({ type: "box", w: 40, d: 20, h: 1.5, y, color: "#6b7280" }))],
  desk: () => [{ type: "box", w: 60, d: 30, h: 2, y: 28, color: WOOD }, { type: "box", w: 2, d: 28, h: 28, x: -28, color: WOOD }, { type: "box", w: 16, d: 28, h: 28, x: 21, color: WOOD },
    { type: "box", w: 14, d: 0.6, h: 7, x: 21, y: 19, z: 14, color: "#8c5a30" }, { type: "box", w: 14, d: 0.6, h: 7, x: 21, y: 10, z: 14, color: "#8c5a30" }],
  cage: () => [{ type: "cylinder", w: 30, d: 30, h: 3, color: GOLD }, ...around(14, 13.5, (x, z) => ({ type: "cylinder", sides: 8, w: 1.2, d: 1.2, h: 32, x, z, y: 3, color: GOLD })),
    { type: "halfsphere", w: 30, d: 30, h: 12, y: 35, color: GOLD }, { type: "halfsphere", w: 27, d: 27, h: 10.5, y: 34.9, hole: true }, { type: "torus", tube: 30, t: 90, w: 7, d: 7, h: 1.6, y: 49, z: -0.8, color: GOLD }],
  greenhouseglass: () => [{ type: "box", w: 50, d: 34, h: 24, color: GLASS, clear: true }, { type: "roof", w: 50, d: 34, h: 12, y: 24, r: 90, color: GLASS, clear: true }],
  greenhouseframe: () => [...[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([a, b]) => ({ type: "box", w: 1.6, d: 1.6, h: 24, x: a * 24.2, z: b * 16.2, color: WHITE })),
    ...[-1, 1].map((b) => ({ type: "box", w: 50, d: 1.6, h: 1.6, y: 22.4, z: b * 16.2, color: WHITE })), ...[-1, 1].map((a) => ({ type: "box", w: 1.6, d: 34, h: 1.6, x: a * 24.2, y: 22.4, color: WHITE })),
    { type: "box", w: 50, d: 1.6, h: 1.6, y: 34.4, color: WHITE }],
  farmfence: () => [{ type: "box", w: 3, d: 3, h: 24, x: -24, color: WOOD }, { type: "box", w: 3, d: 3, h: 24, x: 24, color: WOOD }, ...[6, 13, 20].map((y) => ({ type: "box", w: 48, d: 1.5, h: 3, y, z: 1.5, color: WOOD }))],
  endtable: () => [{ type: "box", w: 24, d: 24, h: 2, y: 24, color: WOOD }, { type: "box", w: 22, d: 22, h: 1.5, y: 8, color: WOOD }, ...[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([a, b]) => ({ type: "box", w: 2, d: 2, h: 24, x: a * 10, z: b * 10, color: WOOD }))],
  trellis: () => [{ type: "frame", wall: 6, t: 90, w: 40, d: 60, h: 2, y: 30, z: -1, color: WHITE }, ...[-12, -4, 4, 12].map((x) => ({ type: "box", w: 1.2, d: 1.4, h: 58, x, y: 1, color: WHITE })),
    ...[10, 20, 30, 40, 50].map((y) => ({ type: "box", w: 38, d: 1.4, h: 1.2, y, color: WHITE }))],
  lattice: () => { const out = [{ type: "frame", wall: 7, t: 90, w: 40, d: 40, h: 2, y: 20, z: -1, color: WOOD }];
    for (const s of [-1, 1]) for (let c = -2; c <= 2; c++) { const off = c * 9, len = Math.round((40 - Math.abs(off) * 1.414 * 2) * 1.414 * 0.48 * 100) / 100; if (len > 4) out.push({ type: "box", w: len, d: 1.2, h: 1.6, x: off, y: 19.2, z: s * 0.3, l: s * 45, color: WOOD }); }
    return out; },
  theater: () => [{ type: "box", w: 60, d: 40, h: 34, color: "#8e2b3a" }, { type: "box", w: 50, d: 8, h: 6, y: 18, z: 22, color: WHITE }, { type: "box", w: 46, d: 0.6, h: 4, y: 19, z: 26.1, color: YELLOW },
    { type: "box", w: 16, d: 1, h: 14, z: 20, color: DARK }, { type: "box", w: 10, d: 2, h: 24, y: 34, color: "#8e2b3a" }],
  fern: () => [{ type: "box", w: 1, d: 40, h: 1, color: GREEN }, ...Array.from({ length: 9 }, (_, i) => [-1, 1].map((s) => ({ type: "sphere", steps: 8, w: 3, d: 14 - i, h: 1, x: s * (7 - i * 0.6), z: -16 + i * 4, r: s * 70, color: GREEN }))).flat()],
  gothicvault: () => [{ type: "roundroof", w: 40, d: 50, h: 22, color: STONE }, { type: "roundroof", w: 34, d: 52, h: 19, y: -0.05, hole: true }, ...[-20, 20].map((x) => ({ type: "box", w: 6, d: 50, h: 4, x: x, y: -4, color: STONE }))],
  gothictrim: () => Array.from({ length: 5 }, (_, i) => [{ type: "box", w: 2, d: 3, h: 10, x: -20 + i * 10, color: STONE }, { type: "pyramid", sides: 4, w: 4, d: 4, h: 5, x: -20 + i * 10, y: 10, r: 45, color: STONE }]).flat().concat([{ type: "box", w: 44, d: 3, h: 2, color: STONE }]),
  buttress: () => [{ type: "box", w: 8, d: 30, h: 10, color: STONE }, { type: "box", w: 8, d: 20, h: 14, y: 10, z: -5, color: STONE }, { type: "box", w: 8, d: 10, h: 18, y: 24, z: -10, color: STONE },
    { type: "wedge", r: 90, w: 30, d: 8, h: 10, y: 10, z: 0, color: STONE }],
  spire: () => [{ type: "cylinder", sides: 8, w: 16, d: 16, h: 20, color: STONE }, { type: "cone", sides: 8, w: 16, d: 16, h: 36, y: 20, color: STONE },
    ...around(4, 9, (x, z) => ({ type: "cone", sides: 4, w: 4, d: 4, h: 12, x, z, y: 16, color: STONE })), { type: "sphere", steps: 8, w: 3, d: 3, h: 3, y: 55, color: GOLD }],
  rosewindow: () => [{ type: "tube", wall: 8, t: 90, w: 40, d: 40, h: 3, y: 20, z: -1.5, color: STONE }, { type: "cylinder", t: 90, w: 8, d: 8, h: 3, y: 20, z: -1.5, color: STONE },
    ...[0, 30, 60, 90, 120, 150].map((a) => ({ type: "box", w: 36, d: 2, h: 2, y: 19, l: a, color: STONE })), { type: "cylinder", t: 90, w: 36, d: 36, h: 0.6, y: 20, z: -0.3, color: "#c25bd8", clear: true }],
  archwindow: () => [{ type: "box", w: 24, d: 3, h: 30, color: STONE }, { type: "pyramid", sides: 4, r: 45, w: 17, d: 17, h: 8, y: 30, color: STONE },
    { type: "box", w: 14, d: 3.4, h: 22, y: 4, hole: true }, { type: "box", w: 14, d: 1, h: 22, y: 4, color: "#c25bd8", clear: true }],
  archhollow: () => [{ type: "box", w: 6, d: 6, h: 26, x: -14, color: STONE }, { type: "box", w: 6, d: 6, h: 26, x: 14, color: STONE }, { type: "roof", w: 34, d: 6, h: 14, y: 26, color: STONE },
    { type: "roof", w: 22, d: 8, h: 8, y: 25.9, hole: true }],
  indiagate: () => [{ type: "box", w: 50, d: 14, h: 46, color: "#d9a87a" }, { type: "box", w: 20, d: 16, h: 26, y: -0.1, hole: true }, { type: "roundroof", w: 20, d: 16, h: 10, y: 25.8, hole: true },
    { type: "box", w: 44, d: 12, h: 8, y: 46, color: "#d9a87a" }, { type: "halfsphere", w: 14, d: 10, h: 6, y: 54, color: "#d9a87a" }],
  telephone: () => [{ type: "box", w: 30, d: 24, h: 10, color: DARK }, { type: "wedge", r: 180, w: 30, d: 10, h: 4, y: 10, z: -7, color: DARK }, { type: "cylinder", w: 14, d: 14, h: 1, y: 10, z: 5, color: WHITE },
    { type: "capsule", l: 90, w: 5, d: 5, h: 34, x: 17, y: 14, z: -6, color: DARK }],
  buildingbase: () => [{ type: "box", w: 60, d: 60, h: 3, color: "#8a8f98" }, { type: "box", w: 50, d: 8, h: 3.4, z: 20, color: "#6b7280" }],
  crossing: () => [{ type: "cylinder", w: 3, d: 3, h: 50, color: WHITE }, { type: "box", w: 30, d: 1.6, h: 4, y: 42, l: 35, color: WHITE }, { type: "box", w: 30, d: 1.6, h: 4, y: 42, l: -35, color: WHITE },
    { type: "box", w: 22, d: 3, h: 3, y: 30, color: DARK }, ...[-9, 9].map((x) => ({ type: "cylinder", t: 90, w: 6, d: 6, h: 2, x, y: 27, z: 1, color: RED }))],
  ionic: () => [{ type: "cylinder", sides: 24, w: 14, d: 14, h: 30, color: STONE }, { type: "box", w: 24, d: 14, h: 4, y: 30, color: STONE },
    ...[-12, 12].map((x) => ({ type: "cylinder", t: 90, w: 7, d: 7, h: 14, x, y: 31, z: -7, color: STONE })), { type: "box", w: 26, d: 16, h: 2, y: 34, color: STONE }],
  moai: () => [{ type: "box", w: 16, d: 12, h: 10, color: "#7d7466" }, { type: "cone", sides: 4, r: 45, top: 80, w: 20, d: 16, h: 28, y: 10, color: "#7d7466" }, { type: "box", w: 16, d: 3, h: 3, y: 30, z: 5, color: "#6b6357" },
    { type: "wedge", r: -90, w: 4, d: 4, h: 10, y: 20, z: 7, color: "#6b6357" }, { type: "box", w: 10, d: 2, h: 1.5, y: 15, z: 6.2, color: "#6b6357" }],
  daffodil: () => [{ type: "cylinder", w: 1.6, d: 1.6, h: 30, color: GREEN }, { type: "star", points: 6, inner: 55, t: 70, w: 18, d: 18, h: 1.5, y: 30, color: YELLOW },
    { type: "cylinder", t: 70, w: 7, d: 7, h: 6, y: 30, z: 1, color: ORANGE }, { type: "sphere", steps: 8, w: 3, d: 12, h: 1, x: 2, y: 10, r: 15, t: -40, color: GREEN }],
  loftbed: () => [...[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([a, b]) => ({ type: "box", w: 2.5, d: 2.5, h: 50, x: a * 14, z: b * 26, color: WOOD })),
    { type: "box", w: 30, d: 54, h: 3, y: 32, color: WOOD }, { type: "box", w: 28, d: 50, h: 4, y: 35, color: WHITE }, { type: "box", w: 28.6, d: 28, h: 4.6, y: 34.9, z: 10, color: "#1f8fe5" },
    ...[8, 16, 24].map((y) => ({ type: "box", w: 1.5, d: 12, h: 1.5, x: 15, y, z: 6, color: WOOD })), { type: "box", w: 1.5, d: 1.5, h: 34, x: 15, z: 0.75, color: WOOD }, { type: "box", w: 1.5, d: 1.5, h: 34, x: 15, z: 11.25, color: WOOD }],
  candycane: () => [...Array.from({ length: 8 }, (_, i) => ({ type: "cylinder", w: 6, d: 6, h: 5, y: i * 5, color: i % 2 ? WHITE : RED })), { type: "pie", angle: 180, inner: 50, t: 90, w: 24, d: 12, h: 6, x: 6, y: 40, z: -3, color: RED }],
  wave: () => [{ type: "scribble", path: [[0, 1], [0.1, 0.7], [0.3, 0.35], [0.55, 0.1], [0.8, 0.02], [1, 0.15], [0.95, 0.35], [0.8, 0.25], [0.65, 0.3], [0.55, 0.5], [0.6, 0.75], [0.75, 1]], t: 90, w: 40, d: 34, h: 30, y: 34, z: -15, color: "#1f8fe5" }],
  waterfall: () => [{ type: "box", w: 40, d: 16, h: 40, z: -8, color: "#8a8f98" }, { type: "box", w: 14, d: 3, h: 40, z: 1.5, color: "#7cc0ff", clear: true },
    { type: "cylinder", w: 40, d: 26, h: 2, z: 12, color: "#7cc0ff" }, ...[[-14, 14], [16, 16], [12, 6]].map(([x, z]) => ({ type: "asteroid", w: 8, d: 7, h: 6, x, z, color: "#8a8f98" }))],
  barberpole: () => [{ type: "cylinder", w: 10, d: 10, h: 3, color: SILVER }, ...Array.from({ length: 9 }, (_, i) => ({ type: "cylinder", w: 8, d: 8, h: 4, y: 3 + i * 4, color: [RED, WHITE, "#1f5fbf"][i % 3] })),
    { type: "cylinder", w: 10, d: 10, h: 2, y: 39, color: SILVER }, { type: "halfsphere", w: 8, d: 8, h: 4, y: 41, color: SILVER }],
  finial: () => [spunPart([[0, 0], [1, 0], [1, 0.08], [0.55, 0.12], [0.45, 0.3], [0.8, 0.5], [0.7, 0.68], [0.3, 0.78], [0.45, 0.88], [0.2, 0.96], [0, 1]], { w: 20, d: 20, h: 40, color: GOLD })],
  shutter: () => [{ type: "frame", wall: 12, t: 90, w: 16, d: 40, h: 2, y: 20, z: -1, color: "#2f7a4a" }, ...Array.from({ length: 12 }, (_, i) => ({ type: "box", w: 13, d: 1, h: 2.6, y: 3 + i * 2.85, t: -30, color: "#2f7a4a" }))],
  lilypad: () => [turnedSlice(330, 14, 0, 180, { h: 1, color: "#3fa34d" }), { type: "star", points: 8, inner: 45, w: 8, d: 8, h: 3, y: 1, color: "#f5a3c7" }],
  barbecue: () => [spunPart([[0, 0], [0.3, 0], [0.8, 0.35], [1, 1], [0.94, 1], [0.75, 0.4], [0, 0.15]], { w: 34, d: 34, h: 14, y: 26, color: DARK }), { type: "cylinder", w: 32, d: 32, h: 0.8, y: 39, color: SILVER },
    { type: "halfsphere", w: 34, d: 34, h: 14, y: 40, color: DARK }, ...around(3, 12, (x, z, a) => ({ type: "cylinder", w: 2, d: 2, h: 30, x, z, t: 8, r: a, color: DARK }))],
  faucet: () => [{ type: "cylinder", w: 10, d: 10, h: 3, color: SILVER }, { type: "cylinder", w: 5, d: 5, h: 22, y: 3, color: SILVER }, { type: "torus", tube: 30, t: 90, w: 14, d: 14, h: 5, y: 25, z: -2.5, x: 7, color: SILVER },
    { type: "cylinder", w: 4, d: 4, h: 6, x: 14, y: 19, color: SILVER }, { type: "box", w: 16, d: 3, h: 2, y: 16, color: SILVER }],
  brickblock: () => [{ type: "box", w: 24, d: 11.5, h: 7, color: "#b5452e" }, ...[-7, 0, 7].map((x) => ({ type: "cylinder", w: 4, d: 4, h: 9, x, y: -1, hole: true }))],
});
KITS.beachup = KITS.beachchair(true); KITS.beachrecl = KITS.beachchair(false); delete KITS.beachchair;
Object.assign(KITS, {
  door9: doorOf(20, 40, WOOD, "nine"), doorsolid: doorOf(20, 40, WOOD, "panels"), doorcountry: doorOf(20, 40, "#c4a47a", "glass"), doorgothic: doorOf(20, 34, "#6b4226", "arch"),
  doorbarn: doorOf(30, 40, "#a0402a", "barn"), doordouble: doubleDoor(16, 40, WOOD, "panels"), doordoubleglass: doubleDoor(16, 40, WHITE, "glass"),
  win4: windowOf(30, 30, 2, 2), winslide: windowOf(40, 26, 2, 1, SILVER), winoval: () => [{ type: "tube", wall: 10, t: 90, w: 24, d: 34, h: 2.5, y: 17, z: -1.25, color: WHITE },
    { type: "cylinder", t: 90, w: 22, d: 32, h: 0.6, y: 17, z: -0.3, color: GLASS, clear: true }, ...[-15, 15].map((x) => ({ type: "cylinder", sides: 16, w: 4, d: 4, h: 36, x, color: WHITE }))],
});

// ---------- Shape generators, batch 2 (our own designs) ----------
Object.assign(KITS, {
  banana: () => [{ type: "donutslice", angle: 110, w: 40, d: 40, h: 9, r: 125, color: "#f2d23a" }, { type: "cone", t: 90, r: 55, w: 3, d: 3, h: 5, x: 14.5, y: 3, z: -5, color: "#6b4226" }],
  radialfins: () => [{ type: "cylinder", w: 12, d: 12, h: 20, color: SILVER }, ...around(12, 9, (x, z, a) => ({ type: "box", w: 1.2, d: 10, h: 20, x, z, r: a, color: SILVER }))],
  mandala: () => [{ type: "star", points: 16, inner: 70, w: 44, d: 44, h: 2, color: "#8a4fd8" }, { type: "flower", petals: 8, w: 30, d: 30, h: 3.2, color: "#e8306e" },
    { type: "star", points: 8, inner: 50, w: 18, d: 18, h: 4.4, r: 22.5, color: "#f2c230" }, { type: "cylinder", w: 6, d: 6, h: 5.4, color: "#16b6b0" }],
  tubejoint: () => [{ type: "tube", wall: 15, w: 16, d: 16, h: 20, color: "#9aa0a8" }, { type: "tube", wall: 22, w: 12.4, d: 12.4, h: 20, y: 18, color: "#1f8fe5" }],
  slats: () => [{ type: "box", w: 2, d: 2, h: 50, x: -21, color: WHITE }, { type: "box", w: 2, d: 2, h: 50, x: 21, color: WHITE },
    ...Array.from({ length: 12 }, (_, i) => ({ type: "box", w: 40, d: 6, h: 0.8, y: 3 + i * 4, t: -25, color: WHITE }))],
  columngrid: () => { const out = [{ type: "box", w: 44, d: 44, h: 2, color: "#9aa0a8" }]; for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) out.push({ type: "box", w: 6, d: 6, h: 8 + ((i * 3 + j * 5) % 7) * 3, x: -15 + i * 10, z: -15 + j * 10, y: 2, color: "#1f8fe5" }); return out; },
  extrusiongrid: () => [{ type: "box", w: 44, d: 44, h: 4, color: "#f08a1c" }, ...Array.from({ length: 16 }, (_, k) => ({ type: "box", w: 7.5, d: 7.5, h: 6, x: -15 + (k % 4) * 10, z: -15 + Math.floor(k / 4) * 10, y: -1, hole: true }))],
});

// ---------- Everyday objects, batch 2 (our own simplified designs) ----------
const CARD = "#c8a06a";
const clayTool = (head) => () => [{ type: "cylinder", t: 90, w: 6, d: 6, h: 50, y: 3, z: -50, color: WOOD }, { type: "box", w: 4, d: 10, h: 2, y: 2, z: 2, color: SILVER }, ...head];
Object.assign(KITS, {
  chopsticks: () => [-3, 3].map((x) => ({ type: "cone", top: 45, t: 90, w: 5, d: 5, h: 200, x, y: 2.5, z: -100, color: "#c49a6a" })),
  toothpick: () => [{ type: "cylinder", t: 90, w: 2, d: 2, h: 50, y: 1, z: -25, color: "#e8c89a" }, { type: "cone", t: 90, w: 2, d: 2, h: 6, y: 1, z: 25, color: "#e8c89a" }, { type: "cone", t: -90, w: 2, d: 2, h: 6, y: 1, z: -25, color: "#e8c89a" }],
  needle: () => [{ type: "cylinder", t: 90, w: 1.2, d: 1.2, h: 40, y: 0.6, z: -20, color: SILVER }, { type: "cone", t: 90, w: 1.2, d: 1.2, h: 5, y: 0.6, z: 20, color: SILVER }, { type: "box", w: 0.5, d: 3, h: 3, y: -1, z: -17, hole: true }],
  basket: () => [{ type: "tube", wall: 8, w: 50, d: 36, h: 24, color: "#c49a5a" }, { type: "cylinder", w: 48, d: 34, h: 2, color: "#c49a5a" },
    { type: "pie", angle: 180, inner: 90, t: 90, w: 48, d: 24, h: 3, y: 24, z: -1.5, color: "#a0783a" }],
  heartbox: () => [{ type: "heart", w: 40, d: 40, h: 14, color: RED }, { type: "heart", w: 34, d: 34, h: 13, y: 2, z: -0.5, hole: true }, { type: "heart", w: 40, d: 40, h: 4, x: 46, color: RED }],
  wrench: () => [{ type: "roundedbox", radius: 1, w: 8, d: 70, h: 4, color: SILVER }, { type: "cylinder", w: 20, d: 20, h: 4, z: -38, color: SILVER }, { type: "box", w: 8, d: 12, h: 6, z: -44, y: -1, hole: true },
    { type: "tube", wall: 20, w: 16, d: 16, h: 4, z: 38, color: SILVER }],
  tile20: () => [{ type: "box", w: 20, d: 20, h: 3, color: "#e9e2d6" }],
  bottlecap: () => [{ type: "gear", teeth: 21, w: 26, d: 26, h: 6, color: RED }, { type: "cylinder", w: 22, d: 22, h: 5, y: -0.1, hole: true }],
  boxnet: () => { const S = 30, T = 0.8, c = "#c8a06a"; return [{ type: "box", w: S, d: S, h: T, color: c }, { type: "box", w: S, d: S, h: T, x: -S, color: c }, { type: "box", w: S, d: S, h: T, x: S, color: c },
    { type: "box", w: S, d: S, h: T, x: 2 * S, color: c }, { type: "box", w: S, d: S, h: T, z: -S, color: c }, { type: "box", w: S, d: S, h: T, z: S, color: c }]; },
  keychain: () => [{ type: "torus", tube: 15, w: 26, d: 26, h: 2.5, color: SILVER }, { type: "cylinder", t: 90, w: 4, d: 4, h: 10, y: 2, z: 12, color: SILVER },
    { type: "torus", tube: 30, t: 90, w: 8, d: 8, h: 2, y: 2, z: 22, color: SILVER }],
  scissors: () => [{ type: "torus", tube: 25, w: 18, d: 14, h: 3, x: -8, z: 22, color: RED }, { type: "torus", tube: 25, w: 18, d: 14, h: 3, x: 8, z: 22, color: RED },
    { type: "wedge", r: 95, w: 6, d: 46, h: 2, x: -2, y: 1, z: -10, color: SILVER }, { type: "wedge", r: -95, w: 6, d: 46, h: 2, x: 2, y: 0.4, z: -10, color: SILVER },
    { type: "cylinder", w: 3, d: 3, h: 4, z: 4, color: SILVER }],
  petfood: () => [{ type: "cylinder", w: 50, d: 50, h: 50, color: "#e5352b" }, { type: "cylinder", w: 52, d: 52, h: 6, y: 50, color: "#c0392b" }, { type: "cylinder", w: 51, d: 51, h: 20, y: 15, color: WHITE }],
  hanger: () => [{ type: "box", w: 90, d: 3, h: 3, color: WOOD }, { type: "box", w: 52, d: 3, h: 3, x: -22, y: 1, l: 30, color: WOOD }, { type: "box", w: 52, d: 3, h: 3, x: 22, y: 1, l: -30, color: WOOD },
    { type: "cylinder", w: 2, d: 2, h: 10, y: 26, color: SILVER }, { type: "pie", angle: 240, inner: 75, t: 90, w: 12, d: 12, h: 2, y: 38, z: -1, color: SILVER }],
  books: () => [[16, 50, RED], [12, 46, "#1f8fe5"], [20, 54, GREEN], [10, 44, YELLOW], [14, 50, PURPLE], [18, 48, ORANGE]].map(([w, h, c], i, a) => ({ type: "box", w, d: 34, h, x: a.slice(0, i).reduce((t, v) => t + v[0] + 0.4, 0) - 46, color: c })),
  luggagetag: () => [{ type: "roundedbox", radius: 4, w: 50, d: 28, h: 3, color: ORANGE }, { type: "cylinder", w: 5, d: 5, h: 5, x: -19, y: -1, hole: true }, { type: "box", w: 30, d: 16, h: 0.4, x: 4, y: 3, color: WHITE },
    { type: "torus", tube: 10, t: 90, l: 90, w: 22, d: 14, h: 1.5, x: -30, y: 1.5, color: DARK }],
  westernhat: () => [spunPart([[0, 0], [1, 0], [1, 0.06], [0.95, 0.12], [0.5, 0.12], [0.48, 0.85], [0.35, 1], [0, 0.9]], { w: 60, d: 50, h: 24, color: "#7a4a24" }), { type: "tube", wall: 8, w: 31, d: 26, h: 4, y: 3.2, color: DARK }],
  claywheel: clayTool([{ type: "cylinder", l: 90, w: 18, d: 18, h: 3, x: 1.5, y: 9, z: 10, color: SILVER }]),
  claystar: clayTool([{ type: "star", points: 12, inner: 70, l: 90, w: 18, d: 18, h: 3, x: 1.5, y: 9, z: 10, color: SILVER }]),
  clayslant: clayTool([{ type: "cone", top: 70, l: 90, w: 18, d: 18, h: 4, x: 2, y: 9, z: 10, color: SILVER }]),
  clayroller: clayTool([{ type: "cylinder", l: 90, w: 12, d: 12, h: 20, x: 10, y: 6, z: 8, color: WOOD }]),
  fancyshelf: () => [{ type: "box", w: 60, d: 16, h: 3, y: 30, color: WOOD }, ...[-22, 22].map((x) => ({ type: "pie", angle: 90, inner: 60, t: 90, r: 0, w: 22, d: 22, h: 3, x, y: 15, z: -6, color: WOOD })),
    { type: "box", w: 60, d: 2, h: 34, z: -8, color: "#8c5a30" }],
  paperclip: () => { const w = 1; const band = (R, cz, rr) => turnedSlice(180, R, Math.round((1 - w / R) * 100), rr, { h: w, color: SILVER }, 0, cz); return [
    band(5, -14, 0), band(4, 14, 180), band(3, -10, 0), { type: "box", w, d: 28, h: w, x: -4.5, color: SILVER }, { type: "box", w, d: 28, h: w, x: 4.5, z: -2, color: SILVER },
    { type: "box", w, d: 24, h: w, x: -2.5, z: 2, color: SILVER }, { type: "box", w, d: 18, h: w, x: 3.5, z: 5, color: SILVER }]; },
  coconut: () => [{ type: "sphere", w: 34, d: 32, h: 32, color: "#6b4226" }, ...[[-4, 3], [4, 3], [0, -4]].map(([x, z]) => ({ type: "sphere", steps: 8, w: 3, d: 3, h: 3, x, z, y: 30, color: "#3b2414" }))],
  shovel: () => [{ type: "cylinder", t: 90, w: 4, d: 4, h: 80, y: 2, z: -60, color: WOOD }, { type: "scribble", path: [[0, 0], [1, 0], [1, 0.6], [0.5, 1], [0, 0.6]], w: 24, d: 30, h: 2, z: 35, color: SILVER },
    { type: "box", w: 14, d: 3, h: 3, y: 0.5, z: -62, color: DARK }],
});

// ---------- Hardware, batch 2: ball-and-socket parts, dowel connectors, handles, snaps (our own designs) ----------
const BALLC = "#16b6b0", SOCK = "#8a4fd8", DOWEL = "#f2c230";
// a tube pointing along one axis from the centre of a hub: dir is "x", "-x", "y", "z", "-z" or "d1".."d4" (diagonals in the floor plane)
const arm = (dir, len = 16, dia = 10, color = DOWEL) => {
  const base = { type: "tube", wall: 20, w: dia, d: dia, h: len, color };
  if (dir === "y") return { ...base, y: 6 };
  if (dir === "x") return { ...base, l: -90, x: 6, y: 6 };
  if (dir === "-x") return { ...base, l: 90, x: -6, y: 6 };
  if (dir === "z") return { ...base, t: 90, y: 6, z: 6 };
  if (dir === "-z") return { ...base, t: -90, y: 6, z: -6 };
  const a = { d1: 45, d2: 135, d3: 225, d4: 315 }[dir];
  return { ...base, t: 90, r: a, y: 6, x: Math.round(Math.sin((a * Math.PI) / 180) * 6 * 100) / 100, z: Math.round(Math.cos((a * Math.PI) / 180) * 6 * 100) / 100 };
};
const hub = (dirs) => () => [{ type: "box", w: 12, d: 12, h: 12, color: DOWEL }, ...dirs.map((d) => arm(d))];
// the top is trimmed off so a 12 mm ball snaps in through a 10.5 mm opening; the slot lets it flex
const socketOf = (stem) => () => [{ type: "sphere", w: 16, d: 16, h: 16, y: stem, color: SOCK }, { type: "sphere", w: 12.4, d: 12.4, h: 12.4, y: stem + 4, hole: true },
  { type: "box", w: 20, d: 20, h: 6, y: stem + 13.5, hole: true }, { type: "box", w: 3, d: 20, h: 9, y: stem + 9, hole: true }, ...(stem ? [{ type: "cylinder", w: 8, d: 8, h: stem + 2, color: SOCK }] : [])];
const uniArm = (len) => () => [{ type: "cylinder", t: 90, w: 5, d: 5, h: len, y: 6, z: -len / 2, color: BALLC },
  { type: "sphere", w: 12, d: 12, h: 12, z: -len / 2 - 3, color: BALLC }, { type: "sphere", w: 12, d: 12, h: 12, z: len / 2 + 3, color: BALLC }];
Object.assign(KITS, {
  ball: () => [{ type: "cylinder", w: 6, d: 6, h: 8, color: BALLC }, { type: "sphere", w: 12, d: 12, h: 12, y: 6, color: BALLC }, { type: "cylinder", w: 14, d: 14, h: 2, color: BALLC }],
  angledball: () => [{ type: "cylinder", w: 14, d: 14, h: 2, color: BALLC }, { type: "cylinder", w: 6, d: 6, h: 10, color: BALLC }, { type: "cylinder", w: 6, d: 6, h: 10, y: 9, l: -45, color: BALLC },
    { type: "sphere", w: 12, d: 12, h: 12, x: 9, y: 13, color: BALLC }],
  supportball: () => [{ type: "box", w: 20, d: 20, h: 3, color: BALLC }, { type: "cylinder", w: 6, d: 6, h: 8, color: BALLC }, { type: "sphere", w: 12, d: 12, h: 12, y: 7, color: BALLC },
    ...[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([a, b]) => ({ type: "cylinder", w: 3.4, d: 3.4, h: 5, x: a * 7, z: b * 7, y: -1, hole: true }))],
  lockball: () => [{ type: "sphere", w: 12, d: 12, h: 12, color: BALLC }, { type: "polygon", sides: 6, w: 8, d: 8, h: 6, y: 10, color: BALLC }],
  rotball: () => [{ type: "sphere", w: 12, d: 12, h: 12, y: 3, color: BALLC }, { type: "cylinder", w: 16, d: 16, h: 3, color: BALLC }, { type: "cylinder", w: 4, d: 4, h: 5, y: -2, hole: true }],
  ballhandle: () => [{ type: "cylinder", t: 90, w: 6, d: 6, h: 40, y: 3, z: -20, color: SOCK }, { type: "sphere", w: 16, d: 16, h: 16, y: -5, z: 24, color: SOCK }, { type: "sphere", w: 12, d: 12, h: 12, y: -3, z: -24, color: BALLC }],
  socket: socketOf(0), vsocket: socketOf(10),
  supportsocket: () => [{ type: "box", w: 22, d: 22, h: 3, color: SOCK }, ...socketOf(2)().map((p) => p),
    ...[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([a, b]) => ({ type: "cylinder", w: 3.4, d: 3.4, h: 5, x: a * 8, z: b * 8, y: -1, hole: true }))],
  uniarmsm: uniArm(20), uniarmmed: uniArm(40), uniarmlg: uniArm(60),
  unihand: () => [...socketOf(0)(), ...[-6, -2, 2, 6].map((x) => ({ type: "capsule", w: 3, d: 3, h: 14, x, y: 14, z: 4, t: 20, color: SOCK }))],
  dowel3: hub(["x", "y", "z"]), dowel5: hub(["x", "-x", "z", "-z", "y"]), dowel9: hub(["x", "-x", "z", "-z", "y", "d1", "d2", "d3", "d4"]), dowelT: hub(["x", "-x", "z"]),
  dowelplate: () => [{ type: "box", w: 60, d: 20, h: 12, color: WOOD }, ...[-20, 0, 20].map((x) => ({ type: "cylinder", w: 12.7, d: 12.7, h: 14, x, y: -1, hole: true }))],
  tube2: () => [-6, 6].map((x) => ({ type: "tube", wall: 15, w: 12, d: 12, h: 30, x, color: "#2fa24a" })),
  tube3: () => around(3, 7, (x, z) => ({ type: "tube", wall: 15, w: 12, d: 12, h: 30, x, z, color: "#2fa24a" })),
  handle: () => [{ type: "pie", angle: 180, inner: 70, t: 90, w: 60, d: 30, h: 8, y: 30, z: -4, r: 0, color: DARK }, ...[-26, 26].map((x) => ({ type: "box", w: 10, d: 10, h: 4, x, color: DARK })),
    ...[-26, 26].map((x) => ({ type: "cylinder", w: 3.4, d: 3.4, h: 6, x, y: -1, hole: true }))],
  bevelhandle: () => [{ type: "roundedbox", radius: 3, w: 80, d: 12, h: 10, y: 14, color: SILVER }, ...[-34, 34].map((x) => ({ type: "cone", top: 70, w: 10, d: 10, h: 14, x, color: SILVER }))],
  snap: () => [{ type: "box", w: 6, d: 2, h: 20, color: "#1f8fe5" }, { type: "wedge", r: -90, w: 3, d: 6, h: 4, y: 16, z: 1, color: "#1f8fe5" }, { type: "box", w: 14, d: 10, h: 3, z: 4, y: -3, color: "#1f8fe5" }],
  snapconn: () => [{ type: "cylinder", w: 8, d: 8, h: 4, color: "#1f8fe5" }, ...[-1, 1].map((s) => ({ type: "box", w: 2, d: 5, h: 14, x: s * 2.2, y: 4, color: "#1f8fe5" })),
    ...[-1, 1].map((s) => ({ type: "wedge", r: s > 0 ? 0 : 180, w: 1.5, d: 5, h: 3, x: s * 3.9, y: 14, color: "#1f8fe5" }))],
  hingeA: () => [{ type: "box", w: 14, d: 4, h: 10, color: DARK }, ...[0, 6].map((y) => ({ type: "cylinder", t: 90, w: 4, d: 4, h: 3, x: 8, y: y + 2, z: -1.5, color: DARK })),
    { type: "cylinder", w: 1.6, d: 1.6, h: 12, x: 8, y: -1, hole: true }],
  hingeB: () => [{ type: "box", w: 14, d: 4, h: 10, color: DARK }, { type: "cylinder", t: 90, w: 4, d: 4, h: 3, x: -8, y: 5, z: -1.5, color: DARK }, { type: "cylinder", w: 1.6, d: 1.6, h: 12, x: -8, y: -1, hole: true }],
  hingepin: () => [{ type: "cylinder", w: 1.5, d: 1.5, h: 12, color: SILVER }, { type: "cylinder", w: 3, d: 3, h: 0.8, y: 12, color: SILVER }],
  crossdowel: () => [{ type: "cylinder", t: 90, w: 10, d: 10, h: 12, y: 5, z: -6, color: SILVER }, { type: "cylinder", w: 5, d: 5, h: 12, y: -1, hole: true }, { type: "box", w: 1.2, d: 6, h: 2, y: 9.2, z: -4, hole: true }],
  extrusion2020: () => [{ type: "box", w: 20, d: 20, h: 60, color: SILVER }, { type: "cylinder", w: 4.2, d: 4.2, h: 62, y: -1, hole: true },
    ...[[0, 9], [0, -9], [9, 0], [-9, 0]].map(([x, z]) => ({ type: "box", w: x ? 4 : 6.2, d: x ? 6.2 : 4, h: 62, x, z, y: -1, hole: true }))],
  csbolt: () => [{ type: "screw", threads: 14, w: 5, d: 5, h: 36, color: SILVER }, { type: "cone", top: 50, fy: -1, w: 10, d: 10, h: 3, y: 36, color: SILVER }, { type: "box", w: 5, d: 1, h: 2, y: 37.5, hole: true }],
  valve: () => [{ type: "cylinder", t: 90, w: 10, d: 10, h: 40, y: 5, z: -20, color: GOLD }, { type: "cylinder", w: 12, d: 12, h: 12, color: GOLD }, { type: "cylinder", w: 4, d: 4, h: 8, y: 12, color: SILVER },
    { type: "roundedbox", radius: 1, w: 30, d: 5, h: 3, x: 10, y: 19, color: RED }],
  lanyard: () => [{ type: "torus", tube: 6, w: 40, d: 140, h: 2, color: "#1f8fe5" }, { type: "box", w: 10, d: 6, h: 6, z: 72, color: SILVER }, { type: "torus", tube: 25, w: 10, d: 12, h: 2, z: 79, color: SILVER }],
});

// ---------- Vehicles & machinery, batch 2 (our own simplified designs) ----------
// a wheel standing up, its axle front to back: tyre (with optional tread teeth), rim and hub
const wheelOf = ({ dia = 30, width = 12, teeth = 0, rim = SILVER, tyre = DARK, rimDia = 0.62, wall = null, spokes = 0 }) => () => {
  const R = dia / 2, out = [];
  out.push(teeth ? { type: "gear", teeth, t: 90, w: dia, d: dia, h: width, y: R, z: -width / 2, color: tyre } : { type: "torus", tube: 34, t: 90, w: dia, d: dia, h: width, y: R, z: -width / 2, color: tyre });
  if (wall) out.push({ type: "tube", wall: 8, t: 90, w: dia * 0.78, d: dia * 0.78, h: width * 1.02, y: R, z: -width * 0.51, color: wall });
  if (spokes) {
    out.push({ type: "tube", wall: 10, t: 90, w: dia * rimDia, d: dia * rimDia, h: width * 0.6, y: R, z: -width * 0.3, color: rim });
    for (let i = 0; i < spokes; i++) out.push({ type: "box", w: dia * rimDia * 0.96, d: width * 0.25, h: 1.4, y: R - 0.7, l: (i * 180) / spokes, color: rim });
  } else out.push({ type: "cylinder", t: 90, w: dia * rimDia, d: dia * rimDia, h: width * 0.9, y: R, z: -width * 0.45, color: rim });
  out.push({ type: "cylinder", t: 90, w: dia * 0.2, d: dia * 0.2, h: width * 1.05, y: R, z: -width * 0.525, color: "#6b7280" });
  return out;
};
Object.assign(KITS, {
  tireAT: wheelOf({ dia: 34, width: 14, teeth: 18, rim: "#9aa0a8" }),
  tireSpiked: () => [...wheelOf({ dia: 30, width: 12, rim: RED })(), ...around(16, 0, () => null).filter(Boolean),
    ...Array.from({ length: 16 }, (_, i) => { const a = (i / 16) * Math.PI * 2; return { type: "cone", w: 3, d: 3, h: 4, l: Math.round((-a * 180) / Math.PI), x: Math.round(Math.sin(a) * 15 * 100) / 100, y: Math.round((15 + Math.cos(a) * 15) * 100) / 100, z: 0, color: SILVER }; })],
  tireTruck: wheelOf({ dia: 40, width: 16, teeth: 26, rim: SILVER }),
  tireDragster: wheelOf({ dia: 44, width: 30, rim: SILVER, rimDia: 0.55 }),
  tireWhitewall: wheelOf({ dia: 30, width: 10, rim: SILVER, wall: WHITE }),
  wheelAlloy: wheelOf({ dia: 32, width: 12, rim: "#c4c9d0", spokes: 5, rimDia: 0.7 }),
  wheelOld: wheelOf({ dia: 34, width: 6, rim: "#c0392b", spokes: 6, rimDia: 0.8, tyre: "#f3ead8" }),
  wheelMars: () => [{ type: "cylinder", t: 90, w: 30, d: 30, h: 16, y: 15, z: -8, color: "#c4c9d0" }, { type: "cylinder", t: 90, w: 26, d: 26, h: 17, y: 15, z: -8.5, hole: true },
    { type: "cylinder", t: 90, w: 10, d: 10, h: 16, y: 15, z: -8, color: "#9aa0a8" }, ...Array.from({ length: 6 }, (_, i) => ({ type: "box", w: 26, d: 1.4, h: 1.4, y: 14.3, l: i * 30, z: 7, color: "#9aa0a8" })),
    ...Array.from({ length: 24 }, (_, i) => { const a = (i / 24) * Math.PI * 2; return { type: "box", w: 1.6, d: 16, h: 1.6, x: Math.round(Math.sin(a) * 15.2 * 100) / 100, y: Math.round((15 + Math.cos(a) * 15.2) * 100) / 100 - 0.8, l: Math.round((-a * 180) / Math.PI), color: "#9aa0a8" }; })],
  wheelToy: wheelOf({ dia: 20, width: 8, rim: YELLOW }),
  wheelCVfront: wheelOf({ dia: 46, width: 14, teeth: 30, rim: SILVER, rimDia: 0.58 }),
  wheelCVrear: () => [...wheelOf({ dia: 46, width: 14, teeth: 30, rim: SILVER, rimDia: 0.58 })().map((p) => ({ ...p, z: (p.z || 0) - 8 })), ...wheelOf({ dia: 46, width: 14, teeth: 30, rim: SILVER, rimDia: 0.58 })().map((p) => ({ ...p, z: (p.z || 0) + 8 }))],
  tricaster: () => [...[0, 120, 240].flatMap((a) => { const t = (a * Math.PI) / 180; return [
    { type: "box", w: 3, d: 18, h: 3, x: Math.round(Math.sin(t) * 9 * 100) / 100, y: 9, z: Math.round(Math.cos(t) * 9 * 100) / 100, r: a, color: SILVER },
    { type: "cylinder", l: 90, w: 8, d: 8, h: 4, x: Math.round((Math.sin(t) * 18 + 2) * 100) / 100, y: 4, z: Math.round(Math.cos(t) * 18 * 100) / 100, r: a, color: DARK }]; }),
    { type: "cylinder", w: 6, d: 6, h: 8, y: 9, color: SILVER }],
  standbase: () => [{ type: "cylinder", w: 40, d: 40, h: 4, color: DARK }, { type: "cylinder", w: 6, d: 6, h: 6, y: 4, color: DARK }, { type: "cylinder", w: 3.2, d: 3.2, h: 6, y: 5, hole: true }],
  standrod: () => [{ type: "cylinder", w: 3, d: 3, h: 60, color: "#7cc0ff", clear: true }, { type: "cylinder", l: 90, w: 3, d: 3, h: 6, y: 58, x: 3, color: "#7cc0ff", clear: true }],
  aircon: () => [{ type: "box", w: 60, d: 30, h: 40, color: "#e9e2d6" }, ...Array.from({ length: 10 }, (_, i) => ({ type: "box", w: 22, d: 1, h: 1.4, x: 16, y: 6 + i * 3, z: 15.2, color: "#9aa0a8" })),
    { type: "cylinder", t: 90, w: 30, d: 30, h: 1, x: -12, y: 20, z: 15, color: "#9aa0a8" }, ...[0, 60, 120].map((a) => ({ type: "box", w: 26, d: 1, h: 3, x: -12, y: 18.5, z: 15.6, l: a, color: DARK }))],
  van: () => [{ type: "roundedbox", radius: 2, w: 64, d: 28, h: 28, y: 5, color: WHITE }, { type: "box", w: 10, d: 26, h: 12, x: 33, y: 5, color: WHITE }, { type: "box", w: 1, d: 24, h: 10, x: 32.2, y: 20, color: "#2a72c8" },
    { type: "box", w: 14, d: 0.6, h: 10, x: 22, y: 20, z: 14.2, color: "#2a72c8" },
    ...[-20, 26].flatMap((x) => [{ type: "cylinder", t: 90, w: 12, d: 12, h: 4, x, y: 6, z: 12, color: DARK }, { type: "cylinder", t: 90, w: 12, d: 12, h: 4, x, y: 6, z: -16, color: DARK }])],
  cargoship: () => [{ type: "box", w: 70, d: 22, h: 16, color: "#9aa0a8" }, { type: "wedge", r: 180, w: 20, d: 22, h: 16, x: 45, color: "#9aa0a8" }, ...[-20, 0, 20].map((x) => ({ type: "box", w: 16, d: 26, h: 12, x, y: 16, color: [ORANGE, "#1f8fe5", RED][(x + 20) / 20] })),
    ...[-6, 6].map((z) => ({ type: "cylinder", t: -90, w: 8, d: 8, h: 8, x: -39, y: 8, z, color: "#5ec8ff" }))],
  pontoon: () => [{ type: "capsule", t: 90, w: 12, d: 12, h: 70, y: 6, z: -35, color: "#f2c230" }, ...[-20, 20].map((z) => ({ type: "box", w: 3, d: 3, h: 14, y: 10, z, color: SILVER }))],
  tankhatch: () => [{ type: "cylinder", w: 30, d: 30, h: 4, color: "#556b3a" }, { type: "cylinder", w: 26, d: 26, h: 3, y: 4, color: "#556b3a" }, { type: "pie", angle: 180, inner: 70, t: 90, w: 14, d: 7, h: 2, y: 7, z: -1, color: DARK }],
  anchor: () => [{ type: "box", w: 4, d: 4, h: 48, y: 4, color: DARK }, { type: "torus", tube: 22, t: 90, w: 12, d: 12, h: 3, y: 51, z: -1.5, color: DARK }, { type: "box", w: 24, d: 4, h: 3, y: 40, color: DARK },
    ...[-1, 1].map((s) => ({ type: "box", w: 20, d: 4, h: 3.5, x: s * 8, y: 4, l: s * 30, color: DARK })), ...[-1, 1].map((s) => ({ type: "cone", sides: 3, w: 9, d: 4, h: 9, x: s * 16.5, y: 6.5, color: DARK }))],
  biplane: () => [{ type: "capsule", t: 90, w: 7, d: 7, h: 40, y: 8, z: -20, color: RED }, { type: "box", w: 44, d: 8, h: 1.2, y: 4, z: -6, color: YELLOW }, { type: "box", w: 44, d: 8, h: 1.2, y: 16, z: -6, color: YELLOW },
    ...[-15, 15].flatMap((x) => [{ type: "box", w: 1, d: 1, h: 12, x, y: 4, z: -8, color: DARK }, { type: "box", w: 1, d: 1, h: 12, x, y: 4, z: -3, color: DARK }]),
    { type: "box", w: 14, d: 5, h: 1, y: 8, z: 16, color: YELLOW }, { type: "box", w: 1, d: 5, h: 7, y: 8, z: 16, color: RED }, { type: "box", w: 1, d: 1, h: 14, y: 1, z: -21, color: DARK }],
  airtank: () => [{ type: "capsule", t: 90, w: 18, d: 18, h: 60, y: 9, z: -30, color: "#2b2f36" }, ...[-15, 15].map((z) => ({ type: "tube", wall: 8, t: 90, w: 19, d: 19, h: 3, y: 9, z, color: SILVER })),
    { type: "cylinder", w: 3, d: 3, h: 4, y: 17.5, color: SILVER }],
});

// ---------- Fun & games and Sim lab, batch 2 (our own simplified designs) ----------
const PLAY = ["#e5352b", "#f2c230", "#1f8fe5", "#2fa24a"];
const spool = (w, h) => [spunPart([[0, 0], [1, 0], [1, 0.12], [0.55, 0.14], [0.55, 0.86], [1, 0.88], [1, 1], [0, 1]], { w, d: w, h, color: "#c49a6a" }), { type: "cylinder", w: w * 0.18, d: w * 0.18, h: h + 2, y: -1, hole: true }];
Object.assign(KITS, {
  slide: () => [{ type: "box", w: 14, d: 50, h: 2, y: 13, t: -28, color: "#e5352b" }, ...[-1, 1].map((s) => ({ type: "box", w: 1.5, d: 50, h: 4, x: s * 7, y: 14, t: -28, color: "#e5352b" })),
    { type: "box", w: 16, d: 10, h: 2, y: 25, z: -26, color: "#1f8fe5" }, ...[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([a, b]) => ({ type: "box", w: 2, d: 2, h: 25, x: a * 7, z: -26 + b * 4, color: "#1f8fe5" }))],
  slidecurved: () => [{ type: "donutslice", angle: 120, w: 60, d: 60, h: 8, y: 0, color: "#f2c230" }, { type: "torus", tube: 20, w: 50, d: 50, h: 5, y: 5.5, hole: true }],
  slidedouble: () => [{ type: "donutslice", angle: 90, w: 50, d: 50, h: 8, x: -12, color: "#2fa24a" }, { type: "donutslice", angle: 90, w: 50, d: 50, h: 8, x: 12, z: 26, r: 180, color: "#2fa24a" }],
  climber: () => [...[-15, 15].flatMap((x) => [{ type: "box", w: 2.5, d: 2.5, h: 40, x, z: -10, color: "#1f8fe5" }, { type: "box", w: 2.5, d: 2.5, h: 40, x, z: 10, color: "#1f8fe5" }]),
    ...[8, 16, 24, 32, 40].flatMap((y) => [{ type: "cylinder", l: 90, w: 2, d: 2, h: 30, x: 15, y, z: -10, color: "#f2c230" }, { type: "cylinder", l: 90, w: 2, d: 2, h: 30, x: 15, y, z: 10, color: "#f2c230" }])],
  archclimber: () => [{ type: "pie", angle: 180, inner: 92, t: 90, w: 60, d: 30, h: 2.5, z: -12, color: "#e5352b" }, { type: "pie", angle: 180, inner: 92, t: 90, w: 60, d: 30, h: 2.5, z: 10, color: "#e5352b" },
    ...Array.from({ length: 9 }, (_, i) => { const a = (i / 8) * Math.PI; return { type: "cylinder", t: 90, w: 2, d: 2, h: 22, x: Math.round(-Math.cos(a) * 29 * 100) / 100, y: Math.round(Math.sin(a) * 29 * 100) / 100, z: -11, color: "#f2c230" }; })],
  climbpanel: () => [{ type: "box", w: 40, d: 3, h: 50, color: "#e9e2d6" }, ...Array.from({ length: 10 }, (_, i) => ({ type: "asteroid", bumps: 30, seed: i + 1, w: 5, d: 4, h: 4, x: -14 + ((i * 7) % 28), y: 5 + i * 4.3, z: 2.5, color: PLAY[i % 4] }))],
  divingblock: () => [{ type: "box", w: 30, d: 30, h: 22, color: WHITE }, { type: "wedge", r: 90, w: 30, d: 30, h: 6, y: 22, color: "#1f8fe5" }, { type: "text", text: "3", w: 10, d: 1, h: 12, y: 6, z: 15, color: "#1f8fe5" }],
  fencehap: () => [...Array.from({ length: 9 }, (_, i) => ({ type: "box", w: 4, d: 2, h: 18 + ((i * 5) % 9), x: -24 + i * 6, r: (i % 3) - 1, l: ((i * 7) % 9) - 4, color: WOOD })),
    { type: "box", w: 54, d: 1.5, h: 3, y: 6, z: 1.5, l: 2, color: WOOD }, { type: "box", w: 54, d: 1.5, h: 3, y: 14, z: 1.5, l: -3, color: WOOD }],
  bubblepanel: () => [{ type: "roundedbox", radius: 2, w: 50, d: 4, h: 40, color: "#16b6b0" }, ...[[-14, 26, 9], [4, 28, 12], [17, 12, 8], [-12, 10, 10], [6, 8, 5]].map(([x, y, d]) => ({ type: "cylinder", t: 90, w: d, d, h: 6, x, y, z: -3, hole: true }))],
  confetti: () => Array.from({ length: 30 }, (_, i) => ({ type: "box", w: 3, d: 1.2, h: 0.6, x: ((i * 37) % 50) - 25, z: ((i * 23) % 40) - 20, r: (i * 47) % 180, color: [RED, ORANGE, YELLOW, GREEN, "#1f8fe5", PURPLE][i % 6] })),
  helmet: () => [{ type: "halfsphere", w: 30, d: 34, h: 26, color: "#1f8fe5" }, { type: "halfsphere", w: 26, d: 30, h: 23, y: -0.05, hole: true },
    ...[3, 8].map((y) => ({ type: "pie", angle: 140, inner: 90, w: 32, d: 16, h: 1.6, y, z: 8, color: SILVER })), { type: "box", w: 1.6, d: 2, h: 10, y: 0, z: 16, color: SILVER }],
  dart: () => [{ type: "cylinder", t: 90, w: 12, d: 12, h: 60, y: 6, z: -30, color: "#1f8fe5" }, { type: "halfsphere", t: 90, w: 12, d: 12, h: 6, y: 6, z: 30, color: ORANGE }],
  dartholder: () => [{ type: "box", w: 60, d: 20, h: 30, color: "#1f8fe5" }, ...[-21, -7, 7, 21].map((x) => ({ type: "cylinder", w: 13, d: 13, h: 30, x, y: 5, hole: true }))],
  pail: () => [spunPart([[0, 0], [0.78, 0], [1, 1], [0.93, 1], [0.73, 0.06], [0, 0.06]], { w: 40, d: 40, h: 36, color: "#f2c230" }), { type: "pie", angle: 180, inner: 94, t: 90, w: 40, d: 20, h: 1.5, y: 36, z: -0.75, color: "#1f8fe5" }],
  snowwall: () => { const out = []; for (let r = 0; r < 3; r++) for (let i = 0; i < 6 - r; i++) out.push({ type: "sphere", steps: 12, w: 10, d: 10, h: 10, x: -25 + i * 10 + r * 5, y: r * 8, color: WHITE }); return out; },
  snowmound: () => [{ type: "halfsphere", w: 50, d: 40, h: 16, color: WHITE }, ...[[-10, 4], [8, -6], [2, 10]].map(([x, z]) => ({ type: "sphere", steps: 12, w: 8, d: 8, h: 8, x, z, y: 11, color: WHITE }))],
  snowstack: () => { const out = []; [[0, 0], [10, 0], [5, 8.7], [5, 2.9, 1]].forEach(([x, z, top]) => out.push({ type: "sphere", steps: 12, w: 10, d: 10, h: 10, x, z, y: top ? 7.5 : 0, color: WHITE })); return out; },
  bubblewand: () => [{ type: "torus", tube: 14, t: 90, w: 24, d: 24, h: 2.5, y: 64, z: -1.25, color: "#e8306e" }, { type: "cylinder", w: 3, d: 3, h: 52, color: "#e8306e" }],
  tambourine: () => [{ type: "tube", wall: 10, w: 50, d: 50, h: 8, color: "#c49a6a" }, { type: "cylinder", w: 47, d: 47, h: 0.6, y: 7, color: CREAM },
    ...around(5, 25, (x, z, a) => ({ type: "cylinder", l: 90, r: a, w: 7, d: 7, h: 1.6, x, y: 4, z, color: GOLD }))],
  pallet: () => [...Array.from({ length: 5 }, (_, i) => ({ type: "box", w: 100, d: 14, h: 2.4, y: 12.6, z: -40 + i * 20, color: "#c49a6a" })),
    ...[-40, 0, 40].map((x) => ({ type: "box", w: 10, d: 100, h: 10, x, y: 2.6, color: "#a0783a" })), ...[-40, 40].map((z) => ({ type: "box", w: 100, d: 14, h: 2.6, z, color: "#c49a6a" }))],
  ibc: () => [{ type: "box", w: 50, d: 50, h: 8, color: SILVER }, { type: "roundedbox", radius: 4, w: 46, d: 46, h: 44, y: 8, color: "#f3f4f6", clear: true },
    ...[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([a, b]) => ({ type: "box", w: 1.6, d: 1.6, h: 46, x: a * 24, z: b * 24, y: 8, color: SILVER })),
    ...[22, 36, 52].flatMap((y) => [-24, 24].map((z) => ({ type: "box", w: 50, d: 1.6, h: 1.6, y, z, color: SILVER }))), { type: "cylinder", w: 10, d: 10, h: 3, y: 52, color: "#1f8fe5" }],
  barrelwall: () => [-22, 0, 22].map((x) => spunPart(P2.barrel, { w: 20, d: 20, h: 26, x, color: "#556b3a" })),
  spoolsmall: () => spool(20, 16), spoollarge: () => spool(40, 30), spooldown: () => spool(20, 10), spoolend: () => [{ type: "cylinder", w: 30, d: 30, h: 3, color: "#c49a6a" }, { type: "cylinder", w: 6, d: 6, h: 5, y: -1, hole: true }],
  channelY: () => [{ type: "channel", w: 20, d: 30, h: 12, z: 25, color: "#e0a85a" }, { type: "channel", w: 20, d: 34, h: 12, x: -11, z: -6, r: 30, color: "#e0a85a" }, { type: "channel", w: 20, d: 34, h: 12, x: 11, z: -6, r: -30, color: "#e0a85a" }],
  channelturn: () => [{ type: "pie", angle: 90, inner: 40, w: 54, d: 54, h: 12, color: "#e0a85a" }, { type: "donutslice", angle: 100, r: 45, w: 50, d: 50, h: 14, y: 8, x: 0, z: 0, hole: true }],
  spiralramp: () => [{ type: "cylinder", w: 8, d: 8, h: 50, color: "#9aa0a8" }, ...Array.from({ length: 16 }, (_, i) => { const a = i * 40; return { type: "box", w: 6, d: 16, h: 2, x: Math.round(Math.sin((a * Math.PI) / 180) * 11 * 100) / 100, y: i * 3, z: Math.round(Math.cos((a * Math.PI) / 180) * 11 * 100) / 100, r: a, color: PLAY[i % 4] }; })],
  // sim lab
  trebuchet: () => [{ type: "box", w: 40, d: 24, h: 3, color: WOOD }, ...[-1, 1].map((s) => ({ type: "box", w: 3, d: 3, h: 30, z: s * 9, color: WOOD })),
    { type: "cylinder", t: 90, w: 3, d: 3, h: 22, y: 28, z: -11, color: SILVER }, { type: "box", w: 50, d: 2.5, h: 2.5, y: 27, x: 6, l: -20, color: WOOD },
    { type: "box", w: 8, d: 8, h: 8, x: -16, y: 20, color: DARK }, { type: "halfsphere", w: 6, d: 6, h: 3, x: 29, y: 36, fy: -1, color: WOOD }],
  dominospiral: () => Array.from({ length: 30 }, (_, i) => { const a = i * 0.5, rr = 12 + i * 2.2; return { type: "box", w: 12, d: 4, h: 24, x: Math.round(Math.sin(a) * rr * 100) / 100, z: Math.round(Math.cos(a) * rr * 100) / 100, r: Math.round((a * 180) / Math.PI + 90), color: RAINBOW[i % 6] }; }),
  dominogrid: () => Array.from({ length: 30 }, (_, i) => { const row = Math.floor(i / 10), k = i % 10, x = (row % 2 ? 9 - k : k) * 10 - 45; return { type: "box", w: 4, d: 12, h: 24, x, z: -25 + row * 25, color: RAINBOW[i % 6] }; }),
});
// ---------- Creatures & characters, batch 2: simple toy-style figures made of basic shapes (our own designs) ----------
const FUR = "#a0683a", GREYC = "#9aa0a8", PINKC = "#f5a3c7";
const eyePair = (x, y, z, size = 3) => [-1, 1].map((s) => ({ type: "sphere", steps: 10, w: size, d: size, h: size, x: x + s * size * 0.9, y, z, color: "#2b2f36" }));
const legs4 = (w, d, h, color, dx = w * 0.32, dz = d * 0.32) => [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([a, b]) => ({ type: "cylinder", sides: 16, w, d: w, h, x: a * dx, z: b * dz, color }));
const charm = (parts, color) => [...parts, { type: "torus", tube: 30, w: 7, d: 7, h: 2, z: -15, color }];
Object.assign(KITS, {
  elephant: () => [{ type: "sphere", w: 30, d: 40, h: 26, y: 10, color: GREYC }, ...legs4(8, 8, 14, GREYC, 9, 12), { type: "sphere", w: 20, d: 20, h: 20, y: 22, z: 20, color: GREYC },
    { type: "cylinder", sides: 16, w: 6, d: 6, h: 18, y: 10, z: 30, t: 20, color: GREYC }, ...[-1, 1].map((s) => ({ type: "cylinder", w: 16, d: 3, h: 14, x: s * 11, y: 22, z: 17, r: s * 25, l: s * 80, color: "#b8bec6" })),
    ...eyePair(0, 27, 29, 2.5)],
  frog: () => [{ type: "sphere", w: 30, d: 32, h: 18, color: "#2fa24a" }, ...[-1, 1].map((s) => ({ type: "sphere", w: 9, d: 9, h: 9, x: s * 8, y: 13, z: 9, color: "#2fa24a" })),
    ...[-1, 1].map((s) => ({ type: "sphere", steps: 10, w: 4, d: 4, h: 4, x: s * 8, y: 17, z: 12, color: "#2b2f36" })), ...[-1, 1].map((s) => ({ type: "sphere", w: 12, d: 18, h: 6, x: s * 14, z: -4, color: "#2fa24a" }))],
  lion: () => [{ type: "capsule", t: 90, w: 22, d: 22, h: 44, y: 14, z: -22, color: "#e0a85a" }, ...legs4(7, 7, 12, "#e0a85a", 7, 13), { type: "flower", petals: 12, t: 90, w: 32, d: 32, h: 8, y: 30, z: 18, color: "#a0683a" },
    { type: "sphere", w: 20, d: 18, h: 20, y: 19, z: 22, color: "#e0a85a" }, ...eyePair(0, 31, 30, 2.5), { type: "cylinder", w: 2, d: 2, h: 20, y: 18, z: -26, t: -60, color: "#e0a85a" }],
  squid: () => [{ type: "capsule", w: 18, d: 18, h: 34, y: 14, color: PINKC }, { type: "cone", sides: 4, w: 24, d: 6, h: 10, y: 44, r: 45, color: PINKC }, ...eyePair(0, 30, 8.5, 3),
    ...around(8, 6, (x, z, a) => ({ type: "capsule", w: 3, d: 3, h: 18, x, z, y: 0, t: 25, r: a, color: PINKC }))],
  crocodile: () => [{ type: "roundedbox", radius: 3, w: 18, d: 50, h: 10, y: 4, color: "#3f7a3a" }, { type: "roundedbox", radius: 2, w: 12, d: 24, h: 6, y: 6, z: 34, color: "#3f7a3a" },
    { type: "cone", sides: 4, r: 45, w: 12, d: 12, h: 30, t: -90, y: 9, z: -24, color: "#3f7a3a" }, ...legs4(5, 5, 5, "#3f7a3a", 11, 14), ...eyePair(0, 15, 26, 3),
    ...Array.from({ length: 6 }, (_, i) => ({ type: "pyramid", w: 3, d: 3, h: 3, y: 14, z: -15 + i * 6, color: "#2f5f2a" }))],
  dinosaur: () => [{ type: "sphere", w: 24, d: 40, h: 26, y: 10, color: "#2fa24a" }, ...legs4(8, 8, 12, "#2fa24a", 7, 10), { type: "capsule", w: 9, d: 9, h: 30, y: 24, z: 16, t: 35, color: "#2fa24a" },
    { type: "sphere", w: 12, d: 16, h: 11, y: 46, z: 28, color: "#2fa24a" }, { type: "cone", t: -90, w: 12, d: 12, h: 30, y: 18, z: -16, color: "#2fa24a" }, ...eyePair(0, 50, 33, 2)],
  cobra: () => [{ type: "spring", turns: 3, w: 34, d: 34, h: 12, color: "#3a3a2a" }, { type: "capsule", w: 7, d: 7, h: 24, y: 10, z: 12, color: "#3a3a2a" },
    { type: "sphere", w: 16, d: 6, h: 16, y: 30, z: 13, color: "#3a3a2a" }, ...eyePair(0, 36, 16, 2)],
  duck: () => [{ type: "sphere", w: 26, d: 32, h: 22, color: YELLOW }, { type: "sphere", w: 17, d: 17, h: 17, y: 18, z: 9, color: YELLOW }, { type: "sphere", w: 10, d: 8, h: 4, y: 24, z: 18, color: ORANGE },
    ...eyePair(0, 29, 16, 2.5), { type: "cone", t: -60, w: 10, d: 6, h: 8, y: 14, z: -15, color: YELLOW }],
  whale: () => [{ type: "capsule", t: 90, w: 26, d: 26, h: 64, y: 13, z: -32, color: "#3a6fd8" }, { type: "heart", t: 90, w: 30, d: 12, h: 3, y: 18, z: -38, l: 180, color: "#3a6fd8" },
    ...eyePair(0, 17, 22, 2.5).map((p, i) => ({ ...p, x: i ? 12 : -12, z: 18 })), { type: "box", w: 22, d: 30, h: 3, y: 1, z: 6, color: "#cfe6ff" }],
  cow: () => [{ type: "roundedbox", radius: 4, w: 24, d: 40, h: 20, y: 14, color: WHITE }, ...legs4(6, 6, 14, WHITE, 8, 14), { type: "roundedbox", radius: 4, w: 16, d: 16, h: 16, y: 26, z: 24, color: WHITE },
    { type: "roundedbox", radius: 3, w: 16.4, d: 6, h: 8, y: 25, z: 30, color: PINKC }, ...[[-6, 22, 4], [7, 26, -8], [-3, 30, -14]].map(([x, y, z]) => ({ type: "sphere", w: 10, d: 10, h: 8, x: x * 1.6, y, z, color: "#2b2f36" })),
    ...[-1, 1].map((s) => ({ type: "cone", w: 3, d: 3, h: 5, x: s * 6, y: 42, z: 22, l: s * -30, color: CREAM })), ...eyePair(0, 36, 32, 2.2)],
  bear: () => [{ type: "sphere", w: 34, d: 44, h: 22, color: FUR }, { type: "sphere", w: 20, d: 20, h: 18, y: 6, z: 24, color: FUR }, ...[-1, 1].map((s) => ({ type: "sphere", w: 7, d: 4, h: 7, x: s * 8, y: 22, z: 22, color: FUR })),
    { type: "sphere", w: 8, d: 6, h: 6, y: 10, z: 33, color: "#c49a6a" }, ...eyePair(0, 17, 32, 2.2)],
  polarbear: () => KITS.bear().map((p) => ({ ...p, color: p.color === FUR ? WHITE : p.color === "#c49a6a" ? "#e9e2d6" : p.color })),
  fish: () => [{ type: "sphere", w: 8, d: 18, h: 10, y: 0, color: ORANGE }, { type: "heart", t: 90, w: 9, d: 8, h: 2, y: 5, z: -10, l: 180, color: ORANGE }, ...eyePair(0, 6, 7, 1.6)],
  fishschool: () => [[0, 0, 0], [16, 4, 6], [-14, 6, 4], [6, 12, -10], [-6, 2, -14]].flatMap(([x, y, z], i) => KITS.fish().map((p) => ({ ...p, x: (p.x || 0) + x, y: (p.y || 0) + y, z: (p.z || 0) + z, color: p.color === ORANGE ? ["#1f8fe5", ORANGE, YELLOW, "#16b6b0", RED][i] : p.color }))),
  bee: () => [{ type: "capsule", t: 90, w: 16, d: 16, h: 24, y: 8, z: -12, color: YELLOW }, ...[-4, 2].map((z) => ({ type: "cylinder", t: 90, w: 16.4, d: 16.4, h: 3, y: 8, z, color: "#2b2f36" })),
    ...[-1, 1].map((s) => ({ type: "sphere", w: 12, d: 8, h: 2, x: s * 7, y: 17, z: -1, r: s * 20, color: "#cfe6ff", clear: true })), ...eyePair(0, 11, 11, 2.2)],
  walrus: () => [{ type: "sphere", w: 34, d: 44, h: 26, color: "#8a5a3a" }, { type: "sphere", w: 22, d: 20, h: 20, y: 16, z: 18, color: "#8a5a3a" }, ...[-1, 1].map((s) => ({ type: "cone", fy: -1, w: 3, d: 3, h: 12, x: s * 4, y: 6, z: 27, color: CREAM })),
    ...eyePair(0, 30, 26, 2.2), { type: "sphere", w: 14, d: 8, h: 7, y: 20, z: 27, color: "#a0704a" }],
  turkey: () => [{ type: "sphere", w: 24, d: 26, h: 24, y: 6, color: "#7a4a24" }, { type: "sphere", w: 11, d: 11, h: 11, y: 26, z: 9, color: "#7a4a24" }, { type: "cone", t: 90, w: 3, d: 3, h: 4, y: 30, z: 14, color: ORANGE },
    { type: "capsule", w: 2.5, d: 2.5, h: 6, y: 23, z: 14, color: RED }, ...Array.from({ length: 7 }, (_, i) => ({ type: "sphere", w: 8, d: 2, h: 26, x: (i - 3) * 5.5, y: 12, z: -10, l: (i - 3) * 12, color: [RED, ORANGE, YELLOW, "#7a4a24"][i % 4] })),
    ...legs4(2, 2, 6, ORANGE, 4, 2)],
  chicken: () => [{ type: "sphere", w: 22, d: 26, h: 22, y: 6, color: WHITE }, { type: "sphere", w: 13, d: 13, h: 13, y: 22, z: 9, color: WHITE }, { type: "cone", t: 90, w: 4, d: 4, h: 5, y: 27, z: 15, color: ORANGE },
    ...[0, 1, 2].map((i) => ({ type: "sphere", steps: 10, w: 3, d: 3, h: 4, y: 33, z: 6 + i * 3, color: RED })), ...legs4(2, 2, 7, ORANGE, 4, 2), ...eyePair(0, 30, 13, 1.8)],
  teddy: () => [{ type: "sphere", w: 24, d: 20, h: 26, y: 8, color: FUR }, { type: "sphere", w: 20, d: 18, h: 18, y: 30, color: FUR }, ...[-1, 1].map((s) => ({ type: "sphere", w: 7, d: 4, h: 7, x: s * 8, y: 45, color: FUR })),
    ...[-1, 1].map((s) => ({ type: "capsule", w: 7, d: 7, h: 14, x: s * 13, y: 14, l: s * 40, color: FUR })), ...[-1, 1].map((s) => ({ type: "sphere", w: 9, d: 12, h: 8, x: s * 7, z: 6, color: FUR })),
    { type: "sphere", w: 8, d: 6, h: 6, y: 35, z: 8, color: "#c49a6a" }, ...eyePair(0, 40, 7.5, 2)],
  reindeer: () => [{ type: "capsule", t: 90, w: 18, d: 18, h: 36, y: 20, z: -18, color: "#8a5a3a" }, ...legs4(4, 4, 16, "#8a5a3a", 5, 12), { type: "capsule", w: 7, d: 7, h: 16, y: 26, z: 18, t: 30, color: "#8a5a3a" },
    { type: "sphere", w: 10, d: 14, h: 10, y: 38, z: 24, color: "#8a5a3a" }, { type: "sphere", steps: 10, w: 4, d: 4, h: 4, y: 40, z: 31, color: RED },
    ...[-1, 1].flatMap((s) => [{ type: "cylinder", w: 1.6, d: 1.6, h: 12, x: s * 4, y: 42, z: 22, l: s * -25, color: "#c49a6a" }, { type: "cylinder", w: 1.4, d: 1.4, h: 6, x: s * 7, y: 48, z: 22, l: s * 30, color: "#c49a6a" }])],
  snake: () => [...Array.from({ length: 6 }, (_, i) => ({ type: "capsule", t: 90, w: 8, d: 8, h: 18, x: Math.sin(i * 1.2) * 8, y: 4, z: -40 + i * 13, r: Math.cos(i * 1.2) * 35, color: "#2fa24a" })),
    { type: "sphere", w: 12, d: 14, h: 9, y: 0, z: 40, color: "#2fa24a" }, ...eyePair(0, 7, 44, 2.5), { type: "box", w: 1, d: 6, h: 1, y: 3, z: 49, color: RED }],
  koala: () => [{ type: "sphere", w: 22, d: 20, h: 24, color: GREYC }, { type: "sphere", w: 20, d: 18, h: 18, y: 20, color: GREYC }, ...[-1, 1].map((s) => ({ type: "sphere", w: 12, d: 5, h: 12, x: s * 11, y: 30, color: "#b8bec6" })),
    { type: "sphere", w: 6, d: 4, h: 8, y: 23, z: 9, color: "#2b2f36" }, ...eyePair(0, 30, 8, 2)],
  sheep: () => [...[[-6, 6, 0], [6, 6, 0], [0, 8, -8], [0, 8, 8], [0, 12, 0]].map(([x, y, z]) => ({ type: "sphere", steps: 12, w: 16, d: 16, h: 14, x, y, z, color: WHITE })), ...legs4(4, 4, 8, "#2b2f36", 6, 8),
    { type: "sphere", w: 10, d: 12, h: 10, y: 12, z: 16, color: "#2b2f36" }, ...eyePair(0, 17, 21, 1.8).map((p) => ({ ...p, color: WHITE }))],
  seal: () => [{ type: "capsule", t: 90, w: 18, d: 18, h: 44, y: 9, z: -22, color: "#e9e2d6" }, { type: "heart", t: 90, w: 16, d: 8, h: 2, y: 6, z: -26, l: 180, color: "#e9e2d6" },
    ...[-1, 1].map((s) => ({ type: "sphere", w: 10, d: 4, h: 3, x: s * 10, y: 2, z: 6, r: s * 30, color: "#e9e2d6" })), ...eyePair(0, 14, 20, 2.6), { type: "sphere", steps: 8, w: 2, d: 2, h: 2, y: 10, z: 22, color: "#2b2f36" }],
  ghost: () => [spunPart([[0, 0], [1, 0], [1, 0.62], [0.82, 0.88], [0.45, 1], [0, 1]], { w: 26, d: 26, h: 34, color: WHITE }), ...[-1, 1].map((s) => ({ type: "capsule", t: 90, w: 4, d: 4, h: 6, x: s * 4.5, y: 24, z: 9, color: "#2b2f36" })),
    { type: "sphere", w: 5, d: 4, h: 6, y: 16, z: 11.5, color: "#2b2f36" }],
  blockhead: () => [{ type: "box", w: 20, d: 20, h: 20, y: 12, color: "#f2c9a0" }, { type: "box", w: 20.4, d: 20.4, h: 5, y: 28, color: "#7a4a24" }, { type: "box", w: 12, d: 12, h: 12, color: "#1f8fe5" },
    ...[-1, 1].map((s) => ({ type: "box", w: 4, d: 1, h: 4, x: s * 5, y: 21, z: 10.2, color: "#2b2f36" })), { type: "box", w: 8, d: 1, h: 2, y: 15, z: 10.2, color: RED }],
  kid: () => [{ type: "cylinder", w: 14, d: 14, h: 18, color: "#e5352b" }, { type: "sphere", w: 13, d: 13, h: 13, y: 17, color: SKIN }, ...[-1, 1].map((s) => ({ type: "capsule", w: 4, d: 4, h: 14, x: s * 9, y: 13, l: s * -35, color: SKIN })),
    { type: "halfsphere", w: 13.6, d: 13.6, h: 5, y: 24.5, color: "#7a4a24" }, ...eyePair(0, 24, 6, 1.6)],
  sneaker: () => [{ type: "roundedbox", radius: 3, w: 18, d: 44, h: 4, color: WHITE }, { type: "roundedbox", radius: 5, w: 16, d: 40, h: 12, y: 3, color: RED }, { type: "box", w: 14, d: 14, h: 4, y: 14, z: -12, color: RED },
    ...[0, 1, 2].map((i) => ({ type: "box", w: 12, d: 1, h: 1, y: 14, z: 2 + i * 4, color: WHITE }))],
  flipflop: () => [{ type: "scribble", path: [[0.5, 0], [0.9, 0.1], [1, 0.35], [0.85, 0.65], [0.9, 0.9], [0.5, 1], [0.1, 0.9], [0.15, 0.65], [0, 0.35], [0.1, 0.1]], w: 30, d: 70, h: 4, color: "#1f8fe5" },
    { type: "pie", angle: 140, inner: 85, t: 90, w: 26, d: 10, h: 2, y: 4, z: 8, color: PINKC }],
  flipper: () => [{ type: "roundedbox", radius: 4, w: 30, d: 30, h: 14, z: -20, color: "#2fa24a" }, { type: "scribble", path: [[0.2, 0], [0.8, 0], [1, 1], [0, 1]], w: 40, d: 50, h: 2, z: 20, color: "#2fa24a" }],
  scuba: () => [{ type: "roundedbox", radius: 5, w: 44, d: 14, h: 22, y: 6, color: "#1f8fe5" }, { type: "box", w: 36, d: 16, h: 14, y: 10, hole: true }, { type: "box", w: 36, d: 1, h: 14, y: 10, z: 6, color: "#cfe6ff", clear: true },
    { type: "torus", tube: 10, w: 56, d: 40, h: 3, y: 15, z: -14, color: "#2b2f36" }],
  tricorn: () => [{ type: "polygon", sides: 3, w: 44, d: 40, h: 3, color: "#2b2f36" }, { type: "cone", top: 70, w: 22, d: 22, h: 12, y: 3, color: "#2b2f36" }, { type: "tube", wall: 6, w: 44.4, d: 40.4, h: 3.4, sides: 3, color: GOLD }],
  beanie: () => [{ type: "halfsphere", w: 30, d: 30, h: 22, y: 4, color: RED }, { type: "cylinder", w: 30.4, d: 30.4, h: 6, color: WHITE }, { type: "sphere", steps: 12, w: 8, d: 8, h: 8, y: 24, color: WHITE }],
  beret: () => [{ type: "cylinder", w: 34, d: 34, h: 4, y: 3, color: RED }, { type: "halfsphere", w: 34, d: 34, h: 5, y: 7, color: RED }, { type: "tube", wall: 8, w: 26, d: 26, h: 3, color: "#8c1f1a" }, { type: "cylinder", w: 2, d: 2, h: 4, y: 11, color: "#8c1f1a" }],
  bunnyear: () => [{ type: "sphere", w: 10, d: 5, h: 36, color: WHITE }, { type: "sphere", w: 6, d: 3, h: 28, y: 4, z: 1.5, color: PINKC }],
  bunnyearbent: () => [{ type: "sphere", w: 10, d: 5, h: 22, color: WHITE }, { type: "sphere", w: 10, d: 5, h: 18, y: 16, x: 6, l: -60, color: WHITE }, { type: "sphere", w: 6, d: 3, h: 16, y: 3, z: 1.5, color: PINKC }],
  chickfoot: () => [{ type: "capsule", w: 3, d: 3, h: 14, color: ORANGE }, ...[-30, 0, 30].map((a) => ({ type: "capsule", t: 90, r: a, w: 2.4, d: 2.4, h: 10, z: 0, color: ORANGE }))],
  paw: () => [{ type: "sphere", w: 14, d: 16, h: 10, color: "#e9e2d6" }, ...[-1, 1].map((s) => ({ type: "sphere", w: 6, d: 7, h: 6, x: s * 3, z: 7, color: "#2b2f36" }))],
  buglegs: () => [{ type: "capsule", w: 3, d: 3, h: 16, color: "#2b2f36" }, { type: "capsule", w: 2.4, d: 2.4, h: 14, y: 12, x: 4, l: -50, color: "#2b2f36" }, { type: "cone", w: 2.4, d: 2.4, h: 6, y: 18, x: 12, l: -70, color: "#2b2f36" }],
  feather: () => [{ type: "scribble", path: [[0.5, 0], [0.8, 0.15], [0.95, 0.45], [0.75, 0.8], [0.5, 1], [0.25, 0.8], [0.05, 0.45], [0.2, 0.15]], w: 14, d: 50, h: 1.2, color: "#7cc0ff" }, { type: "box", w: 1, d: 60, h: 1.6, z: 5, color: WHITE }],
  axe2: () => [{ type: "cylinder", t: 90, w: 4, d: 4, h: 70, y: 2, z: -35, color: WOOD }, ...[-1, 1].map((s) => ({ ...turnedSlice(100, 22, 0, s > 0 ? 90 : 270, { h: 3, y: 0.5, color: SILVER }, 0, 25) })),
    { type: "box", w: 8, d: 8, h: 4, y: 0, z: 25, color: SILVER }],
  anvil: () => [{ type: "box", w: 26, d: 18, h: 6, color: DARK }, { type: "box", w: 14, d: 10, h: 12, y: 6, color: DARK }, { type: "box", w: 34, d: 16, h: 8, y: 18, color: DARK }, { type: "cone", l: -90, w: 8, d: 14, h: 14, x: 16.5, y: 22, color: DARK }],
  spartan: () => [{ type: "halfsphere", w: 26, d: 28, h: 22, y: 10, color: GOLD }, { type: "box", w: 22, d: 20, h: 12, y: 4, color: GOLD }, { type: "box", w: 4, d: 20, h: 18, y: 0, z: 6, hole: true },
    { type: "box", w: 14, d: 8, h: 8, y: 8, z: 12, hole: true }, { type: "pie", angle: 180, inner: 0, t: 90, r: 90, w: 30, d: 15, h: 4, y: 30, x: 0, color: RED }],
  cufflink: () => [{ type: "cylinder", w: 16, d: 16, h: 3, y: 10, color: GOLD }, { type: "cylinder", w: 3, d: 3, h: 10, color: GOLD }, { type: "capsule", t: 90, l: 90, w: 4, d: 4, h: 14, x: -7, y: 0, color: GOLD }],
  // charms and singles
  skullcharm: () => charm([{ type: "sphere", w: 20, d: 18, h: 6, color: WHITE }, { type: "box", w: 12, d: 6, h: 6, z: 9, color: WHITE }, ...[-1, 1].map((s) => ({ type: "sphere", steps: 10, w: 5, d: 5, h: 8, x: s * 4, z: 1, y: -1, hole: true })),
    { type: "pyramid", sides: 3, w: 3, d: 3, h: 8, z: 5, y: -1, hole: true }], WHITE),
  actioncharm: () => charm([{ type: "lightning", w: 18, d: 26, h: 3, color: YELLOW }], YELLOW),
  periodiccharm: () => charm([{ type: "box", w: 22, d: 22, h: 3, color: GOLD }, { type: "text", text: "Au", w: 14, d: 2, h: 9, t: -90, y: 3, z: 4, color: "#8c6a1a" }], GOLD),
  astrocharm: () => charm([{ type: "cylinder", w: 24, d: 24, h: 3, color: "#1d3a8a" }, ...KITS.rocket().map((p) => ({ ...p, w: p.w * 0.35, d: p.d * 0.35, h: p.h * 0.35, x: (p.x || 0) * 0.35, y: 3 + (p.y || 0) * 0.35, z: (p.z || 0) * 0.35, t: (p.t || 0) - 90 }))], SILVER),
  viewcube: () => [{ type: "roundedbox", radius: 1.5, w: 30, d: 30, h: 30, color: "#f3f4f6" }, { type: "text", text: "FRONT", w: 22, d: 1, h: 5, y: 12, z: 15, color: "#6b7280" },
    { type: "text", text: "TOP", w: 14, d: 1, h: 5, t: -90, y: 30, z: 4, color: "#6b7280" }, { type: "text", text: "RIGHT", w: 22, d: 1, h: 5, r: 90, x: 15, y: 12, color: "#6b7280" }],
  bridge: () => [{ type: "box", w: 100, d: 24, h: 4, y: 22, color: STONE }, { type: "box", w: 100, d: 24, h: 26, color: STONE }, { type: "roundroof", w: 50, d: 26, h: 21, y: -0.1, hole: true },
    ...[-1, 1].map((s) => ({ type: "box", w: 100, d: 2, h: 4, y: 26, z: s * 11, color: STONE }))],
});
const KIT_ICONS = {
  led: '<path d="M14 30V14a8 8 0 0 1 16 0v16z" fill="#e5352b"/><path d="M12 30h20v4H12z" fill="#b8231b"/><path d="M18 34v8M26 34v6" stroke="#9aa0a8" stroke-width="2"/>',
  battery: '<rect x="13" y="8" width="18" height="32" rx="2" fill="#333"/><rect x="18" y="4" width="8" height="4" fill="#c4c9d0"/><rect x="13" y="12" width="18" height="6" fill="#f2c230"/>',
  button: '<rect x="8" y="16" width="28" height="16" rx="2" fill="#333"/><ellipse cx="22" cy="16" rx="8" ry="4" fill="#9aa0a8"/><path d="M12 32v6M32 32v6" stroke="#c4c9d0" stroke-width="2.5"/>',
  servo: '<rect x="12" y="12" width="20" height="26" fill="#1f8fe5"/><rect x="4" y="18" width="36" height="4" fill="#1675c0"/><circle cx="26" cy="10" r="5" fill="#fff" stroke="#1675c0"/><rect x="16" y="8" width="20" height="4" rx="2" fill="#fff" stroke="#9aa0a8"/>',
  board: '<rect x="4" y="9" width="36" height="27" rx="2" fill="#1f7a36"/><rect x="2" y="13" width="9" height="7" fill="#c4c9d0"/><rect x="18" y="20" width="16" height="6" fill="#333"/><rect x="12" y="10" width="26" height="3" fill="#333"/><circle cx="8" cy="32" r="1.6" fill="#fff"/><circle cx="36" cy="32" r="1.6" fill="#fff"/>',
  breadboard: '<rect x="3" y="10" width="38" height="25" rx="2" fill="#fff" stroke="#9aa0a8"/><path d="M5 22h34" stroke="#c4c9d0" stroke-width="2"/><path d="M6 13h32" stroke="#e5352b"/><path d="M6 32h32" stroke="#1f8fe5"/><g fill="#9aa0a8"><circle cx="10" cy="17" r="1"/><circle cx="15" cy="17" r="1"/><circle cx="20" cy="17" r="1"/><circle cx="25" cy="17" r="1"/><circle cx="30" cy="17" r="1"/><circle cx="35" cy="17" r="1"/><circle cx="10" cy="27" r="1"/><circle cx="15" cy="27" r="1"/><circle cx="20" cy="27" r="1"/><circle cx="25" cy="27" r="1"/><circle cx="30" cy="27" r="1"/><circle cx="35" cy="27" r="1"/></g>',
  balljoint: '<rect x="18" y="22" width="8" height="18" fill="#9aa0a8"/><circle cx="22" cy="16" r="11" fill="#b8bec6"/><circle cx="18" cy="12" r="3" fill="#e2e5e9"/>',
  smiley: '<circle cx="22" cy="22" r="17" fill="#f2c230"/><circle cx="16" cy="17" r="2.5" fill="#7a5b00"/><circle cx="28" cy="17" r="2.5" fill="#7a5b00"/><path d="M13 25a9 9 0 0 0 18 0" fill="none" stroke="#7a5b00" stroke-width="3" stroke-linecap="round"/>',
  cloud: '<path d="M12 34a8 8 0 0 1 0-16 11 11 0 0 1 21-2 9 9 0 0 1-1 18z" fill="#1f8fe5"/>',
  paw: '<g fill="#7a4a24"><ellipse cx="22" cy="29" rx="9" ry="8"/><ellipse cx="11" cy="19" rx="3.5" ry="4.5"/><ellipse cx="18" cy="12" rx="3.5" ry="4.5"/><ellipse cx="26" cy="12" rx="3.5" ry="4.5"/><ellipse cx="33" cy="19" rx="3.5" ry="4.5"/></g>',
  note: '<ellipse cx="15" cy="34" rx="7" ry="5" fill="#333" transform="rotate(-20 15 34)"/><rect x="20" y="8" width="3" height="26" fill="#333"/><path d="M22 8c4 3 10 5 10 12-2-4-6-5-10-5z" fill="#333"/>',
  puzzle: '<path d="M8 10h10a4 4 0 1 0 8 0h10v10a4 4 0 1 1 0 8v10H26a4 4 0 1 0-8 0H8V28a4 4 0 1 1 0-8z" fill="#2fa24a"/>',
  gift: '<rect x="8" y="16" width="28" height="22" fill="#e5352b"/><rect x="19" y="16" width="6" height="22" fill="#2fa24a"/><rect x="6" y="12" width="32" height="6" fill="#e5352b"/><path d="M22 12c-6-8-12-4-8 0zM22 12c6-8 12-4 8 0z" fill="#2fa24a"/>',
  cubeframe: '<path d="M8 14l14-7 14 7v16l-14 7-14-7z M12 16v12l10 5 10-5V16l-10-5z" fill="#e5352b" fill-rule="evenodd"/>',
  staroutline: '<path d="M22 5l4.5 11.5L38 17l-9 7.5 3 11.5-10-6.5L12 36l3-11.5L6 17l11.5-.5z M22 13l-2.6 6.6-6.6.3 5.2 4.3-1.7 6.6 5.7-3.7 5.7 3.7-1.7-6.6 5.2-4.3-6.6-.3z" fill="#f2c230" fill-rule="evenodd"/>',
  heartoutline: '<path d="M22 37C10 28 6 22 6 16a8 8 0 0 1 16-2 8 8 0 0 1 16 2c0 6-4 12-16 21z M22 30c7-6 10-10 10-14a4 4 0 0 0-8-1h-4a4 4 0 0 0-8 1c0 4 3 8 10 14z" fill="#e5352b" fill-rule="evenodd"/>',
  clover: '<g fill="#2fa24a"><path transform="translate(22 20) rotate(0) translate(0 -9)" d="M0 7C-8 1-10-5-5-7.5C-2.5-8.5 0-6.5 0-5C0-6.5 2.5-8.5 5-7.5C10-5 8 1 0 7Z"/><path transform="translate(22 20) rotate(120) translate(0 -9)" d="M0 7C-8 1-10-5-5-7.5C-2.5-8.5 0-6.5 0-5C0-6.5 2.5-8.5 5-7.5C10-5 8 1 0 7Z"/><path transform="translate(22 20) rotate(240) translate(0 -9)" d="M0 7C-8 1-10-5-5-7.5C-2.5-8.5 0-6.5 0-5C0-6.5 2.5-8.5 5-7.5C10-5 8 1 0 7Z"/><path d="M21 21q2 9 7 18l2.5-1q-5-8-6.5-17z"/></g>',
  fan: '<g fill="#333"><circle cx="22" cy="22" r="5"/><ellipse cx="22" cy="10" rx="5" ry="9"/><ellipse cx="22" cy="10" rx="5" ry="9" transform="rotate(120 22 22)"/><ellipse cx="22" cy="10" rx="5" ry="9" transform="rotate(240 22 22)"/></g>',
  book: '<rect x="6" y="8" width="30" height="30" rx="2" fill="#1f8fe5"/><rect x="10" y="10" width="28" height="28" fill="#fff" stroke="#c4c9d0"/><rect x="6" y="8" width="6" height="30" fill="#1675c0"/>',
  power: '<path d="M14 12a14 14 0 1 0 16 0" fill="none" stroke="#1f8fe5" stroke-width="5" stroke-linecap="round"/><path d="M22 4v16" stroke="#1f8fe5" stroke-width="5" stroke-linecap="round"/>',
  table: '<path d="M4 14h36v5H4z" fill="#7a4a24"/><path d="M7 19h4v19H7zM33 19h4v19h-4z" fill="#5c3518"/>',
  window: '<rect x="6" y="6" width="32" height="32" fill="#fff" stroke="#9aa0a8" stroke-width="2"/><path d="M10 10h10v10H10zM24 10h10v10H24zM10 24h10v10H10zM24 24h10v10H24z" fill="#cfe6ff"/>',
  beadring: '<g fill="#f08a1c">' + Array.from({ length: 10 }, (_, i) => { const a = (i / 10) * Math.PI * 2; return `<rect x="${(19 + Math.sin(a) * 14).toFixed(1)}" y="${(19 + Math.cos(a) * 14).toFixed(1)}" width="6" height="6" rx="1"/>`; }).join("") + "</g>",
  cubestack: '<path d="M22 4l16 8v20l-16 8-16-8V12z" fill="#e5352b"/><path d="M6 12l16 8 16-8M22 20v20M14 8l16 8M6 22l16 8 16-8M30 8L14 16" stroke="#9c1e16" stroke-width="1.3" fill="none"/>',
  stairs: '<path d="M6 38V32h6v-6h6v-6h6v-6h6V8h6v30z" fill="#2fa24a"/>',
  ladder: '<path d="M12 4h4v36h-4zM28 4h4v36h-4z" fill="#7a4a24"/><path d="M16 9h12M16 16h12M16 23h12M16 30h12M16 37h12" stroke="#a0683a" stroke-width="3"/>',
  fence: '<g fill="#fff" stroke="#9aa0a8"><path d="M5 38V12l3-4 3 4v26zM15 38V12l3-4 3 4v26zM25 38V12l3-4 3 4v26zM35 38V12l3-4 3 4v26z"/><rect x="3" y="18" width="38" height="4"/><rect x="3" y="28" width="38" height="4"/></g>',
  bricks: '<g fill="#b5452e" stroke="#fff" stroke-width="1.5"><rect x="3" y="8" width="13" height="7"/><rect x="16" y="8" width="13" height="7"/><rect x="29" y="8" width="12" height="7"/><rect x="3" y="15" width="7" height="7"/><rect x="10" y="15" width="13" height="7"/><rect x="23" y="15" width="13" height="7"/><rect x="36" y="15" width="5" height="7"/><rect x="3" y="22" width="13" height="7"/><rect x="16" y="22" width="13" height="7"/><rect x="29" y="22" width="12" height="7"/><rect x="3" y="29" width="7" height="7"/><rect x="10" y="29" width="13" height="7"/><rect x="23" y="29" width="13" height="7"/><rect x="36" y="29" width="5" height="7"/></g>',
  house: '<path d="M8 20h28v18H8z" fill="#fff" stroke="#9aa0a8"/><path d="M4 21L22 6l18 15z" fill="#7a4a24"/><rect x="18" y="27" width="8" height="11" fill="#7a4a24"/><rect x="28" y="24" width="5" height="5" fill="#7cc0ff"/>',
  tree: '<path d="M22 3L8 30h28z" fill="#2fa24a"/><rect x="19" y="30" width="6" height="10" fill="#7a4a24"/>',
  burger: '<path d="M6 20a16 12 0 0 1 32 0z" fill="#e0a85a"/><rect x="5" y="20" width="34" height="4" fill="#f2c230"/><rect x="6" y="24" width="32" height="6" rx="2" fill="#7a4a24"/><rect x="6" y="30" width="32" height="6" rx="3" fill="#e0a85a"/>',
  flange: '<ellipse cx="22" cy="30" rx="18" ry="8" fill="#9aa0a8"/><path d="M14 12v16a8 4 0 0 0 16 0V12z" fill="#c4c9d0"/><ellipse cx="22" cy="12" rx="8" ry="4" fill="#e2e5e9"/><ellipse cx="22" cy="12" rx="4" ry="2" fill="#6b7280"/>',
  pizza: '<path d="M22 42L4 8a40 40 0 0 1 36 0z" fill="#ffd34d"/><path d="M4 8a40 40 0 0 1 36 0l-2.5 5a35 35 0 0 0-31 0z" fill="#c98a3e"/><g fill="#c0392b"><circle cx="17" cy="17" r="3.4"/><circle cx="28" cy="18" r="3.4"/><circle cx="22" cy="28" r="3"/></g>',
  pieslice: '<path d="M4 18l18 10 18-10-18-7z" fill="#f0c27a"/><path d="M4 18l18 10v8L4 26z" fill="#8e1b3a"/><path d="M22 28l18-10v8l-18 10z" fill="#6d1430"/><path d="M4 26l18 10v3L4 29zM22 36l18-10v3l-18 10z" fill="#e0a85a"/><path d="M10 17l8 3M17 14l9 4M24 13l8 3" stroke="#c98a3e" stroke-width="1.6"/><path d="M33 13.5l7 4.5v8l-7-4z" fill="#c98a3e"/>',
  eye: '<circle cx="22" cy="22" r="17" fill="#fff" stroke="#9aa0a8"/><circle cx="25" cy="25" r="7" fill="#333"/><circle cx="27" cy="23" r="2" fill="#fff"/>',
  glasses: '<g fill="none" stroke="#e8306e" stroke-width="3.5"><circle cx="12" cy="24" r="8"/><circle cx="32" cy="24" r="8"/><path d="M20 22h4M4 22l-1-8M40 22l1-8"/></g>',
  tophat: '<rect x="12" y="6" width="20" height="26" fill="#333"/><rect x="12" y="24" width="20" height="5" fill="#e5352b"/><ellipse cx="22" cy="34" rx="18" ry="4" fill="#333"/>',
  crown: '<path d="M6 34V14l8 8 8-12 8 12 8-8v20z" fill="#f2c230"/><circle cx="22" cy="27" r="3" fill="#e5352b"/><circle cx="12" cy="28" r="2" fill="#1f8fe5"/><circle cx="32" cy="28" r="2" fill="#2fa24a"/>',
  icecream: '<path d="M13 20h18l-9 22z" fill="#e0a85a"/><circle cx="22" cy="15" r="10" fill="#f58db0"/>',
  sword: '<path d="M20 4h4v24h-4z" fill="#c4c9d0"/><path d="M20 4l2-3 2 3z" fill="#c4c9d0"/><rect x="12" y="28" width="20" height="4" fill="#f2c230"/><rect x="20" y="32" width="4" height="8" fill="#7a4a24"/><circle cx="22" cy="41" r="2.5" fill="#f2c230"/>',
  snowman: '<circle cx="22" cy="32" r="10" fill="#fff" stroke="#9aa0a8"/><circle cx="22" cy="17" r="7.5" fill="#fff" stroke="#9aa0a8"/><circle cx="22" cy="6" r="5" fill="#fff" stroke="#9aa0a8"/><path d="M22 7l6 1-6 1z" fill="#f08a1c"/>',
  person: '<rect x="13" y="20" width="18" height="20" rx="3" fill="#1f8fe5"/><circle cx="22" cy="13" r="9" fill="#f2c9a0"/>',
  hardhat: '<path d="M8 30a14 14 0 0 1 28 0z" fill="#f2c230"/><rect x="4" y="29" width="36" height="4" rx="2" fill="#cf9c12"/><rect x="20" y="16" width="4" height="13" fill="#cf9c12"/>',
  propeller: '<path d="M10 34a12 12 0 0 1 24 0z" fill="#e5352b"/><rect x="21" y="16" width="2" height="7" fill="#9aa0a8"/><rect x="6" y="13" width="32" height="4" rx="2" fill="#1f8fe5"/>',
  mustache: '<path d="M22 22c-4-6-14-6-18 2 6-2 10 2 18 0zM22 22c4-6 14-6 18 2-6-2-10 2-18 0z" fill="#7a4a24"/>',
};
const kit = (key, label, words, multi = true) => ({ type: "group", label, kit: key, multi, words, icon: KIT_ICONS[key] });
const pre = (type, label, extra, words) => ({ type, label, extra, words, thumb: true }); // a preset drawn as its own picture
const braillePlate = (txt) => { const z = brailleSize(txt); return { text: txt, w: z.w, d: z.d, h: z.h }; };
// a small drawing of a braille tile, its dots in the right places
const brailleIcon = (txt) => {
  const cells = brailleCells(txt), n = cells.length, cw = 30 / Math.max(n, 1);
  const dots = cells.flatMap((c, i) => c.map((d) => `<circle cx="${(7 + i * cw + (d > 3 ? cw * 0.45 : cw * 0.12) + 2).toFixed(1)}" cy="${(16 + ((d - 1) % 3) * 6).toFixed(1)}" r="2.2"/>`)).join("");
  return `<rect x="3" y="10" width="38" height="24" rx="3" fill="#fff" stroke="#9aa0a8"/><g fill="#333">${dots}</g>`;
};
const brailleTile = (txt, label) => ({ type: "braille", label: label || `Braille ${txt}`, extra: braillePlate(txt), icon: brailleIcon(txt), compact: true,
  words: `braille ${txt} ${label || ""} tile dots tactile` });
const PATH = { egg: [[0.000,0.000],[0.401,0.062],[0.600,0.125],[0.746,0.188],[0.854,0.250],[0.930,0.312],[0.978,0.375],[1.000,0.438],[0.997,0.500],[0.970,0.562],[0.920,0.625],[0.848,0.688],[0.754,0.750],[0.639,0.812],[0.499,0.875],[0.323,0.938],[0.000,1.000]], bottle: [[0.000,0.000],[1.000,0.000],[1.000,0.620],[0.850,0.700],[0.420,0.800],[0.380,0.950],[0.450,0.960],[0.450,1.000],[0.000,1.000]], top: [[0.000,0.000],[0.150,0.050],[0.600,0.300],[1.000,0.450],[0.900,0.550],[0.250,0.620],[0.100,0.650],[0.100,1.000],[0.000,1.000]] };
const CATEGORIES = [
  ["basic", "Basic shapes", [
    "holebox", "holecylinder", hole("sphere", "Hole sphere"), hole("cone", "Hole cone"),
    "box", "cylinder", "sphere", "scribble", "spun", "cone", "pyramid", "roof", "text",
    { type: "import", label: "Import photo", words: "image picture photo png jpg jpeg graphic svg file import logo trace relief lithophane drawing",
      icon: '<rect x="6" y="8" width="32" height="28" rx="2" fill="#fff" stroke="#1f8fe5" stroke-width="2"/><path d="M9 33l9-11 6 7 4-4 7 8z" fill="#2fa24a"/><circle cx="30" cy="15" r="3.5" fill="#f2c230"/>' },
    "roundroof", "halfsphere", "torus", "tube", "ring", "wedge", "polygon", "icosahedron", "star", "heart", "roundedbox",
    "diamond", "paraboloid", "hexagon", "capsule", "bowl", kit("dice", "Dice", "die d6 game pips")]],
  ["text", "Letters and numbers", [
    hole("text", "Hole text", { text: "Text" }), "text",
    { type: "braille", label: "Braille text", extra: braillePlate("braille"), words: "braille blind tactile type any words sign label accessible" },
    ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!?&#@".split("").map((ch) => letter(ch)),
    ..."abcdefghijklmnopqrstuvwxyz".split("").map((ch) => letter(ch)),
    ...[..."ÁÉÍÓÚÑÜáéíóúñü¡¿.,:;-+=/()%$€£°±×÷½¼¾©®™↑↓<>"].map((ch) => letter(ch)),
    pre("arrow", "Right arrow", { w: 20, d: 12, h: 5, color: "#1f8fe5" }, "arrow right"), pre("arrow", "Left arrow", { w: 20, d: 12, h: 5, r: 180, color: "#1f8fe5" }, "arrow left"),
    pre("plus", "Plus sign", { w: 16, d: 16, h: 5, color: "#1f8fe5" }, "math"), pre("minus", "Minus sign", { w: 16, d: 4, h: 5, color: "#1f8fe5" }, "math"),
    pre("times", "Times sign", { w: 16, d: 16, h: 5, color: "#1f8fe5" }, "math multiply"), pre("divide", "Divide sign", { w: 16, d: 16, h: 5, color: "#1f8fe5" }, "math"),
    pre("equals", "Equals sign", { w: 16, d: 11, h: 5, color: "#1f8fe5" }, "math"),
    ..."abcdefghijklmnopqrstuvwxyz".split("").map((ch) => brailleTile(ch)),
    ..."1234567890".split("").map((ch) => brailleTile(ch)),
    brailleTile(".", "Braille full stop"), brailleTile(",", "Braille comma"), brailleTile("?", "Braille question mark"),
    brailleTile("!", "Braille exclamation mark"), brailleTile("-", "Braille hyphen")]],
  ["connectors", "Connectors and hardware", [
    hole("cylinder", "Screw hole", { w: 3.4, d: 3.4, h: 20 }), hole("polygon", "Nut trap", { sides: 6, w: 6.4, d: 5.6, h: 2.6 }),
    hole("pin", "Peg hole", { w: 8.4, d: 8.4, h: 16 }), hole("dovetail", "Dovetail slot", { w: 12.4, d: 20.4, h: 8.2 }),
    hole("keyhole", "Keyhole hanger", { w: 9, d: 18, h: 10 }),
    "screw", "bolt", "nut", { type: "tube", label: "Washer", extra: { wall: 30, w: 16, d: 16, h: 1.6 }, words: "spacer ring flat" },
    { type: "nut", label: "Hex standoff", extra: { bore: 50, w: 6.4, d: 5.6, h: 10, color: "#c4a24a" }, words: "spacer pillar pcb mount" },
    { type: "gear", label: "Knurled knob", extra: { teeth: 30, w: 20, d: 20, h: 10, color: "#333333" }, words: "dial grip handle" },
    "pin", "dovetail", kit("balljoint", "Ball joint", "ball socket swivel pivot", false), "gear", "spring", "bracket", "hook",
    kit("bearing", "Ball bearing", "bearing race skate"), kit("eyebolt", "Eye bolt", "pull ring loop", false), kit("dring", "D-ring", "loop strap", false),
    pre("spun", "Suction cup", { path: P2.cup, w: 30, d: 30, h: 16, clear: true, color: "#7cc0ff" }, "sucker"),
    pre("spun", "Rubber foot", { path: P2.foot, w: 20, d: 20, h: 8, color: "#2b2f36" }, "bumper pad"),
    pre("spun", "Mushroom knob", { path: P2.knob, w: 24, d: 24, h: 14, color: "#9aa0a8" }, "handle pull"),
    kit("snapball", "Snap ball", "double ball joint connector", false), kit("balllink", "Ball link", "rod connector", false),
    kit("hinge", "Hinge", "door lid pivot", false), kit("clip", "Cable clip", "wire holder", false), kit("hub", "Connector cube", "hub block holes", false),
    kit("chain", "Chain", "links", false),
    kit("ball", "Ball", "ball joint stud"), kit("angledball", "Angled ball", "ball joint"), kit("supportball", "Support ball", "ball joint base"), kit("lockball", "Lock ball", "ball joint"),
    kit("rotball", "Rotating ball", "ball joint swivel"), kit("ballhandle", "Ball handle", "ball joint"), kit("socket", "Ball socket", "socket ball joint"), kit("vsocket", "Vertical socket", "socket ball joint"),
    kit("supportsocket", "Support socket", "socket base"), pre("sphere", "Socket cutout", { hole: true, w: 12.4, d: 12.4, h: 12.4 }, "hole socket"),
    kit("uniarmsm", "Arm, short", "uni arm ball link"), kit("uniarmmed", "Arm, medium", "uni arm ball link"), kit("uniarmlg", "Arm, long", "uni arm ball link"), kit("unihand", "Hand", "uni hand gripper"),
    kit("dowel3", "3-way dowel connector", "corner hub"), kit("dowel5", "5-way dowel connector", "hub"), kit("dowel9", "9-way dowel connector", "hub"), kit("dowelT", "T dowel connector", "tee hub"),
    kit("dowelplate", "Dowel holes block", "1/2 inch holes"), kit("tube2", "Double tube connector", "pipe"), kit("tube3", "Triple tube connector", "pipe"),
    kit("handle", "Handle", "drawer pull"), kit("bevelhandle", "Bevelled handle", "pull bar"), pre("capsule", "Handle grip cutout", { hole: true, t: 90, w: 20, d: 20, h: 80, y: 10 }, "hole slot"),
    kit("snap", "Flexible snap", "cantilever clip catch"), kit("snapconn", "Snap-fit connector", "clip push"), kit("hingeA", "Glasses hinge, part A", "hinge"), kit("hingeB", "Glasses hinge, part B", "hinge"),
    kit("hingepin", "Hinge pin", "pin"), kit("crossdowel", "Cross dowel", "barrel nut furniture"), kit("extrusion2020", "20 × 20 extrusion", "aluminium profile t-slot 2020"),
    kit("csbolt", "Countersunk bolt", "flathead screw m5"), kit("valve", "Valve", "tap needle ball"), kit("lanyard", "Lanyard", "strap neck")]],
  ["electronics", "Electronics", [
    hole("cylinder", "LED hole", { w: 5.2, d: 5.2, h: 20 }), hole("box", "Button hole", { w: 6.4, d: 6.4, h: 20 }),
    hole("box", "USB port hole", { w: 13, d: 8, h: 7, radius: 1.5 }),
    kit("led", "LED 5 mm", "light lamp diode"), kit("button", "Push button", "switch tactile"),
    kit("battery", "AA battery", "cell power"),
    { type: "cylinder", label: "Coin cell", extra: { w: 20, d: 20, h: 3.2, color: "#c4c9d0" }, words: "battery button cell 2032 power",
      icon: '<ellipse cx="22" cy="26" rx="17" ry="7" fill="#9aa0a8"/><path d="M5 20v6h34v-6z" fill="#9aa0a8"/><ellipse cx="22" cy="20" rx="17" ry="7" fill="#e2e5e9"/><ellipse cx="22" cy="20" rx="12" ry="4.5" fill="#c4c9d0"/>' },
    kit("servo", "Micro servo", "motor robot"), kit("board", "Controller board", "microcontroller pcb circuit computer"),
    kit("breadboard", "Breadboard", "prototype circuit"),
    kit("battery9v", "9 V battery", "power cell"), kit("cell18650", "18650 cell", "lithium battery power"), kit("bulb", "Light bulb", "lamp light"),
    kit("dcmotor", "DC motor", "motor spin"), kit("gearmotor", "Gear motor", "tt motor yellow robot wheel"), kit("stepper", "Stepper motor", "nema 17 motor"),
    kit("sevenseg", "7-segment display", "digit number display"), kit("lcd", "LCD screen", "16x2 display"), kit("oled", "OLED screen", "display"),
    kit("matrix", "LED matrix", "8x8 dots display"), kit("ultrasonic", "Distance sensor", "ultrasonic sonar"), kit("joystick", "Joystick", "thumbstick controller"),
    kit("toggle", "Toggle switch", "switch lever"), kit("pot", "Potentiometer", "knob dial variable resistor"), kit("buzzer", "Buzzer", "sound beeper"),
    kit("coolfan", "Cooling fan", "fan 40mm", false), kit("heatsink", "Heat sink", "cooler fins", false), kit("solar", "Solar panel", "sun power"),
    kit("resistor", "Resistor", "component"), kit("capacitor", "Capacitor", "component"), kit("header", "Pin header", "pins connector"),
    kit("jack", "Barrel jack", "power socket dc"),
    kit("led3red", "Red 3 mm LED", "led light"), kit("led3green", "Green 3 mm LED", "led light"), kit("led3blue", "Blue 3 mm LED", "led light"), kit("led3yellow", "Yellow 3 mm LED", "led light"),
    kit("led10red", "Red 10 mm LED", "led light"), kit("led10green", "Green 10 mm LED", "led light"), kit("led10blue", "Blue 10 mm LED", "led light"), kit("led10yellow", "Yellow 10 mm LED", "led light"),
    kit("ledrgb", "RGB LED", "led colour light"), kit("smdled", "RGB SMD LED", "led surface"), kit("ledstrip", "LED strip", "lights tape"),
    kit("seg1", "1-digit 7-segment display", "digit display"), kit("seg3", "3-digit 7-segment display", "digit display"), kit("seg4", "4-digit 7-segment display", "digit display"),
    kit("hornplastic", "Plastic servo horn", "servo arm", false), kit("hornmetal", "Aluminium servo horn", "servo arm disc", false),
    kit("servostd", "Standard servo", "servo motor"), kit("servostdmetal", "Standard servo, metal horn", "servo motor aluminum"), kit("servocont", "Continuous servo", "servo motor 360"),
    kit("minimotor", "Micro metal gearmotor", "n20 motor"), kit("vibemotor", "Vibration motor", "coin motor buzz"), kit("laser", "Laser diode", "light"),
    kit("ldr", "Light sensor (LDR)", "photoresistor ldr"), kit("reed", "Reed switch", "magnet switch"), kit("reedalarm", "Reed alarm switch", "door sensor", false),
    kit("irsensor", "IR obstacle sensor", "infrared tcrt5000 fc-51 ky-033 line"), kit("pir", "Motion sensor (PIR)", "hc-sr501 pir"), kit("dht11", "Temperature sensor", "dht11 humidity"),
    kit("dht22", "Temperature and humidity sensor", "dht22"), kit("gassensor", "Gas sensor", "mq smoke"), kit("soilprobe", "Soil moisture probe", "plant water"),
    kit("soilcap", "Capacitive soil sensor", "soil moisture plant"), kit("encoder", "Rotary encoder", "knob dial"), kit("accel", "Accelerometer", "motion tilt"),
    kit("bluetooth", "Bluetooth module", "hc-05 hc-06 wireless"), kit("l298n", "Motor driver", "l298n h-bridge"), kit("minidriver", "Mini motor driver", "driver"),
    kit("tp4056", "Battery charger board", "tp4056 lithium"), kit("microusb", "Micro USB port", "usb socket", false), kit("tft", "Colour TFT screen", "240x240 display"),
    kit("tft144", "Small TFT screen", "1.44 display"), kit("oled2", "OLED screen (dark board)", "display"), kit("holder2aa", "2 × AA battery holder", "battery box"),
    kit("holder2aaa", "2 × AAA battery box", "battery box switch"), kit("mux", "Analog multiplexer", "16 channel"), kit("nanoshield", "Nano expansion shield", "arduino nano shield"),
    kit("speedsensor", "Speed sensor", "slot optical encoder"), kit("irrecv", "IR receiver", "remote ky-022"), kit("monitor", "Monitor", "computer screen"), kit("tv", "Flat TV screen", "television"),
    kit("calculator", "Calculator", "maths"), kit("pushbig", "Push button 12 mm", "switch big"), kit("pushtall", "Push button, tall", "switch"), kit("dpdt", "DPDT push switch", "latching")]],
  ["symbols", "Symbols and signs", [
    hole("star", "Hole star"), hole("heart", "Hole heart"),
    "star", "heart", "arrow", "doublearrow", "check", "moon", "lightning", "drop", "flower", "speech",
    { type: "star", label: "Sun", extra: { points: 12, inner: 68, color: "#ffb400" }, words: "sunshine rays",
      icon: '<path d="M22 2l3 7 7-3-2 7 7 3-7 3 2 7-7-3-3 7-3-7-7 3 2-7-7-3 7-3-2-7 7 3z" fill="#ffb400"/><circle cx="22" cy="22" r="8" fill="#ffd34d"/>' },
    kit("smiley", "Smiley face", "emoji happy smile", false), kit("cloud", "Cloud", "weather sky", false),
    kit("paw", "Paw print", "dog cat animal pet", false), kit("note", "Music note", "song sound", false),
    kit("puzzle", "Puzzle piece", "jigsaw", false)]],
  ["geometry", "Geometry and maths", [
    "tetrahedron", "pyramid", "diamond", "bipyramid", "icosahedron", "dodecahedron", "plus", "minus", "times", "divide", "equals"]],
  ["starters", "Design starters", [
    hole("frame", "Hole frame", { w: 30, d: 20, h: 10 }),
    kit("gift", "Gift box", "present birthday christmas"), { type: "roundedbox", label: "Soft cube", extra: { radius: 5, color: "#2fa24a" }, words: "rounded cube" },
    kit("cubeframe", "Cube frame", "wireframe cage outline", false), kit("cubestack", "Cube stack", "blocks 2x2", false),
    { type: "torus", label: "Chain link", extra: { w: 20, d: 12, h: 4, tube: 30, color: "#9aa0a8" }, words: "loop oval ring" },
    { type: "spring", label: "Coil", extra: { color: "#1f8fe5" }, words: "spring helix" },
    kit("staroutline", "Star outline", "frame border", false), kit("heartoutline", "Heart outline", "frame border love", false),
    kit("pizza", "Pizza slice", "food pepperoni cheese"), kit("pieslice", "Pie slice", "food dessert cherry fruit tart"),
    "pie", "frame", kit("window", "Window", "pane frame glass", false), kit("clover", "Clover", "shamrock leaf luck", false),
    kit("fan", "Propeller", "fan blades rotor", false), kit("book", "Book", "pages read"), kit("power", "Power symbol", "on off button icon", false),
    kit("table", "Table", "furniture desk", false), { type: "spun", label: "Bottle", extra: { path: PATH.bottle, w: 16, d: 16, h: 36, clear: true, color: "#16b6b0" }, words: "glass jar vase",
      icon: '<path d="M18 4h8v4h-1v6c6 3 9 7 9 12v12a2 2 0 0 1-2 2H12a2 2 0 0 1-2-2V26c0-5 3-9 9-12V8h-1z" fill="#16b6b0" fill-opacity=".55" stroke="#0e8f8a" stroke-width="1.5"/>' },
    { type: "spun", label: "Spinning top", extra: { path: PATH.top, w: 24, d: 24, h: 26, color: "#f08a1c" }, words: "toy dreidel",
      icon: '<path d="M21 4h2v12h-2z" fill="#9aa0a8"/><path d="M6 20c6-4 26-4 32 0-4 6-10 14-16 20C16 34 10 26 6 20z" fill="#f08a1c"/><ellipse cx="22" cy="19" rx="15" ry="4" fill="#ffb066"/>' },
    { type: "scribble", label: "Twisted column", extra: { path: [[0, 0], [1, 0], [1, 1], [0, 1]], twist: 90, w: 12, d: 12, h: 40, color: "#8a4fd8" }, words: "pillar twist spiral" },
    { type: "polygon", label: "Octagon", extra: { sides: 8, w: 20, d: 20, h: 4, color: "#e5352b" }, words: "stop sign eight" },
    kit("beadring", "Bead ring", "circle pattern array blocks", false), kit("stairs", "Staircase", "steps", false),
    kit("ladder", "Ladder", "rungs climb", false), kit("fence", "Picket fence", "garden", false), kit("bricks", "Brick wall", "wall blocks", false),
    kit("house", "House", "home building roof"), kit("tree", "Tree", "pine forest"), kit("burger", "Burger", "hamburger food"),
    kit("flange", "Pipe flange", "pipe fitting mount", false),
    pre("spun", "Countersink hole", { path: P4.countersink, hole: true, w: 7, d: 7, h: 12 }, "screw hole countersunk"),
    kit("snowflake", "Snowflake", "winter ice", false), pre("scribble", "Cardioid", { path: unitPath(cardioid), w: 26, d: 22, h: 4, color: "#e8306e" }, "curve heart"),
    pre("scribble", "Super ellipse", { path: unitPath(superEllipse), w: 26, d: 26, h: 6, color: "#16b6b0" }, "squircle"),
    pre("spring", "Helix", { color: "#8a4fd8" }, "spiral coil"), kit("sphericHelix", "Spheric helix", "spiral beads", false), kit("atom", "Electron shell", "atom orbit science"),
    kit("tesseract", "Tesseract", "hypercube frame"), kit("multitri", "Multi-triangle", "star triangles", false), kit("border", "Circular border", "frame beads", false),
    kit("kapow", "Kapow!", "comic burst"), kit("fries", "Fries", "food chips"), pre("asteroid", "Squishorb", { bumps: 45, seed: 7, w: 24, d: 24, h: 20, color: "#f58db0" }, "blob squish"),
    kit("penny", "Penny", "coin"), kit("fountain", "Fountain", "water garden"), pre("spun", "Vase", { path: P4.vase, w: 22, d: 22, h: 34, color: "#1f8fe5" }, "flower pot"),
    pre("spun", "Potion bottle", { path: P4.potion, w: 22, d: 22, h: 32, clear: true, color: "#8a4fd8" }, "flask"),
    kit("planetcharm", "Planet charm", "charm keyring saturn"), kit("atomcharm", "Chemistry charm", "charm keyring atom"), kit("robocharm", "Robo charm", "charm keyring robot"),
    kit("starcharm", "Star charm", "charm keyring"), kit("skullcharm", "Skull charm", "charm keyring"), kit("actioncharm", "Lightning charm", "charm keyring action"),
    kit("periodiccharm", "Periodic charm", "charm keyring gold element"), kit("astrocharm", "Astro charm", "charm keyring rocket space"), kit("viewcube", "View cube", "view it cube labels"), pre("star", "Frill", { points: 24, inner: 82, w: 30, d: 30, h: 4, color: "#e8306e" }, "ruffle"),
    kit("signet", "Signet ring", "ring blank"), kit("radiation", "Radiation symbol", "warning sign"), kit("cloudballoon", "Cloud balloon", "thought bubble word"),
    kit("cashregister", "Cash register", "till shop"), kit("shopcounter", "Shop counter", "desk"), kit("papers", "Stack of papers", "sheets", false),
    pre("scribble", "Spiral cone", { path: [[0.5, 0], [0.62, 0.38], [1, 0.38], [0.69, 0.62], [0.81, 1], [0.5, 0.76], [0.19, 1], [0.31, 0.62], [0, 0.38], [0.38, 0.38]], twist: 360, taper: 0, w: 24, d: 24, h: 30, color: "#f08a1c" }, "twist"),
    kit("doubletorus", "Double torus", "rings", false), kit("tripletorus", "Triple torus", "rings", false),
    pre("cylinder", "High resolution cylinder", { sides: 64, w: 20, d: 20, h: 20, color: "#f08a1c" }, "smooth")]],
  ["structures", "Structures and scenery", [
    kit("roundtree", "Round tree", "plant garden park"), kit("pine", "Pine tree", "fir christmas forest"), kit("palm", "Palm tree", "beach tropical"),
    kit("cactus", "Cactus", "desert plant", false), pre("dodecahedron", "Rock", { w: 20, d: 16, h: 11, r: 20, color: "#8a8f98" }, "stone boulder"),
    kit("bed", "Bed", "bedroom furniture"), kit("sofa", "Sofa", "couch furniture"), kit("armchair", "Armchair", "chair furniture"),
    kit("chair", "Chair", "seat furniture", false), kit("roundtable", "Round table", "furniture cafe"), kit("bookshelf", "Bookshelf", "books furniture library"),
    kit("door", "Door", "entrance"), pre("roof", "Tent", { w: 30, d: 40, h: 20, color: "#e5352b" }, "camping"), kit("tablelamp", "Table lamp", "light furniture"),
    kit("lamppost", "Lamp post", "street light"), kit("bench", "Park bench", "seat garden"), kit("picnic", "Picnic table", "park bench", false),
    kit("mailbox", "Mailbox", "post letter"), kit("hydrant", "Fire hydrant", "street", false), kit("trafficcone", "Traffic cone", "road safety"),
    kit("barrel", "Barrel", "keg drum"), kit("pumpkin", "Pumpkin", "halloween autumn"), kit("pool", "Paddling pool", "swimming water"),
    kit("arch", "Archway", "arch gate bridge", false), kit("tower", "Castle tower", "turret fort"),
    kit("mountains", "Snowy mountains", "peaks hills", true), kit("pagodaroof", "Pagoda roof", "temple asian"), kit("pagodaterrace", "Pagoda", "temple tiers"),
    kit("landingpad", "Landing pad", "helipad"), kit("flatsground", "Flats, ground floor", "apartment building"), kit("flatsmiddle", "Flats, middle floor", "apartment building"),
    kit("flatstop", "Flats, top floor", "apartment building roof"), kit("skyscraper", "Skyscraper", "tower building"), kit("buildingbase", "Building base", "plate ground"),
    kit("trackstraight", "Train track", "rail railway straight"), kit("trackcurve", "Curved train track", "rail railway bend"), kit("crossing", "Railway crossing sign", "level crossing signal"),
    kit("streetlight1", "Street light", "lamp"), kit("streetlight2", "Double street light", "lamp"), kit("ottoman", "Ottoman", "footstool pouf"), kit("poolsteps", "Pool steps", "swimming ladder"),
    kit("snowtree", "Snowy tree", "winter pine"), kit("blossom", "Cherry blossom tree", "sakura pink"), kit("bamboo", "Bamboo", "stalk plant"), kit("fern", "Fern leaf", "plant", false),
    kit("daffodil", "Daffodil", "flower"), kit("lilypad", "Lily pad", "pond flower"), kit("curtain", "Curtain", "drape"), kit("rug", "Rug", "carpet mat"),
    kit("firewood", "Firewood log", "wood"), kit("crystals", "Crystals", "gems cluster", false), kit("cave", "Cave", "rock"), kit("waterfall", "Waterfall", "cliff river"),
    kit("wave", "Wave", "sea water"), kit("container", "Shipping container", "cargo box"), kit("portcullis", "Portcullis", "castle gate", false),
    kit("stonewall", "Castle wall", "stone wall crenellations battlements", false), kit("cage", "Bird cage", "cage"),
    kit("beachup", "Beach chair", "deck chair"), kit("beachrecl", "Beach chair, reclined", "deck chair lounge"),
    kit("door9", "Nine-pane door", "door glass"), kit("doorsolid", "Panel door", "door solid"), kit("doorcountry", "Door with window", "country door"),
    kit("doorgothic", "Arched door", "gothic door"), kit("doorbarn", "Barn door", "door"), kit("doordouble", "Double door", "entry doors"), kit("doordoubleglass", "Double glass door", "doors"),
    kit("win4", "Four-pane window", "window"), kit("winslide", "Sliding window", "window"), kit("winoval", "Oval window", "columns window"), kit("shutter", "Shutter", "window louvre", false),
    kit("archwindow", "Gothic window", "arch stained glass"), kit("rosewindow", "Rose window", "gothic round stained glass"), kit("archhollow", "Pointed arch", "gothic arch", false),
    kit("gothicvault", "Vault", "gothic ceiling arch", false), kit("gothictrim", "Gothic trim", "edge decoration", false), kit("buttress", "Buttress", "gothic support", false),
    kit("spire", "Spire", "gothic steeple"), kit("ionic", "Column capital", "ionic greek pillar", false), kit("indiagate", "Memorial arch", "gate monument", false),
    kit("moai", "Stone head", "statue easter island", false), kit("theater", "Cinema", "movie theatre building"), kit("telephone", "Old telephone", "phone"),
    kit("shelfunit", "Garage shelf", "storage rack"), kit("desk", "Desk", "table furniture"), kit("endtable", "End table", "side table"), kit("loftbed", "Loft bed", "bunk bed"),
    kit("greenhouseglass", "Greenhouse", "glass house"), kit("greenhouseframe", "Greenhouse frame", "glass house frame", false), kit("farmfence", "Farm fence", "rail fence", false),
    kit("trellis", "Trellis", "garden lattice", false), kit("lattice", "Lattice", "garden diagonal", false), kit("moroccan", "Moroccan tile", "quatrefoil pattern", false),
    kit("candycane", "Candy cane", "christmas"), kit("barberpole", "Barber pole", "stripes"), kit("finial", "Finial", "post top"), kit("barbecue", "Barbecue", "grill bbq"),
    kit("faucet", "Tap", "faucet sink"), kit("bridge", "Bridge", "arch stone"), kit("brickblock", "Brick", "building block holes", false)]],
  ["vehicles", "Vehicles and machines", [
    kit("wheel", "Wheel", "tyre tire car rim"), kit("tire", "Chunky tyre", "tire offroad tread wheel"), kit("spokewheel", "Spoked wheel", "wagon cart wooden"),
    kit("axle", "Axle", "rod shaft"), pre("spun", "Pulley", { path: P2.pulley, w: 20, d: 20, h: 8, color: "#9aa0a8" }, "wheel rope belt"),
    kit("fan", "Propeller", "rotor blades", false),
    kit("rocket", "Rocket", "space ship"), kit("car", "Car", "vehicle auto"), kit("plane", "Airplane", "aeroplane plane jet"),
    kit("boat", "Boat", "ship"), kit("windupkey", "Wind-up key", "clockwork toy", false), kit("camera", "Camera", "photo"),
    kit("tireAT", "All-terrain tyre", "tire wheel offroad"), kit("tireSpiked", "Spiked tyre", "tire wheel studs"), kit("tireTruck", "Truck tyre", "tire wheel"),
    kit("tireDragster", "Dragster tyre", "tire wheel wide"), kit("tireWhitewall", "Whitewall tyre", "tire wheel classic"), kit("wheelAlloy", "Alloy wheel", "rim spokes forged"),
    kit("wheelOld", "Old car wheel", "spoked vintage"), kit("wheelMars", "Rover wheel", "mars perseverance planetary"), kit("wheelToy", "Toy wheel", "robot small"),
    kit("wheelCVfront", "Lorry wheel, front", "commercial vehicle truck"), kit("wheelCVrear", "Lorry wheels, rear", "commercial vehicle twin truck"), kit("tricaster", "Tri caster", "castor wheels"),
    kit("standbase", "Display stand base", "flying stand"), kit("standrod", "Display stand rod", "flying stand"), kit("aircon", "Air conditioner", "ac unit"), kit("van", "Van", "vehicle"),
    kit("cargoship", "Cargo spaceship", "hauler space ship"), kit("pontoon", "Pontoon", "float"), kit("tankhatch", "Tank hatch", "hatch lid"), kit("anchor", "Anchor", "ship boat"),
    kit("biplane", "Biplane", "plane aircraft"), kit("airtank", "Air tank", "reservoir compressor"), pre("spun", "Ship hull", { path: P2.hull, t: 0, w: 22, d: 22, h: 14, color: "#1f8fe5" }, "boat")]],
  ["fun", "Fun and games", [
    kit("dice", "Dice", "die d6 pips"), pre("polyhedron", "D4", { kind: "tetra", w: 20, d: 20, h: 17, color: "#e5352b" }, "dice die tetrahedron"),
    pre("polyhedron", "D8", { kind: "octa", w: 18, d: 18, h: 16, color: "#2fa24a" }, "dice die octahedron"), pre("polyhedron", "D10", { kind: "d10", w: 18, d: 18, h: 16, color: "#8a4fd8" }, "dice die"),
    pre("polyhedron", "D12", { kind: "dodeca", w: 20, d: 20, h: 20, color: "#f08a1c" }, "dice die dodecahedron"), pre("polyhedron", "D20", { kind: "icosa", w: 22, d: 22, h: 21, color: "#1f8fe5" }, "dice die icosahedron"),
    kit("soccer", "Soccer ball", "football ball truncated icosahedron"), kit("basketball", "Basketball", "ball"), kit("football", "American football", "rugby ball"),
    kit("tennis", "Tennis ball", "ball"), kit("bat", "Baseball bat", "sport"), kit("paddle", "Table tennis bat", "ping pong paddle"), kit("trophy", "Trophy cup", "prize award"),
    kit("skateboard", "Skateboard", "board"), kit("balloon", "Balloon", "party"), kit("drum", "Drum", "music snare"), kit("keyboard", "Piano keyboard", "music keys"),
    kit("controller", "Game controller", "gamepad joystick"), kit("flag", "Checkered flag", "race finish"), kit("jackolantern", "Jack-o'-lantern", "halloween pumpkin face"),
    kit("brick2x2", "Building brick 2×2", "interconnecting block studs toy"), kit("toybox", "Toy box", "box storage"), kit("hammer", "Toy hammer", "mallet"),
    "channel", pre("channel", "Sloped channel", { t: -22.5, w: 20, d: 50, h: 12, y: 10 }, "marble run ramp"),
    pre("spun", "Spinning top", { path: P3.top, w: 24, d: 24, h: 26, color: ORANGE }, "toy"),
    kit("pine", "Christmas tree", "xmas"), kit("snowman", "Snowman", "winter"), kit("crown", "Crown", "king"),
    kit("slide", "Slide", "playground"), kit("slidecurved", "Curved slide", "playground"), kit("slidedouble", "Double-curve slide", "playground"),
    kit("climber", "Climbing frame", "climber playground"), kit("archclimber", "Arched climber", "playground"), kit("climbpanel", "Climbing wall", "panel holds"),
    kit("divingblock", "Diving block", "swimming"), kit("fencehap", "Rickety fence", "wooden fence hap-hazard", false), kit("bubblepanel", "Bubble panel", "panel holes"),
    kit("confetti", "Confetti", "rainbow party", false), kit("helmet", "Football helmet", "american football helmet"), kit("dart", "Foam dart", "toy"), kit("dartholder", "Dart holder", "foam dart holder", false),
    kit("pail", "Beach pail", "bucket sand"), kit("snowwall", "Snowball wall", "snow", false), kit("snowmound", "Snowball mound", "snow", false), kit("snowstack", "Snowball stack", "snow", false),
    kit("bubblewand", "Bubble wand", "toy"), kit("tambourine", "Tambourine", "music"), kit("pallet", "Wooden pallet", "palette skid"), kit("ibc", "Liquid tank", "ibc tote container"),
    kit("barrelwall", "Barrel wall", "barrels", false), kit("spoolsmall", "Wooden spool", "reel cotton"), kit("spoollarge", "Large spool", "reel cable"), kit("spooldown", "Flat spool", "reel"),
    kit("spoolend", "Spool end", "reel disc"), kit("channelY", "Y channel", "marble run split", false), kit("channelturn", "Channel turn", "marble run 90 bend", false), kit("spiralramp", "Spiral ramp", "helix marble run corkscrew")]],
  ["everyday", "Everyday objects", [
    kit("pencil", "Pencil", "write draw"), kit("crayon", "Crayon", "colour draw"), kit("pen", "Pen", "write"), kit("eraser", "Eraser", "rubber"), kit("ruler", "Ruler", "measure"),
    kit("sticky", "Sticky notes", "post-it note pad"), kit("tack", "Thumb tack", "pin push"), kit("nametag", "Name tag", "label"), kit("comb", "Comb", "hair"),
    kit("mug", "Coffee mug", "cup tea"), kit("glass", "Drinking glass", "cup"), kit("plate", "Plate", "dish"), pre("bowl", "Bowl", { w: 40, d: 40, h: 18, color: "#e0a85a" }, "dish"),
    kit("bottle", "Water bottle", "drink"), kit("milk", "Milk carton", "drink"), kit("apple", "Apple", "fruit"), kit("orange", "Orange", "fruit"), kit("watermelon", "Watermelon", "fruit"),
    kit("pineapple", "Pineapple", "fruit"), kit("cheese", "Cheese", "food"), kit("popsicle", "Ice lolly", "popsicle ice cream"), kit("baguette", "Baguette", "bread food"),
    kit("phone", "Phone", "mobile smartphone"), kit("laptop", "Laptop", "computer notebook"), kit("headphones", "Headphones", "music"), kit("clock", "Alarm clock", "time"),
    kit("toiletroll", "Toilet roll", "paper tissue"), kit("hammer", "Hammer", "tool"), kit("screwdriver", "Screwdriver", "tool"), kit("umbrella", "Umbrella", "rain"),
    kit("candle", "Tea light", "candle"), kit("chest", "Treasure chest", "box"), kit("cauldron", "Cauldron", "pot witch"), kit("extinguisher", "Fire extinguisher", "safety"),
    kit("qtip", "Cotton bud", "q-tip swab"),
    kit("chopsticks", "Chopsticks", "eating sticks", false), pre("cone", "Chopstick", { top: 45, t: 90, w: 5, d: 5, h: 200, y: 2.5, color: "#c49a6a" }, "eating stick"),
    pre("tube", "Boba straw", { wall: 10, t: 90, w: 12, d: 12, h: 200, y: 6, color: "#f58db0" }, "straw bubble tea"), kit("toothpick", "Toothpick", "pick", false), kit("needle", "Needle", "sewing", false),
    pre("box", "Wood plank", { w: 120, d: 20, h: 5, color: WOOD }, "board timber"), kit("basket", "Basket", "wicker"), pre("spun", "Yogurt cup", { path: [[0, 0], [0.8, 0], [1, 1], [0.93, 1], [0.74, 0.06], [0, 0.06]], w: 50, d: 50, h: 60, color: WHITE }, "pot tub"),
    pre("box", "Cardboard sheet", { w: 120, d: 120, h: 3, color: CARD }, "12 x 12 cardboard"), pre("tube", "Cardboard tube", { wall: 6, w: 40, d: 40, h: 100, color: CARD }, "tissue tube"),
    pre("tube", "Paper towel tube", { wall: 6, w: 40, d: 40, h: 230, color: CARD }, "kitchen roll tube"), pre("tube", "Paper towel roll", { wall: 30, w: 110, d: 110, h: 230, color: WHITE }, "kitchen roll"),
    kit("heartbox", "Heart box", "hinged heart container lid"), kit("wrench", "Wrench", "spanner tool"), kit("tile20", "Tile", "20x20 tile"), kit("bottlecap", "Bottle cap", "beverage crown cap"),
    kit("boxnet", "Box net", "foldable box template cube net", false), kit("keychain", "Keychain", "swivel key ring"), kit("scissors", "Scissors", "cut"), kit("petfood", "Pet food tub", "dog cat container"),
    kit("hanger", "Coat hanger", "clothes"), kit("books", "Row of books", "books lined up"), kit("luggagetag", "Luggage tag", "suitcase label"), kit("westernhat", "Western hat", "cowboy hat"),
    kit("claywheel", "Clay wheel", "pottery tool"), kit("claystar", "Star clay wheel", "pottery tool"), kit("clayslant", "Slant clay wheel", "pottery tool"), kit("clayroller", "Clay roller", "pottery tool"),
    kit("fancyshelf", "Fancy shelf", "wall shelf brackets"), kit("paperclip", "Paperclip", "clip", false), kit("coconut", "Coconut", "fruit"), kit("shovel", "Shovel", "spade garden"),
    pre("box", "Sticky note pad", { w: 76, d: 76, h: 12, color: "#ffef7a" }, "large sticky notes"), pre("box", "Thin sticky notes", { w: 76, d: 76, h: 3, color: "#7ce0ff" }, "sticky note"), ...[["3 mm", 3], ["6 mm", 6], ["10 mm", 10], ["12 mm", 12], ["20 mm", 20], ["25 mm", 25]].map(([n, d]) => pre("cylinder", `Dowel ${n}`, { w: d, d, h: 80, color: "#e8c89a" }, "wooden rod stick dowel"))]],
  ["featured", "Featured collections", [
    kit("sofa", "Couch", "sofa seat"), kit("armchair", "Seat", "chair"), kit("stool", "Stool", "seat"), kit("cushion", "Cushion", "pillow"), kit("roundtable", "Round table", "table"),
    kit("table", "Big table", "table", false), kit("tablelamp", "Lamp", "light"), kit("houseplant", "Houseplant", "plant pot"), kit("arcade", "Arcade game", "cabinet"),
    ...[2, 3, 5, 7, 9, 11, 15].map((n) => pre("beam", `Hole beam ${n}`, { holes: n, w: 12.5 * n, d: 12.5, h: 12.5, color: "#f2c230" }, "beam stemfie construction holes")),
    ...[3, 5, 9].map((n) => pre("beam", `Hole strip ${n}`, { holes: n, w: 12.5 * n, d: 12.5, h: 3.1, color: "#1f8fe5" }, "brace strip stemfie construction holes")),
    pre("tube", "Washer", { wall: 28, w: 12.5, d: 12.5, h: 3.1, color: "#9aa0a8" }, "washer stemfie"), pre("cylinder", "Pin", { w: 3, d: 3, h: 25, color: "#9aa0a8" }, "pin stemfie")]],
  ["simlab", "Sim lab", [
    kit("domino", "Domino", "toppling"), kit("dominoline", "Domino line", "row of 20", false), kit("dominocircle", "Domino circle", "ring", false), kit("dominos", "Domino S path", "curve snake", false),
    ...[8, 10, 12, 14, 18, 20, 22, 24, 26, 28, 30].map((n) => pre("gear", `${n} tooth gear`, { teeth: n, w: 2 * n, d: 2 * n, h: 5, color: "#9aa0a8" }, "gear cog")),
    kit("axleconn", "Axle connector", "connector", false), kit("trebuchet", "Trebuchet", "catapult siege"),
    kit("dominospiral", "Domino spiral", "toppling", false), kit("dominogrid", "Domino switchback", "toppling zigzag grid", false), kit("pivotconn", "Pivot connector", "connector", false), kit("sliderconn", "Slider connector", "connector", false), kit("car", "Car", "vehicle")]],
  ["generators", "Shape generators", [
    "polyhedron", "knot", "asteroid", "beam", "rack", "airfoil", "channel", "donutslice",
    pre("polyhedron", "Truncated icosahedron", { kind: "truncicosa" }), pre("polyhedron", "Truncated cube", { kind: "trunccube" }), pre("polyhedron", "Truncated tetrahedron", { kind: "trunctetra" }),
    pre("polyhedron", "Truncated octahedron", { kind: "truncocta" }), pre("polyhedron", "Cuboctahedron", { kind: "cubocta" }), pre("polyhedron", "Rhombicuboctahedron", { kind: "rhombicubocta" }),
    pre("polyhedron", "Rhombic dodecahedron", { kind: "rhombicdodeca" }), pre("polyhedron", "Icosidodecahedron", { kind: "icosidodeca" }),
    pre("knot", "Trefoil", { kind: "2,3", color: "#e5352b" }), pre("knot", "Cinquefoil", { kind: "2,5", color: "#1f8fe5" }),
    pre("pie", "Pac-Man", { angle: 300, w: 24, d: 24, h: 6, r: 90, color: "#f2c230" }), pre("pie", "Cylinder quarter", { angle: 90, w: 20, d: 20, h: 20 }),
    pre("pie", "Partial tube", { angle: 240, inner: 70, w: 24, d: 24, h: 16, color: "#1f8fe5" }), pre("cone", "Circular trapezoid", { top: 60, w: 24, d: 24, h: 14, color: "#2fa24a" }),
    pre("cone", "Trapezoid", { top: 55, sides: 4, w: 24, d: 24, h: 14, r: 45, color: "#9aa0a8" }), pre("spun", "Ogive", { path: P3.ogive, w: 16, d: 16, h: 30, color: "#2fa24a" }),
    pre("spun", "Funnel", { path: P3.funnel, w: 30, d: 30, h: 30, color: "#f08a1c" }), pre("spun", "Revolved heart", { path: P3.heartspin, w: 24, d: 24, h: 24, color: "#e8306e" }),
    pre("spun", "Limpet", { path: P3.limpet, w: 24, d: 24, h: 10, color: "#e0a85a" }), pre("bowl", "Parabolic reflector", { w: 40, d: 40, h: 14, wall: 6, color: "#c4c9d0" }),
    pre("scribble", "Twisted polygon", { path: [[0.5, 0], [1, 0.38], [0.8, 1], [0.2, 1], [0, 0.38]], twist: 120, w: 20, d: 20, h: 30, color: "#1d3a8a" }),
    pre("scribble", "Lobed rod", { path: Array.from({ length: 48 }, (_, i) => { const a = (i / 48) * Math.PI * 2, r = 0.36 + 0.14 * Math.cos(5 * a); return [Math.round((0.5 + Math.cos(a) * r) * 1000) / 1000, Math.round((0.5 + Math.sin(a) * r) * 1000) / 1000]; }), w: 16, d: 16, h: 40, color: "#f08a1c" }),
    pre("scribble", "Arrowhead", { path: [[0.5, 0], [1, 1], [0.5, 0.75], [0, 1]], w: 20, d: 24, h: 4, color: DARK }),
    pre("star", "Sun", { points: 16, inner: 70, w: 30, d: 30, h: 4, color: "#ffb400" }), pre("flower", "Sunflower", { petals: 12, w: 30, d: 30, h: 4, color: "#f2c230" }),
    kit("meeple", "Meeple", "game piece token"), kit("butterfly", "Butterfly", "insect"), kit("crystal", "Crystal", "gem quartz"),
    kit("piechart", "Pie chart", "graph"), kit("barchart", "Bar chart", "graph"), kit("heartsring", "Hearts around a circle", "circular array pattern", false),
    kit("dna", "DNA", "double helix"), kit("honeycomb", "Honeycomb grid", "hexagon grid", false), kit("projectbox", "Project box", "enclosure case", false),
    pre("tube", "Cog ring", { wall: 25, w: 30, d: 30, h: 6, color: "#9aa0a8" }, "ring"),
    "terrain", pre("terrain", "Rocky terrain", { rough: 100, seed: 5, w: 60, d: 60, h: 18, color: "#8a8f98" }, "mountain landscape"),
    pre("plus", "Cross axle", { thick: 34, w: 4.8, d: 4.8, h: 40, color: "#6b7280" }, "technic axle cross"),
    pre("scribble", "Drill bit", { path: [[0.5, 0], [0.62, 0.38], [1, 0.38], [0.69, 0.62], [0.81, 1], [0.5, 0.76], [0.19, 1], [0.31, 0.62], [0, 0.38], [0.38, 0.38]], twist: 540, w: 8, d: 8, h: 50, color: "#9aa0a8" }, "drill flute"),
    pre("spun", "Cup", { path: [[0, 0], [0.75, 0], [1, 1], [0.9, 1], [0.67, 0.08], [0, 0.08]], w: 30, d: 30, h: 30, color: "#1f8fe5" }, "polycup tumbler"),
    pre("polygon", "Delta", { sides: 3, w: 30, d: 26, h: 4, color: "#e5352b" }, "triangle"),
    pre("scribble", "Bean", { path: Array.from({ length: 48 }, (_, i) => { const a = (i / 48) * Math.PI * 2, r = 0.4 + 0.1 * Math.cos(2 * a) - 0.12 * Math.max(0, Math.sin(a)); return [Math.round((0.5 + Math.cos(a) * r * 1.2) * 1000) / 1000, Math.round((0.5 + Math.sin(a) * r) * 1000) / 1000]; }), w: 24, d: 14, h: 10, color: "#8a5a2a" }, "kidney"),
    kit("banana", "Banana", "fruit"), kit("radialfins", "Radial fins", "heat sink cooler"), kit("mandala", "Mandala", "pattern flower"), kit("tubejoint", "Tube joint", "pipe connector inner outer"),
    kit("slats", "Venetian slats", "blinds louvre", false), kit("columngrid", "Grid of columns", "bars city"), kit("extrusiongrid", "Extrusion grid", "grid holes", false)]],
  ["characters", "Characters and creatures", [
    kit("eye", "Googly eye", "eyes character face"), kit("glasses", "Glasses", "spectacles face", false), kit("mustache", "Mustache", "moustache face", false),
    kit("tophat", "Top hat", "hat costume"), kit("crown", "Crown", "king queen royal"), kit("hardhat", "Hard hat", "helmet builder", false),
    kit("propeller", "Propeller hat", "beanie cap"), kit("person", "Peg person", "figure people character"), kit("snowman", "Snowman", "winter"),
    { type: "spun", label: "Egg", extra: { path: PATH.egg, w: 20, d: 20, h: 26, color: "#ffffff" }, words: "easter oval",
      icon: '<path d="M22 4c8 0 14 13 14 22a14 14 0 0 1-28 0C8 17 14 4 22 4z" fill="#fff" stroke="#9aa0a8" stroke-width="1.5"/><ellipse cx="17" cy="16" rx="3" ry="5" fill="#eef1f4"/>' },
    kit("icecream", "Ice cream", "cone dessert"), kit("sword", "Sword", "blade knight"),
    kit("elephant", "Elephant", "animal"), kit("frog", "Frog", "animal"), kit("lion", "Lion", "animal"), kit("squid", "Squid", "sea animal"), kit("crocodile", "Crocodile", "animal reptile"),
    kit("dinosaur", "Dinosaur", "dino animal"), kit("cobra", "Cobra", "snake animal"), kit("duck", "Rubber duck", "duckie bath toy"), kit("whale", "Whale", "sea animal"),
    kit("cow", "Cow", "farm animal"), kit("bear", "Bear", "resting bear animal"), kit("polarbear", "Polar bear", "animal"), kit("fish", "Fish", "sea animal"),
    kit("fishschool", "School of fish", "shoal sea"), kit("bee", "Bee", "insect"), kit("walrus", "Walrus", "sea animal"), kit("turkey", "Turkey", "bird"), kit("chicken", "Chicken", "bird hen"),
    kit("teddy", "Teddy bear", "toy"), kit("reindeer", "Reindeer", "christmas deer"), kit("snake", "Silly snake", "animal"), kit("koala", "Koala", "animal"), kit("sheep", "Sheep", "farm animal"),
    kit("seal", "Seal", "baby seal sea animal"), kit("ghost", "Ghost", "halloween"), kit("blockhead", "Block head", "character face"), kit("kid", "Cheering kid", "person celebrating"),
    kit("sneaker", "Sneaker", "shoe trainer"), kit("flipflop", "Flip-flop", "sandal"), kit("flipper", "Flipper", "swim fin"), kit("scuba", "Scuba mask", "diving goggles"),
    kit("tricorn", "Tricorn hat", "pirate hat"), kit("beanie", "Beanie", "hat woolly"), kit("beret", "Beret", "artist hat"), kit("bunnyear", "Bunny ear", "rabbit"), kit("bunnyearbent", "Bent bunny ear", "rabbit"),
    kit("chickfoot", "Chick foot", "bird foot", false), kit("paw", "Paw", "sheep paw hoof"), kit("buglegs", "Bug leg", "insect horn", false), kit("feather", "Feather", "quill"),
    kit("axe2", "Double axe", "battle axe"), kit("anvil", "Anvil", "blacksmith", false), kit("spartan", "Crested helmet", "spartan warrior"), kit("cufflink", "Cufflink", "jewellery", false)]],
];
// every shape type appears somewhere; anything not placed goes into "More"
const listed = new Set(CATEGORIES.flatMap(([, , list]) => list.map((e) => (typeof e === "string" ? e : e.type))));
const unlisted = Object.keys(SHAPES).filter((k) => !listed.has(k) && k !== "picture" && k !== "relief"); // those two come from Import photo
if (unlisted.length) CATEGORIES.push(["more", "More shapes", unlisted]);
const CATALOG_BY_KEY = {};
function catalogItem(e) {
  const item = typeof e === "string" ? { type: e, label: SHAPES[e].label } : { ...e };
  item.key = item.kit ? `kit:${item.kit}` : item.extra ? `${item.type}:${item.label}` : item.type;
  const def = SHAPES[item.type] || { label: "", hole: false };
  item.words = `${item.label} ${def.label} ${SHAPE_WORDS[item.type] || ""} ${item.words || ""} ${item.holeIcon || def.hole ? HOLE_WORDS : ""}`.toLowerCase();
  CATALOG_BY_KEY[item.key] = item;
  return item;
}
// a hole's icon: the shape's own drawing filled with grey stripes
function holeIconOf(type, n) {
  const id = `hole-stripes-${n}`;
  return `<defs><pattern id="${id}" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="5" height="5" fill="#d6dae0"/><rect width="2.5" height="5" fill="#9aa0a8"/></pattern></defs>`
    + ICONS[type].replace(/fill="#[0-9a-fA-F]{3,6}"/g, `fill="url(#${id})"`).replace(/stroke="#[0-9a-fA-F]{3,6}"/g, 'stroke="#6b7280"');
}
const glyphIcon = (ch) => `<text x="22" y="34" font-size="30" font-weight="700" text-anchor="middle" font-family="IBM Plex Sans, sans-serif" fill="#1f8fe5">${ch.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</text>`;
// add a catalogue entry to the design (at a spot, or the next free place)
function addFromCatalog(item, at) {
  if (item.type === "import") { drawingPicker.click(); return; }
  if (item.type === "scribble" && !item.extra) { openScribble(); return; }
  if (item.type === "spun" && !item.extra) { openScribble("spin"); return; }
  if (item.kit) { addKit(item, at); return; }
  const extra = item.extra ? { ...item.extra } : null;
  if (extra) {
    const count = shapes.filter((x) => x.name.startsWith(item.label + " ")).length + 1;
    extra.name = `${item.label} ${count}`;
    if (item.glyph) { const k = textAspect(item.glyph, "sans"); extra.h = 20; extra.d = 5; extra.w = Math.max(3, Math.round(20 * (k || 0.6) * 10) / 10); }
  }
  addShape(item.type, at, extra);
}
// A part made of several pieces arrives as one group (multicolour where its pieces differ);
// Ungroup takes it apart like any other group.
function addKit(item, at) {
  const children = KITS[item.kit]().map((c) => {
    const s = { id: nextId++, name: SHAPES[c.type].label, color: SHAPES[c.type].color, hole: false, x: 0, y: 0, z: 0, r: 0, t: 0, ...c };
    for (const p of paramsOf(s.type)) if (s[p.key] == null) s[p.key] = p.value;
    return trueProportions(s);
  });
  const g = combine(children);
  if (!g) return;
  g.computeBoundingBox();
  const b = g.boundingBox, size = new THREE.Vector3();
  b.getSize(size);
  const base = { w: size.x, h: size.y, d: size.z, x: (b.min.x + b.max.x) / 2, y: b.min.y, z: (b.min.z + b.max.z) / 2 };
  const n = shapes.length;
  const spot = { x: -45 + (n % 4) * 30, z: -30 + (Math.floor(n / 4) % 3) * 30 };
  const count = shapes.filter((x) => x.name.startsWith(item.label + " ")).length + 1;
  const first = children.find((c) => !c.hole);
  const grp = { id: nextId++, type: "group", name: `${item.label} ${count}`, color: first.color, hole: false, multicolor: !!item.multi,
    ...base, x: snap(at && !at.surface ? at.x : spot.x), y: 0, z: snap(at && !at.surface ? at.z : spot.z), r: 0, t: 0, base, children };
  if (at && at.surface) Object.assign(grp, at.surface);
  else if (!at && tempPlane) Object.assign(grp, onTempPlane());
  shapes.push(grp);
  buildMesh(grp);
  select(grp.id);
  commit();
  say(`${grp.name} added. It is a group: Ungroup takes it apart.`);
}
let iconCount = 0;
const thumbs = createThumbs({ shapeGeometry, combineColoured });
for (const [key, title, list] of CATEGORIES) {
  const sec = document.createElement("section");
  sec.className = "shapes__section";
  sec.dataset.cat = key;
  sec.innerHTML = `<h3 class="shapes__cat">${title}</h3><div class="shapes__grid"></div>`;
  shapeButtons.append(sec);
  const grid = sec.querySelector(".shapes__grid");
  for (const e of list) {
    const item = catalogItem(e);
    const b = document.createElement("button");
    b.className = "shape-btn" + (item.holeIcon || (SHAPES[item.type] && SHAPES[item.type].hole) ? " shape-btn--hole" : "") + (item.glyph || item.compact ? " shape-btn--glyph" : "");
    b.type = "button";
    b.draggable = true;
    const drawn = !item.glyph && !item.icon && (item.kit || item.thumb);
    const icon = item.glyph ? glyphIcon(item.glyph) : item.icon ? item.icon : item.holeIcon ? holeIconOf(item.type, ++iconCount) : ICONS[item.type];
    b.innerHTML = drawn ? `<img class="shape-thumb" alt="" width="44" height="44">${item.label}` : `<svg viewBox="0 0 44 44" aria-hidden="true">${icon}</svg>${item.glyph || item.compact ? "" : item.label}`;
    if (drawn) thumbs.attach(b.querySelector("img"), item.key, () => (item.kit ? KITS[item.kit]() : [{ type: item.type, ...item.extra }])
      .map((c) => { const d = SHAPES[c.type]; const part = { w: d.size[0], d: d.size[1], h: d.size[2], color: d.color, ...c }; for (const q of paramsOf(c.type)) if (part[q.key] == null) part[q.key] = q.value; return trueProportions(part); }));
    b.setAttribute("aria-label", item.glyph ? `Add the character ${item.glyph}` : `Add ${item.compact ? "" : "a "}${item.label}`);
    b.title = item.glyph ? `Character ${item.glyph}` : item.label;
    b.dataset.type = item.type;
    b.dataset.key = item.key;
    b.addEventListener("click", () => addFromCatalog(item));
    b.addEventListener("dragstart", (ev) => ev.dataTransfer.setData("text/shape", item.key));
    grid.append(b);
  }
}
// the category drop-down
const catSelect = $("#shape-cat");
catSelect.innerHTML = `<option value="all">All shapes</option>` + CATEGORIES.map(([key, title]) => `<option value="${key}">${title}</option>`).join("");
try { const c = localStorage.getItem("shapeforge-shape-category"); catSelect.value = c && [...catSelect.options].some((o) => o.value === c) ? c : "basic"; } catch { catSelect.value = "basic"; }
catSelect.addEventListener("change", () => {
  try { localStorage.setItem("shapeforge-shape-category", catSelect.value); } catch { /* storage full */ }
  filterShapes();
  shapeButtons.scrollIntoView({ block: "nearest" });
});
filterShapes();
host.addEventListener("dragover", (e) => e.preventDefault());
host.addEventListener("drop", (e) => {
  e.preventDefault();
  const file = [...(e.dataTransfer.files || [])].find((f) => /\.(stl|svg|png|jpe?g|gif|webp|bmp)$/i.test(f.name));
  if (file) { importFile(file, planePoint(e.clientX, e.clientY, 0)); return; }
  const libId = e.dataTransfer.getData("text/library");
  if (libId) {
    const item = readLibrary().find((x) => String(x.id) === libId);
    const p = planePoint(e.clientX, e.clientY, 0);
    if (item) useLibraryItem(item, p ? { x: p.x, z: p.z } : null);
    return;
  }
  const item = CATALOG_BY_KEY[e.dataTransfer.getData("text/shape")];
  if (!item) return;
  const add = (at) => addFromCatalog(item, at);
  // dropped on a shape: stand it on that face; with a temporary workplane: on that
  const face = workspace.cruise ? faceAt(e.clientX, e.clientY) : null;
  if (face) { add({ surface: standOn(face.point, face.normal) }); return; }
  if (tempPlane) { add({ surface: onTempPlane(e.clientX, e.clientY) }); return; }
  const p = planePoint(e.clientX, e.clientY, 0);
  add(p || undefined);
});

const swatches = $("#swatches");
PALETTE.concat(["custom"]).forEach((c) => {
  if (c === "custom") {
    const lab = document.createElement("label");
    lab.title = "Pick any colour";
    lab.style.cssText = "position:relative;aspect-ratio:1;border-radius:50%;background:conic-gradient(red,yellow,lime,cyan,blue,magenta,red);box-shadow:0 0 0 1px #d0d5db;cursor:pointer";
    lab.innerHTML = '<input type="color" aria-label="Pick any colour" style="opacity:0;position:absolute;inset:0;width:100%;height:100%;cursor:pointer">';
    lab.querySelector("input").addEventListener("input", (e) => setProp("color", e.target.value, true));
    lab.querySelector("input").addEventListener("change", () => commit());
    swatches.append(lab);
    return;
  }
  const b = document.createElement("button");
  b.type = "button";
  b.setAttribute("role", "radio");
  b.dataset.color = c;
  b.style.background = c;
  b.setAttribute("aria-label", `Colour ${c}`);
  b.addEventListener("click", () => { setProp("color", c); });
  swatches.append(b);
});

$("#f-clear").addEventListener("change", (e) => {
  const s = get(selected);
  if (!s || s.hole) return;
  setProp("clear", e.target.checked);
  say(e.target.checked ? `${s.name} is see-through, so you can look inside it. Exported files stay solid.` : `${s.name} is solid-looking again.`);
});
$("#f-multi").addEventListener("change", (e) => {
  const s = get(selected);
  if (!s || s.type !== "group") return;
  setProp("multicolor", e.target.checked);
  say(e.target.checked ? `${s.name} shows each part's own colour.` : `${s.name} is one colour again.`);
});

// Mirror every selected shape
document.querySelectorAll("[data-mirror]").forEach((b) => b.addEventListener("click", () => {
  const key = b.dataset.mirror;
  const list = pickedShapes();
  if (!list.length) return;
  list.forEach((s) => { s[key] = (s[key] || 1) * -1; syncMesh(s); });
  refresh(true);
  commit();
  say(`${list.length === 1 ? list[0].name : list.length + " shapes"} mirrored.`);
}));

// ---------- Shape settings: sliders (sides, steps, corner radius...) ----------
function renderParams(s) {
  const box = $("#params");
  const defs = s ? paramsOf(s.type) : [];
  const sig = s ? `${s.id}:${s.type}:${units.get()}` : "";
  if (box.dataset.sig !== sig) {
    box.dataset.sig = sig;
    box.innerHTML = "";
    for (const p of defs) {
      const row = document.createElement("div");
      row.className = "param";
      if (p.options) {
        row.innerHTML = `<label><span>${p.label}</span><select class="param__select">${p.options.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></label>`;
        row.querySelector(".param__select").addEventListener("change", (e) => setProp(p.key, e.target.value));
        row.dataset.key = p.key;
        box.append(row);
        continue;
      }
      const len = p.unit === "mm"; // lengths show in the chosen unit; the slider still moves in millimetres
      const shown = (v) => (len ? units.num(v) : v);
      row.innerHTML = `<label><span>${p.label}${p.unit ? ` <i>${len ? units.label() : p.unit}</i>` : ""}</span><input type="number" class="param__num" ${len ? 'step="any"' : `min="${p.min}" max="${p.max}" step="${p.step}"`}></label>
        <input type="range" class="param__slider" min="${p.min}" max="${p.max}" step="${p.step}" aria-label="${p.label}">`;
      const num = row.querySelector(".param__num"), slider = row.querySelector(".param__slider");
      const clamp = (v) => Math.min(p.max, Math.max(p.min, v));
      slider.addEventListener("input", () => { num.value = shown(Number(slider.value)); setProp(p.key, clamp(Number(slider.value)), true); });
      slider.addEventListener("change", () => commit());
      num.addEventListener("change", () => {
        const v = len ? units.read(Number(num.value)) : Number(num.value);
        if (!Number.isFinite(v)) return refresh();
        setProp(p.key, clamp(v));
      });
      row.dataset.key = p.key;
      box.append(row);
    }
  }
  box.hidden = !defs.length;
  for (const row of box.querySelectorAll(".param")) {
    const p = defs.find((d) => d.key === row.dataset.key);
    const v = s[p.key] != null ? s[p.key] : p.value;
    const sel = row.querySelector(".param__select");
    if (sel) { sel.value = v; sel.disabled = !!s.locked; continue; }
    const num = row.querySelector(".param__num"), slider = row.querySelector(".param__slider");
    if (document.activeElement !== num) num.value = p.unit === "mm" ? units.num(v) : v;
    if (document.activeElement !== slider) slider.value = v;
    num.disabled = slider.disabled = !!s.locked;
  }
}

function setProp(key, value, noCommit) {
  const s = get(selected);
  if (!s) return;
  s[key] = value;
  if (key === "kind" && SHAPES[s.type] && SHAPES[s.type].natural) trueProportions(s); // a new kind of solid: true proportions again
  if (key === "color" && s.multicolor) s.multicolor = false; // picking one colour paints the whole group
  if (isPicture(s) && (key === "hole" || key === "color")) { s.hole = false; s.color = "#ffffff"; refresh(true); return; } // a picture keeps its own colours
  if (key === "hole" || key === "color") { if (key === "color") s.hole = false; meshes.get(s.id).material = s.hole ? holeMat : solidMat(s.color); }
  syncMesh(s);
  refresh(true);
  if (!noCommit) commit();
}

const fields = { w: "#f-w", d: "#f-d", h: "#f-h", y: "#f-y", r: "#f-r", t: "#f-t", l: "#f-l" };
Object.entries(fields).forEach(([key, sel]) => {
  const input = $(sel);
  input.addEventListener("change", () => {
    let v = Number(input.value);
    if (!Number.isFinite(v)) return refresh();
    if ("wdhy".includes(key)) v = Math.round(units.read(v) * 1000) / 1000; // lengths are typed in the chosen unit
    if ("wdh".includes(key)) v = Math.max(0.5, Math.min(400, v));
    const s = get(selected);
    if (s && s[key] === v) return; // already applied (Enter, then leaving the box)
    setProp(key, v);
  });
});
// Pressing Enter in a number or text box of the shape panel applies it straight away
// (otherwise a typed value only counts once you leave the box)
$("#inspector").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || !e.target.matches("input[type=number], input[type=text]")) return;
  e.preventDefault();
  e.target.dispatchEvent(new Event("change", { bubbles: true }));
  if (e.target.select) e.target.select();
});
$("#shape-name").addEventListener("change", (e) => setProp("name", e.target.value.trim() || get(selected).name));
// Text shapes: the letters update as you type; the width grows or shrinks with the number of letters
$("#f-text").addEventListener("input", (e) => {
  const s = get(selected);
  if (s && s.type === "braille") {
    // the tile grows or shrinks to fit the braille cells, keeping the dots their real size
    const k = s.w / brailleSize(s.text || "a").w;
    s.text = e.target.value;
    s.w = Math.round(brailleSize(s.text || "a").w * k * 100) / 100;
    syncMesh(s);
    refresh(true);
    return;
  }
  if (!s || s.type !== "text") return;
  const before = (s.text || "Text").trim().length || 4;
  const after = e.target.value.trim().length || 4;
  s.w = Math.max(4, Math.round((s.w * after) / before * 10) / 10);
  s.text = e.target.value;
  syncMesh(s);
  refresh(true);
});
$("#f-text").addEventListener("change", () => commit());
$("#mode-solid").addEventListener("click", () => setProp("hole", false));
$("#mode-hole").addEventListener("click", () => setProp("hole", true));
$("#deselect").addEventListener("click", () => select(null));
$("#delete").addEventListener("click", removeSelected);
$("#duplicate").addEventListener("click", duplicateSelected);
$("#group").addEventListener("click", groupAll);
$("#ungroup").addEventListener("click", ungroupSelected);
$("#undo").addEventListener("click", undo);
$("#redo").addEventListener("click", redo);
$("#view-home").addEventListener("click", homeView);
$("#flat-view").addEventListener("click", () => { setFlatView(!flatView); say(flatView ? "Flat view." : "3D view."); });
if (localStorage.getItem("shapeforge-flat-view") === "1") setFlatView(true);
$("#help").addEventListener("click", () => $("#help-dialog").showModal());
$("#export").addEventListener("click", () => openExport());
$("#snap").addEventListener("change", () => { save(); updateStatus(); });
// Snap choices follow the unit: millimetre steps, or fractions of an inch. Picks the closest step.
function setSnap(mm) {
  const sel = $("#snap");
  const list = units.snaps();
  sel.innerHTML = list.map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
  let best = list[0];
  if (mm > 0) for (const o of list) if (o[0] > 0 && (best[0] === 0 || Math.abs(Math.log(o[0] / mm)) < Math.abs(Math.log(best[0] / mm)))) best = o;
  sel.value = String(best[0]);
  if (typeof renderSnapList === "function") renderSnapList();
}
// Units: millimetres or inches, for everything shown and typed (designs are still kept in millimetres)
function applyUnits() {
  document.querySelectorAll(".u-len").forEach((el) => { el.textContent = units.label(); });
  ["#f-w", "#f-d", "#f-h", "#f-y"].forEach((id) => { const el = $(id); el.step = units.get() === "in" ? "0.0625" : "1"; el.removeAttribute("min"); el.removeAttribute("max"); });
  $("#units").value = units.get();
}
$("#units").addEventListener("change", (e) => {
  const before = Number($("#snap").value);
  units.set(e.target.value);
  // keep a similar snap step: 1 mm becomes 1/16 in, and back again
  setSnap(before === BRICK ? BRICK : before ? (units.get() === "in" ? Math.max(before, 25.4 / 64) * 1.6 : before / 1.6) : 0);
  applyUnits();
  buildWorkplane();
  fadeWorkplane();
  showPlaneSize();
  refresh(true);
  save();
  say(units.get() === "in" ? "Sizes are now shown in inches. Designs are still saved and exported in millimetres." : "Sizes are now shown in millimetres.");
});
setSnap(Number($("#snap").value) || 1);
applyUnits();
$("#project-name").addEventListener("change", save);

function undo() { if (!undoStack.length) return; redoStack.push(snapshot()); restore(undoStack.pop()); updateButtons(); say("Undone."); }
function redo() { if (!redoStack.length) return; undoStack.push(snapshot()); restore(redoStack.pop()); updateButtons(); say("Redone."); }
function updateButtons() {
  $("#undo").disabled = !undoStack.length;
  $("#redo").disabled = !redoStack.length;
  $("#delete").disabled = $("#duplicate").disabled = !selected;
  $("#group").disabled = shapes.length < 2;
  $("#ungroup").disabled = get(selected)?.type !== "group";
  $("#align").disabled = picked.size < 2;
}

// Several shapes selected: their combined size, and with exactly two, the gap between them
function selectionSummary() {
  const list = pickedShapes().filter((x) => meshes.has(x.id));
  const boxes = list.map((x) => { const m = meshes.get(x.id); m.updateMatrixWorld(); return new THREE.Box3().setFromObject(m); });
  const all = boxes.reduce((acc, b) => acc.union(b), new THREE.Box3());
  const size = all.getSize(new THREE.Vector3());
  const r = (v) => +v.toFixed(1);
  let text = `Selected: ${list.length} shapes, together ${r(size.x)} × ${r(size.z)} × ${r(size.y)} mm`;
  if (boxes.length === 2) {
    const [a, b] = boxes;
    const gap = (axis) => Math.max(0, a.min[axis] - b.max[axis], b.min[axis] - a.max[axis]);
    const gaps = [["left–right", gap("x")], ["front–back", gap("z")], ["up–down", gap("y")]].filter(([, g]) => g > 0.005);
    text += gaps.length ? ` · gap ${gaps.map(([n, g]) => `${r(g)} mm ${n}`).join(", ")}` : " · touching or overlapping";
  }
  return text;
}

function updateStatus() {
  const n = shapes.length;
  const holes = shapes.filter((s) => s.hole).length;
  $("#st-count").textContent = n ? `${n} shape${n === 1 ? "" : "s"}${holes ? ` (${holes} hole${holes === 1 ? "" : "s"})` : ""}` : "No shapes yet";
  const s = get(selected);
  $("#st-sel").textContent = picked.size > 1 ? selectionSummary() : s ? `Selected: ${s.name}, ${units.num(s.w)} × ${units.num(s.d)} × ${units.num(s.h)} ${units.label()}` : "";
  const st = Number($("#snap").value);
  const opt = $("#snap").selectedOptions[0];
  $("#st-snap").textContent = st && opt ? `Snap: ${opt.textContent}${isBrick() ? ` (${units.text(BRICK)} across, ${units.text(BRICK_UP)} up)` : ""}` : "Snap: off";
  $("#st-units").textContent = `Units: ${units.name()}`;
  updateFitWarning();
  if (typeof scheduleThinCheck === "function" && typeof workspace !== "undefined") scheduleThinCheck();
}

// Warn when part of the design hangs off the workplane (it may not fit the printer)
function updateFitWarning() {
  const warn = $("#st-fit");
  if (!warn) return;
  const solids = shapes.filter((s) => !s.hidden && !s.hole && !isPicture(s) && meshes.has(s.id));
  if (!solids.length) { warn.hidden = true; return; }
  const all = new THREE.Box3();
  solids.forEach((s) => { const m = meshes.get(s.id); m.updateMatrixWorld(); all.union(new THREE.Box3().setFromObject(m)); });
  const size = all.getSize(new THREE.Vector3());
  const off = all.min.x < -planeW / 2 - 0.01 || all.max.x > planeW / 2 + 0.01 || all.min.z < -planeD / 2 - 0.01 || all.max.z > planeD / 2 + 0.01;
  const tooBig = size.x > planeW + 0.01 || size.z > planeD + 0.01;
  const below = all.min.y < -0.01;
  warn.hidden = !(off || below);
  warn.textContent = tooBig
    ? `⚠ The design (${Math.round(size.x)} × ${Math.round(size.z)} mm) is bigger than the workplane`
    : off ? "⚠ Part of the design is off the workplane" : "⚠ Part of the design is below the workplane";
}

// ---------- Thin walls: parts a 3D printer may not be able to make ----------
var thinCache = { key: "", result: null }; // var: the status bar can ask before this line runs
var thinOverlay = null, thinOverlayKey = "", thinTimer = 0, thinSlow = false;
function thinKey(list) { return workspace.thin + "|" + JSON.stringify(list); }
function checkThin(list = shapes.filter((s) => !s.hidden && !isPicture(s))) {
  if (!workspace.thin || !list.some((s) => !s.hole)) return null;
  const key = thinKey(list);
  if (thinCache.key === key) return thinCache.result;
  const t0 = performance.now();
  const g = combine(list);
  const r = g ? findThinSpots(g, workspace.thin) : null;
  const ms = performance.now() - t0;
  thinSlow = ms > 1200; // big designs: only check when exporting, so editing stays smooth
  thinCache = { key, result: r };
  return r;
}
function showThinSpots() {
  const list = shapes.filter((s) => !s.hidden && !isPicture(s));
  const r = checkThin(list);
  hideThinSpots();
  if (!isWorthWarning(r)) { say("No thin walls found."); return; }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(r.positions, 3));
  thinOverlay = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xff1744, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }));
  thinOverlay.renderOrder = 5;
  scene.add(thinOverlay);
  thinOverlayKey = thinKey(list);
  if (typeof wake === "function") wake(800);
  say(`Thin walls (under ${units.text(workspace.thin)}) are shown in red. Make them thicker, or they may not print. The red goes away when you change the design or press Esc.`);
}
function hideThinSpots() {
  if (!thinOverlay) return;
  scene.remove(thinOverlay);
  thinOverlay.geometry.dispose();
  thinOverlay = null;
  if (typeof wake === "function") wake(300);
}
// check a moment after the design stops changing, and say so in the status bar
function scheduleThinCheck() {
  clearTimeout(thinTimer);
  const el = $("#st-thin");
  if (!el) return;
  const list = shapes.filter((s) => !s.hidden && !isPicture(s));
  if (thinOverlay && thinKey(list) !== thinOverlayKey) hideThinSpots();
  if (!workspace.thin || !list.some((s) => !s.hole)) { el.hidden = true; return; }
  if (thinCache.key === thinKey(list)) { showThinStatus(thinCache.result); return; }
  el.hidden = true;
  if (thinSlow) return;
  thinTimer = setTimeout(() => {
    if (drag) { scheduleThinCheck(); return; }
    showThinStatus(checkThin());
  }, 1200);
}
function showThinStatus(r) {
  const el = $("#st-thin");
  el.hidden = !isWorthWarning(r);
  if (!el.hidden) $("#st-thin-text").textContent = `⚠ Walls thinner than ${units.text(workspace.thin)} may not print`;
}
$("#st-thin-show").addEventListener("click", showThinSpots);
window.addEventListener("keydown", (e) => { if (e.key === "Escape" && thinOverlay) hideThinSpots(); });

function refresh(keepFocus) {
  if (typeof wake === "function") wake(1000);
  updateStatus();
  const s = get(selected);
  const insp = $("#inspector");
  insp.hidden = !s;
  document.querySelectorAll("#inspector input, #inspector .mirrorrow button, #mode-solid, #mode-hole, #swatches button").forEach((el) => { el.disabled = !!(s && s.locked); });
  $("#inspector").classList.toggle("is-locked", !!(s && s.locked));
  renderParams(s);
  $("#text-row").hidden = !(s && (s.type === "text" || s.type === "braille"));
  document.querySelector(".inspector__mode").hidden = isPicture(s);
  $("#swatches").hidden = isPicture(s);
  $("#multi-row").hidden = !(s && s.type === "group" && !s.hole);
  $("#f-multi").checked = !!(s && s.multicolor);
  $("#clear-row").hidden = !(s && !s.hole && !isPicture(s)); // pictures have their own see-through slider
  $("#f-clear").checked = !!(s && s.clear);
  if (s && (s.type === "text" || s.type === "braille") && document.activeElement !== $("#f-text")) $("#f-text").value = s.text || "Text";
  if (s) {
    if (!keepFocus || document.activeElement !== $("#shape-name")) $("#shape-name").value = s.name;
    for (const [k, sel] of Object.entries(fields)) if (document.activeElement !== $(sel)) $(sel).value = "wdhy".includes(k) ? units.num(s[k] || 0) : Math.round((s[k] || 0) * 100) / 100;
    $("#mode-solid").setAttribute("aria-checked", String(!s.hole));
    $("#mode-hole").setAttribute("aria-checked", String(s.hole));
    swatches.querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(!s.hole && !s.multicolor && b.dataset.color === s.color)));
  }
  const list = $("#outline");
  list.innerHTML = "";
  if (!shapes.length) list.innerHTML = '<li class="empty">No shapes yet.</li>';
  shapes.forEach((sh) => {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    b.innerHTML = `<i style="background:${sh.hole ? "repeating-linear-gradient(45deg,#9aa0a8 0 3px,#fff 3px 6px)" : sh.color}"></i>`;
    b.append(sh.name + (sh.hole ? " (hole)" : ""));
    b.setAttribute("aria-current", String(picked.has(sh.id)));
    b.addEventListener("click", (e) => (e.shiftKey || e.ctrlKey || e.metaKey ? togglePick(sh.id) : select(sh.id)));
    if (sh.hidden) b.classList.add("is-hidden");
    const eye = document.createElement("button");
    eye.type = "button";
    eye.className = "rowicon";
    eye.setAttribute("aria-pressed", String(!!sh.hidden));
    eye.setAttribute("aria-label", (sh.hidden ? "Show " : "Hide ") + sh.name);
    eye.title = sh.hidden ? "Show this shape" : "Hide this shape";
    eye.innerHTML = sh.hidden ? EYE_OFF : EYE;
    eye.addEventListener("click", () => toggleFlag(sh, "hidden"));
    const lock = document.createElement("button");
    lock.type = "button";
    lock.className = "rowicon";
    lock.setAttribute("aria-pressed", String(!!sh.locked));
    lock.setAttribute("aria-label", (sh.locked ? "Unlock " : "Lock ") + sh.name);
    lock.title = sh.locked ? "Unlock this shape" : "Lock this shape so it can't be moved or changed";
    lock.innerHTML = sh.locked ? LOCK : UNLOCK;
    lock.addEventListener("click", () => toggleFlag(sh, "locked"));
    li.className = "outline__row";
    li.append(b, eye, lock);
    list.append(li);
  });
  $("#hint").hidden = shapes.length > 0;
  if (aligning) {
    clearAlignPreview();
    if (alignList().length < 2) aligning = null;
    else { if (aligning.key && !picked.has(aligning.key)) aligning.key = null; updateAlignBounds(); }
  }
  $("#align-box").hidden = picked.size < 2;
  $("#align-start").hidden = !!aligning;
  $("#align-done").hidden = !aligning;
  $("#align-tip").textContent = aligning
    ? (aligning.key ? `Lining up to ${get(aligning.key).name}. Click a dot.` : "Click a dot to line up. Click a shape to keep it still.")
    : `${picked.size} shapes selected`;
  $("#align").setAttribute("aria-pressed", String(!!aligning));
  updateButtons();
}

// ---------- Pointer: pick and drag on the workplane ----------
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
function setRay(cx, cy) {
  const r = renderer.domElement.getBoundingClientRect();
  ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
}
function planePoint(cx, cy, y) {
  setRay(cx, cy);
  const p = new THREE.Vector3();
  return ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -y), p) ? p : null;
}

// Scale handles: corners stretch width and depth, side squares stretch one direction,
// the top square changes the height. Hold Shift to keep the proportions.
const handleGroup = new THREE.Group();
scene.add(handleGroup);
const handleGeo = new THREE.BoxGeometry(1, 1, 1);
const handleMat = new THREE.MeshBasicMaterial({ color: 0x282727, depthTest: false }); // black resize squares
const rimMat = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false });
const HANDLES = [
  [-1, -1, "nwse"], [1, -1, "nesw"], [1, 1, "nwse"], [-1, 1, "nesw"],
  [0, -1, "ns"], [1, 0, "ew"], [0, 1, "ns"], [-1, 0, "ew"],
].map(([sx, sz, cursor]) => ({ sx, sz, top: false, cursor }));
HANDLES.push({ sx: 0, sz: 0, top: true, cursor: "ns" });
HANDLES.push({ sx: 0, sz: 0, rotate: true, cursor: "grab" });
HANDLES.push({ sx: 0, sz: 0, spin: "t", cursor: "grab" }); // tilt: forward and back
HANDLES.push({ sx: 0, sz: 0, spin: "l", cursor: "grab" }); // roll: side to side
HANDLES.push({ sx: 0, sz: 0, lift: true, cursor: "ns" });
const liftGeo = new THREE.ConeGeometry(0.8, 1.6, 16);
const rotateGeo = new THREE.TorusGeometry(0.9, 0.28, 8, 24, Math.PI * 1.5).rotateX(-Math.PI / 2);
const rotateMat = new THREE.MeshBasicMaterial({ color: 0xff7a1a, depthTest: false });
const grabMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, depthTest: false });
HANDLES.forEach((h) => {
  let m;
  if (h.rotate || h.spin) {
    // an invisible disc makes the whole arrow easy to grab; the orange arrow sits on top of it
    m = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.3, 0.3, 24), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, depthTest: false }));
    const arrow = new THREE.Mesh(rotateGeo, rotateMat);
    arrow.renderOrder = 11;
    m.add(arrow);
  } else {
    // an invisible grab area twice the size of the small visible square or cone
    m = new THREE.Mesh(handleGeo, grabMat);
    const look = h.lift
      ? new THREE.Mesh(liftGeo, new THREE.MeshBasicMaterial({ color: 0x282727, depthTest: false }))
      : new THREE.Mesh(handleGeo, h.top ? new THREE.MeshBasicMaterial({ color: 0x282727, depthTest: false }) : handleMat);
    look.scale.setScalar(h.lift ? 0.7 : 0.5);
    look.renderOrder = 12;
    m.add(look);
    if (!h.lift) {
      // a white rim (a slightly bigger white square drawn behind) keeps the black squares visible on any colour
      const rim = new THREE.Mesh(handleGeo, rimMat);
      rim.scale.setScalar(0.66);
      rim.renderOrder = 11;
      m.add(rim);
    }
  }
  m.renderOrder = 10;
  m.userData.handle = h;
  h.mesh = m;
  handleGroup.add(m);
});

const deg2rad = THREE.MathUtils.degToRad;
// shape-local (x, z) offset -> world offset, following the shape's turn
function toWorld(s, lx, lz) {
  const a = deg2rad(s.r || 0);
  return { x: lx * Math.cos(a) + lz * Math.sin(a), z: -lx * Math.sin(a) + lz * Math.cos(a) };
}
// The shape's full turn, tilt and roll, and points given in its own frame (x across, y up from
// its base, z front to back) placed in the world. For a shape that is only turned this is the
// same as toWorld/toLocal; for a tilted shape it follows the tilt.
const shapeQuat = (s) => new THREE.Quaternion().setFromEuler(new THREE.Euler(deg2rad(s.t || 0), deg2rad(s.r || 0), deg2rad(s.l || 0), "YXZ"));
const shapeUp = (s) => new THREE.Vector3(0, 1, 0).applyQuaternion(shapeQuat(s));
function localPoint(s, lx, ly, lz) { return new THREE.Vector3(lx, ly, lz).applyQuaternion(shapeQuat(s)).add(new THREE.Vector3(s.x, s.y, s.z)); }
function localOffset(s, lx, ly, lz) { return new THREE.Vector3(lx, ly, lz).applyQuaternion(shapeQuat(s)); }
function toLocal(s, wx, wz) {
  const a = deg2rad(s.r || 0);
  return { x: wx * Math.cos(a) - wz * Math.sin(a), z: wx * Math.sin(a) + wz * Math.cos(a) };
}

function placeHandles() {
  const s = get(selected);
  handleGroup.visible = !!s && !s.locked && !s.hidden && picked.size <= 1 && !aligning && !(drag && drag.mode === "move");
  if (!s) return;
  HANDLES.forEach((h) => {
    let pos;
    if (h.top) pos = localPoint(s, 0, s.h + 4, 0);
    else if (h.lift) pos = localPoint(s, 0, s.h, 0).add(new THREE.Vector3(0, 14, 0));
    else if (h.rotate) {
      const o = toWorld(s, 0, s.d / 2 + 12); // just in front of the shape
      pos = new THREE.Vector3(s.x + o.x, s.y, s.z + o.z);
    } else if (h.spin === "t") {
      const o = toWorld(s, s.w / 2 + 12, 0); // to the right of the shape, half way up
      pos = new THREE.Vector3(s.x + o.x, s.y + s.h / 2, s.z + o.z);
    } else if (h.spin === "l") {
      const o = toWorld(s, 0, s.d / 2 + 12); // in front of the shape, half way up
      pos = new THREE.Vector3(s.x + o.x, s.y + s.h / 2, s.z + o.z);
    } else pos = localPoint(s, (h.sx * s.w) / 2, 0, (h.sz * s.d) / 2); // corners and sides of the base, tilted with the shape
    h.mesh.position.copy(pos);
    // a fixed size in screen pixels: small squares, a slightly larger turn arrow and lift cone
    const px = h.rotate || h.spin ? 13 : h.lift ? 18 : 16; // grab areas; the visible squares are half this size (8 px)
    const mmPerPixel = (2 * camera.position.distanceTo(pos) * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / Math.max(host.clientHeight, 1);
    const size = px * mmPerPixel;
    h.mesh.scale.setScalar(size);
    // stand the tilt and roll arrows upright, facing along the axis they turn around
    if (h.spin === "t") h.mesh.rotation.set(0, deg2rad(s.r || 0), Math.PI / 2, "YXZ");
    else if (h.spin === "l") h.mesh.rotation.set(Math.PI / 2, deg2rad(s.r || 0), 0, "YXZ");
    else if (h.lift || h.rotate) h.mesh.rotation.set(0, deg2rad(s.r || 0), 0);
    else h.mesh.quaternion.copy(shapeQuat(s));
  });
}

// Pick a handle by where it appears on screen (within a few pixels of the pointer), so a handle
// hidden behind a shape is never grabbed by clicking the middle of that shape.
function pickHandle(cx, cy) {
  const r = canvas.getBoundingClientRect();
  camera.updateMatrixWorld();
  let best = null;
  for (const h of HANDLES) {
    const p = h.mesh.position.clone().project(camera);
    if (p.z > 1) continue; // behind the camera
    const sx = r.left + ((p.x + 1) / 2) * r.width, sy = r.top + ((1 - p.y) / 2) * r.height;
    const d = Math.hypot(cx - sx, cy - sy);
    const reach = h.rotate || h.spin ? 13 : h.lift ? 11 : 9;
    if (d <= reach && (!best || d < best.d)) best = { d, object: h.mesh };
  }
  return best;
}

function verticalPlaneThrough(point) {
  const n = new THREE.Vector3();
  camera.getWorldDirection(n);
  n.y = 0;
  if (n.lengthSq() < 1e-6) n.set(0, 0, 1);
  n.normalize();
  return new THREE.Plane().setFromNormalAndCoplanarPoint(n, point);
}

let drag = null;
const canvas = renderer.domElement;

// Runs before the view controls see the press, so grabbing a shape never also turns the view
host.addEventListener("pointerdown", (e) => {
  if (e.target === canvas && document.activeElement && document.activeElement.matches("input, select, textarea")) document.activeElement.blur();
  if (e.button !== 0 || e.target !== canvas) return;
  if (placingPlane) {
    e.stopPropagation(); e.preventDefault(); drag = null;
    placePlaneAt(e.clientX, e.clientY);
    return;
  }
  if (ruler.placing) {
    e.stopPropagation(); e.preventDefault(); drag = null;
    ruler.pointerDown(planePoint(e.clientX, e.clientY, 0));
    return;
  }
  // grab the ruler by its corner or an arm and drag it somewhere else
  if (ruler.hit(e.clientX, e.clientY)) {
    e.stopPropagation(); e.preventDefault();
    const p0 = planePoint(e.clientX, e.clientY, 0);
    drag = { mode: "ruler", off: p0 ? ruler.origin.clone().sub(p0) : new THREE.Vector3(), pointer: e.pointerId };
    try { canvas.setPointerCapture(e.pointerId); } catch { /* not a real pointer */ }
    return;
  }
  if (aligning) {
    scene.updateMatrixWorld();
    camera.updateMatrixWorld();
    placeAlign();
    const dot = pickAlignDot(e.clientX, e.clientY);
    if (dot) { e.stopPropagation(); e.preventDefault(); drag = null; alignSelection(dot.axis, dot.where); return; }
    clearAlignPreview();
    setRay(e.clientX, e.clientY);
    const over = ray.intersectObjects(visibleMeshes(), false)[0];
    const id = over && over.object.userData.id;
    if (id && picked.has(id) && !(e.shiftKey || e.ctrlKey || e.metaKey)) {
      e.stopPropagation(); e.preventDefault(); drag = null;
      aligning.key = aligning.key === id ? null : id;
      refresh(true);
      say(aligning.key ? `${get(id).name} stays still; the other shapes line up to it.` : "The shapes line up to each other again.");
      return;
    }
    // anything else (another shape, empty space) carries on as normal
  }
  // use up-to-date positions even if no frame has been drawn since the last change
  placeHandles();
  scene.updateMatrixWorld();
  camera.updateMatrixWorld();
  setRay(e.clientX, e.clientY);
  const s0 = get(selected);
  const hHit = s0 && handleGroup.visible ? pickHandle(e.clientX, e.clientY) : null;
  if (hHit) {
    const h = hHit.object.userData.handle;
    e.stopPropagation();
    e.preventDefault();
    drag = { mode: h.spin ? "spin" : h.rotate ? "rotate" : h.lift ? "lift" : h.top ? "height" : "scale", h, s: s0, start: { ...s0 }, moved: false, pointer: e.pointerId };
    if (h.spin) {
      // measure the angle in the upright plane the arrow turns in
      const turn = deg2rad(s0.r || 0);
      const axis = h.spin === "t" ? new THREE.Vector3(Math.cos(turn), 0, -Math.sin(turn)) : new THREE.Vector3(Math.sin(turn), 0, Math.cos(turn));
      const center = new THREE.Vector3(s0.x, s0.y + s0.h / 2, s0.z);
      const u1 = new THREE.Vector3(0, 1, 0), u2 = new THREE.Vector3().crossVectors(axis, u1).normalize();
      drag.spinPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(axis, center);
      Object.assign(drag, { center, u1, u2, key: h.spin });
      setRay(e.clientX, e.clientY);
      const hit = new THREE.Vector3();
      const v = (ray.ray.intersectPlane(drag.spinPlane, hit) || h.mesh.position.clone()).clone().sub(center);
      drag.a0 = Math.atan2(v.dot(u2), v.dot(u1));
    }
    if (h.rotate) {
      const p = planePoint(e.clientX, e.clientY, s0.y) || new THREE.Vector3(s0.x, s0.y, s0.z + 1);
      drag.a0 = Math.atan2(p.z - s0.z, p.x - s0.x);
    }
    if (h.lift) drag.plane = verticalPlaneThrough(h.mesh.position.clone());
    // resizing works in the shape's own frame, so a tilted shape stretches along its own edges
    drag.up = shapeUp(s0);
    drag.base = new THREE.Vector3(s0.x, s0.y, s0.z);
    drag.basePlane = new THREE.Plane().setFromNormalAndCoplanarPoint(drag.up, drag.base);
    if (h.top) {
      // an upright plane along the shape's height, facing the camera as much as it can
      const look = new THREE.Vector3();
      camera.getWorldDirection(look);
      look.addScaledVector(drag.up, -look.dot(drag.up));
      if (look.lengthSq() < 1e-6) look.set(1, 0, 0).addScaledVector(drag.up, -drag.up.x);
      drag.plane = new THREE.Plane().setFromNormalAndCoplanarPoint(look.normalize(), h.mesh.position.clone());
    }
    if (h.lift) {
      setRay(e.clientX, e.clientY);
      const p0 = new THREE.Vector3();
      drag.y0 = ray.ray.intersectPlane(drag.plane, p0) ? p0.y : h.mesh.position.y;
    }
    try { canvas.setPointerCapture(e.pointerId); } catch { /* not a real pointer */ }
    return;
  }
  const hit = ray.intersectObjects(visibleMeshes(), false)[0];
  if (hit) {
    e.stopPropagation();
    e.preventDefault();
    const s = get(hit.object.userData.id);
    if (e.shiftKey || e.ctrlKey || e.metaKey) { togglePick(s.id); drag = null; return; }
    if (picked.has(s.id) && picked.size > 1) { selected = s.id; refresh(); } // keep the whole selection to move it together
    else if (selected !== s.id || picked.size !== 1) select(s.id);
    // the point you grabbed follows the pointer, at the height you grabbed it
    const gy = Math.max(0, hit.point.y - s.y);
    const p = planePoint(e.clientX, e.clientY, s.y + gy) || new THREE.Vector3(s.x, s.y, s.z);
    const group = pickedShapes().filter((o) => !o.locked).map((o) => ({ s: o, ox: o.x - p.x, oz: o.z - p.z }));
    if (s.locked) { say(`${s.name} is locked. Click its padlock in Your design to unlock it.`); drag = null; return; }
    group.forEach((g) => { g.dy = g.s.y - s.y; });
    drag = { mode: "move", s, group, dx: s.x - p.x, dz: s.z - p.z, moved: false, pointer: e.pointerId, x: e.clientX, y: e.clientY, y0: s.y, gy, resting: restingOnSomething(s, group) };
    // a shape standing on a sloping or upright workplane slides along that workplane
    if (tempPlane && tempPlane.normal.y < 0.999 && standsOnTempPlane(s)) {
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(tempPlane.normal, tempPlane.point);
      const grab = new THREE.Vector3();
      setRay(e.clientX, e.clientY);
      if (ray.ray.intersectPlane(plane, grab)) drag.slide = { plane, grab, start: group.map((g) => new THREE.Vector3(g.s.x, g.s.y, g.s.z)) };
    }
    try { canvas.setPointerCapture(e.pointerId); } catch { /* not a real pointer */ }
    return;
  }
  // empty space: let the view controls turn the camera; a click without moving deselects
  drag = { mode: "empty", x: e.clientX, y: e.clientY };
}, { capture: true });

// ---------- Align tool (L): dots around the selected shapes ----------
// Hover a dot to preview, click it to line the shapes up. Click one of the selected shapes
// first to keep it still: the others then line up to it.
const ALIGN_WORDS = {
  x: { min: "left edges", mid: "centres (left to right)", max: "right edges" },
  z: { min: "back edges", mid: "middles (front to back)", max: "front edges" },
  y: { min: "bottoms", mid: "halfway heights", max: "tops" },
};
const alignGroup = new THREE.Group();
alignGroup.visible = false;
scene.add(alignGroup);
function dotTexture(core) {
  const c = document.createElement("canvas");
  c.width = c.height = 96;
  const g = c.getContext("2d");
  g.shadowColor = "rgba(0,0,0,.45)";
  g.shadowBlur = 10;
  g.fillStyle = "#ffffff";
  g.beginPath(); g.arc(48, 48, 34, 0, Math.PI * 2); g.fill();
  g.shadowColor = "transparent";
  g.fillStyle = core;
  g.beginPath(); g.arc(48, 48, 23, 0, Math.PI * 2); g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const dotMat = new THREE.SpriteMaterial({ map: dotTexture("#1d2433"), depthTest: false, depthWrite: false });
const dotHot = new THREE.SpriteMaterial({ map: dotTexture("#e5322d"), depthTest: false, depthWrite: false });
const ALIGN_DOTS = [];
for (const axis of ["x", "z", "y"]) for (const where of ["min", "mid", "max"]) {
  const m = new THREE.Sprite(dotMat); // faces the camera, so it reads the same from any angle
  m.renderOrder = 13;
  alignGroup.add(m);
  ALIGN_DOTS.push({ axis, where, mesh: m });
}
const alignLineMat = new LineMaterial({ color: 0x1d2433, linewidth: 3, transparent: true, opacity: 0.8, depthTest: false, depthWrite: false });
const ALIGN_LINES = ["x", "z", "y"].map((axis) => {
  const l = new Line2(new LineGeometry().setPositions([0, 0, 0, 1, 0, 0]), alignLineMat);
  l.renderOrder = 12;
  l.frustumCulled = false;
  alignGroup.add(l);
  return { axis, line: l };
});
const keyBox = new THREE.Box3();
const keyHelper = new THREE.Box3Helper(keyBox, 0xff7a1a);
keyHelper.material.depthTest = false;
keyHelper.renderOrder = 11;
keyHelper.visible = false;
scene.add(keyHelper);

function exactBox(s) {
  const m = meshes.get(s.id);
  m.updateMatrixWorld();
  return new THREE.Box3().setFromObject(m, true);
}
function alignList() { return pickedShapes().filter((s) => meshes.has(s.id) && !s.hidden); }

// Where each shape has to go: the outer box of the selection, or the key shape's box, is the guide
function alignMoves(axis, where) {
  const list = alignList();
  const boxes = list.map(exactBox);
  const keyAt = aligning && aligning.key ? list.findIndex((s) => s.id === aligning.key) : -1;
  const ref = keyAt >= 0 ? boxes[keyAt] : boxes.reduce((a, b) => a.clone().union(b));
  const moves = [];
  list.forEach((s, i) => {
    if (i === keyAt || s.locked) return;
    const b = boxes[i];
    const delta = where === "min" ? ref.min[axis] - b.min[axis] : where === "max" ? ref.max[axis] - b.max[axis]
      : (ref.min[axis] + ref.max[axis]) / 2 - (b.min[axis] + b.max[axis]) / 2;
    if (Math.abs(delta) > 1e-6) moves.push({ s, delta });
  });
  return { list, moves, key: keyAt >= 0 ? list[keyAt] : null };
}

function clearAlignPreview() {
  if (!aligning) return;
  for (const s of aligning.preview || []) { const cur = get(s.id); if (cur && meshes.has(cur.id)) syncMesh(cur); }
  aligning.preview = null;
  aligning.hover = null;
}
function previewAlign(dot) {
  clearAlignPreview();
  if (!dot) return;
  const { moves } = alignMoves(dot.axis, dot.where);
  moves.forEach(({ s, delta }) => { meshes.get(s.id).position[dot.axis] += delta; });
  aligning.preview = moves.map((m) => m.s);
  aligning.hover = dot;
}

// Line up the selected shapes by their outer edges or centres
function alignSelection(axis, where) {
  clearAlignPreview();
  const { list, moves, key } = alignMoves(axis, where);
  if (list.length < 2) { say("Select two or more shapes (Shift+click or Ctrl+A) to line them up."); return; }
  moves.forEach(({ s, delta }) => { s[axis] = Math.round((s[axis] + delta) * 100) / 100; syncMesh(s); });
  refresh(true);
  if (moves.length) commit();
  say(moves.length ? `Lined up the ${ALIGN_WORDS[axis][where]}${key ? ` to ${key.name}` : ""}.` : `The ${ALIGN_WORDS[axis][where]} already line up.`);
}

function updateAlignBounds() {
  if (!aligning) return;
  const list = alignList();
  aligning.bounds = list.length ? list.map(exactBox).reduce((a, b) => a.union(b)) : null;
}
function startAlign() {
  if (alignList().length < 2) { say("Select two or more shapes (Shift+click or Ctrl+A), then press L to align them."); return; }
  aligning = { key: null, bounds: null, hover: null, preview: null };
  refresh(true);
  say("Align: hover a dot to preview, click it to line the shapes up. Click one of the shapes to keep it still. Press Esc when done.");
}
function stopAlign() {
  if (!aligning) return;
  clearAlignPreview();
  aligning = null;
  alignGroup.visible = keyHelper.visible = false;
  refresh(true);
}
const toggleAlign = () => (aligning ? stopAlign() : startAlign());

// keep the dots a fixed size on screen and just outside the selection
function placeAlign() {
  alignGroup.visible = !!aligning && !!aligning.bounds;
  keyHelper.visible = false;
  if (!alignGroup.visible) return;
  const b = aligning.bounds;
  const c = b.getCenter(new THREE.Vector3());
  const mmPerPixel = (2 * camera.position.distanceTo(c) * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / Math.max(host.clientHeight, 1);
  const gap = 30 * mmPerPixel;
  const at = (lo, hi, where) => (where === "min" ? lo : where === "max" ? hi : (lo + hi) / 2);
  for (const d of ALIGN_DOTS) {
    if (d.axis === "x") d.mesh.position.set(at(b.min.x, b.max.x, d.where), b.min.y, b.max.z + gap); // along the front
    else if (d.axis === "z") d.mesh.position.set(b.min.x - gap, b.min.y, at(b.min.z, b.max.z, d.where)); // along the left side
    else d.mesh.position.set(b.max.x + gap, at(b.min.y, b.max.y, d.where), b.min.z - gap); // up the back-right corner
    const px = aligning.hover === d ? 26 : 20; // the white ring is about 14 px across, 18 px when pointed at
    d.mesh.scale.setScalar(px * (2 * camera.position.distanceTo(d.mesh.position) * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / Math.max(host.clientHeight, 1));
    d.mesh.material = aligning.hover === d ? dotHot : dotMat;
  }
  alignLineMat.resolution.set(host.clientWidth, host.clientHeight);
  for (const { axis, line } of ALIGN_LINES) {
    const [lo, , hi] = ALIGN_DOTS.filter((d) => d.axis === axis);
    line.geometry.setPositions([lo.mesh.position.x, lo.mesh.position.y, lo.mesh.position.z, hi.mesh.position.x, hi.mesh.position.y, hi.mesh.position.z]);
  }
  const key = aligning.key && get(aligning.key);
  if (key && meshes.has(key.id)) { keyBox.setFromObject(meshes.get(key.id)); keyHelper.visible = true; }
}
function pickAlignDot(cx, cy) {
  if (!aligning) return null;
  const r = canvas.getBoundingClientRect();
  camera.updateMatrixWorld();
  let best = null;
  for (const d of ALIGN_DOTS) {
    const p = d.mesh.position.clone().project(camera);
    if (p.z > 1) continue;
    const dist = Math.hypot(cx - (r.left + ((p.x + 1) / 2) * r.width), cy - (r.top + ((1 - p.y) / 2) * r.height));
    if (dist <= 13 && (!best || dist < best.dist)) best = { dist, d };
  }
  return best && best.d;
}

// Is this shape sitting on the workplane or on top of another shape (rather than floating)?
function restingOnSomething(s, group) {
  if (s.y < 0.01) return true;
  const moving = new Set(group.map((g) => g.s.id));
  scene.updateMatrixWorld();
  const mine = new THREE.Box3().setFromObject(meshes.get(s.id));
  // another shape whose top is level with this shape's bottom, and whose outline overlaps it
  return visibleMeshes().some((m) => {
    if (moving.has(m.userData.id)) return false;
    const b = new THREE.Box3().setFromObject(m);
    return Math.abs(b.max.y - s.y) < 0.2 && b.min.x < mine.max.x && b.max.x > mine.min.x && b.min.z < mine.max.z && b.max.z > mine.min.z;
  });
}
// The top of another shape under the pointer (a face pointing mostly upwards), or null
function surfaceUnder(cx, cy, group) {
  const moving = new Set(group.map((g) => g.s.id));
  scene.updateMatrixWorld();
  setRay(cx, cy);
  const hit = ray.intersectObjects(visibleMeshes().filter((m) => !moving.has(m.userData.id)), false)[0];
  if (!hit || !hit.face) return null;
  const n = hit.face.normal.clone().applyMatrix3(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld)).normalize();
  return n.y > 0.5 && hit.point.y > 0.01 ? hit.point : null;
}

// Resizing moves in whole snap steps from the size the shape had when you grabbed it:
// with the snap grid at 1.0 mm a box grows or shrinks by exactly 1 mm at a time.
const r3 = (v) => Math.round(v * 1000) / 1000;
function stepFrom(start, raw, st = snapStep()) {
  return st ? r3(start + Math.round((raw - start) / st) * st) : Math.round(raw * 100) / 100;
}
// the smallest size reachable in steps from the starting size (never zero)
function smallestFrom(start, st = snapStep()) {
  if (!st) return 0.1;
  let m = r3(((start % st) + st) % st);
  if (m < 0.05) m = r3(m + st);
  return m;
}
function scaleFromPoint(p, uniform) {
  const { s, start, h } = drag;
  const local = p.clone().sub(new THREE.Vector3(start.x, start.y, start.z)).applyQuaternion(shapeQuat(start).invert());
  let w = start.w, d = start.d;
  const ax = (-h.sx * start.w) / 2, az = (-h.sz * start.d) / 2; // the side that stays put
  if (h.sx) w = Math.max(smallestFrom(start.w), stepFrom(start.w, h.sx * (local.x - ax)));
  if (h.sz) d = Math.max(smallestFrom(start.d), stepFrom(start.d, h.sz * (local.z - az)));
  let hgt = start.h;
  if (uniform) {
    const k = h.sx && h.sz ? Math.max(w / start.w, d / start.d) : h.sx ? w / start.w : d / start.d;
    w = r3(start.w * k); d = r3(start.d * k); hgt = r3(start.h * k);
  }
  const cx = h.sx ? ax + (h.sx * w) / 2 : 0;
  const cz = h.sz ? az + (h.sz * d) / 2 : 0;
  const o = localOffset(start, cx, 0, cz);
  Object.assign(s, { w, d, h: hgt, x: r3(start.x + o.x), y: r3(start.y + o.y), z: r3(start.z + o.z) });
}

window.addEventListener("pointermove", (e) => {
  if (!drag || drag.mode === "empty") {
    if (!drag) hoverCursor(e);
    return;
  }
  if (drag.mode === "ruler") {
    const p = planePoint(e.clientX, e.clientY, 0);
    if (p) ruler.dragTo(p.add(drag.off));
    canvas.style.cursor = "grabbing";
    return;
  }
  if (drag.mode === "move" && drag.slide) {
    if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 3) return;
    setRay(e.clientX, e.clientY);
    const hit = new THREE.Vector3();
    if (!ray.ray.intersectPlane(drag.slide.plane, hit)) return;
    const d = hit.sub(drag.slide.grab);
    if (d.length() > 2000) return; // pointer almost level with the workplane: ignore wild jumps
    // whole snap steps along the workplane's own directions
    const st = snapStep();
    if (st) {
      const n = drag.slide.plane.normal;
      const u = new THREE.Vector3(0, 1, 0).cross(n);
      if (u.lengthSq() < 1e-6) u.set(1, 0, 0);
      u.normalize();
      const v = n.clone().cross(u).normalize();
      const a = Math.round(d.dot(u) / st) * st, b = Math.round(d.dot(v) / st) * st;
      d.copy(u).multiplyScalar(a).addScaledVector(v, b);
    }
    const r2 = (x) => Math.round(x * 1000) / 1000;
    drag.group.forEach((g, i) => {
      const p0 = drag.slide.start[i];
      g.s.x = r2(p0.x + d.x); g.s.y = r2(p0.y + d.y); g.s.z = r2(p0.z + d.z);
      if (g.s !== drag.s) syncMesh(g.s);
    });
  } else if (drag.mode === "move") {
    if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 3) return;
    let p = planePoint(e.clientX, e.clientY, drag.y0 + (drag.gy || 0));
    if (!p) return;
    // a shape that sits on something rides up onto the top of whatever shape is under the pointer,
    // and back down to the workplane when dragged off (shapes floating in the air keep their height)
    let base = drag.y0;
    if (drag.resting) {
      const top = surfaceUnder(e.clientX, e.clientY, drag.group);
      if (top) { base = top.y; p = top; } else base = 0;
    }
    const lim = Math.max(planeW, planeD) / 2 + 100;
    for (const g of drag.group) {
      g.s.x = snap(THREE.MathUtils.clamp(p.x + g.ox, -lim, lim));
      g.s.z = snap(THREE.MathUtils.clamp(p.z + g.oz, -lim, lim));
      g.s.y = Math.round((base + g.dy) * 100) / 100;
      if (g.s !== drag.s) syncMesh(g.s);
    }
  } else if (drag.mode === "scale") {
    setRay(e.clientX, e.clientY);
    const p = new THREE.Vector3();
    if (!ray.ray.intersectPlane(drag.basePlane, p)) return;
    scaleFromPoint(p, e.shiftKey);
  } else if (drag.mode === "spin") {
    setRay(e.clientX, e.clientY);
    const hit = new THREE.Vector3();
    if (!ray.ray.intersectPlane(drag.spinPlane, hit)) return;
    const v = hit.sub(drag.center);
    const a1 = Math.atan2(v.dot(drag.u2), v.dot(drag.u1));
    let deg = (drag.start[drag.key] || 0) + THREE.MathUtils.radToDeg(a1 - drag.a0);
    deg = e.shiftKey ? Math.round(deg) : Math.round(deg / 15) * 15;
    drag.s[drag.key] = ((deg % 360) + 540) % 360 - 180;
  } else if (drag.mode === "rotate") {
    const p = planePoint(e.clientX, e.clientY, drag.start.y);
    if (!p) return;
    const a1 = Math.atan2(p.z - drag.start.z, p.x - drag.start.x);
    let deg = (drag.start.r || 0) - THREE.MathUtils.radToDeg(a1 - drag.a0);
    deg = e.shiftKey ? Math.round(deg) : Math.round(deg / 15) * 15;
    drag.s.r = ((deg % 360) + 540) % 360 - 180; // keep it between -180 and 180
  } else if (drag.mode === "lift") {
    setRay(e.clientX, e.clientY);
    const p = new THREE.Vector3();
    if (!ray.ray.intersectPlane(drag.plane, p)) return;
    drag.s.y = stepFrom(drag.start.y, drag.start.y + (p.y - drag.y0), snapStepUp());
  } else if (drag.mode === "height") {
    setRay(e.clientX, e.clientY);
    const p = new THREE.Vector3();
    if (!ray.ray.intersectPlane(drag.plane, p)) return;
    const { s, start } = drag;
    const hgt = Math.max(smallestFrom(start.h, snapStepUp()), stepFrom(start.h, p.sub(drag.base).dot(drag.up) - 4, snapStepUp()));
    const k = hgt / start.h;
    Object.assign(s, e.shiftKey ? { h: hgt, w: start.w * k, d: start.d * k } : { h: hgt, w: start.w, d: start.d });
  }
  drag.moved = true;
  syncMesh(drag.s);
  refresh(true);
});

window.addEventListener("pointerup", (e) => {
  if (!drag) return;
  if (drag.mode === "ruler") {
    if (canvas.hasPointerCapture && canvas.hasPointerCapture(drag.pointer)) canvas.releasePointerCapture(drag.pointer);
    ruler.endDrag();
    canvas.style.cursor = "move";
    drag = null;
    return;
  }
  if (drag.mode === "empty") {
    if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 4 && e.target === canvas) select(null);
  } else {
    if (canvas.hasPointerCapture && drag.pointer !== undefined && canvas.hasPointerCapture(drag.pointer)) canvas.releasePointerCapture(drag.pointer);
    if (drag.moved) {
      commit();
      if (drag.mode === "spin") say(`${drag.s.name} ${drag.key === "t" ? "tilted" : "rolled"} to ${Math.round(drag.s[drag.key] || 0)} degrees.`);
      else if (drag.mode === "rotate") say(`${drag.s.name} turned to ${Math.round(drag.s.r || 0)} degrees.`);
      else if (drag.mode !== "move") say(`${drag.s.name} is now ${units.num(drag.s.w)} by ${units.num(drag.s.d)} by ${units.num(drag.s.h)} ${units.name()}.`);
    }
  }
  drag = null;
});
window.addEventListener("pointercancel", () => { drag = null; });

let hoverHandle = null; // the handle under the pointer, for the size tags
function hoverCursor(e) {
  if (e.target !== canvas) { hoverHandle = null; return; }
  scene.updateMatrixWorld();
  if (aligning) {
    placeAlign();
    const dot = pickAlignDot(e.clientX, e.clientY);
    if (dot !== aligning.hover) previewAlign(dot);
    if (dot) { canvas.style.cursor = "pointer"; return; }
  }
  if (ruler.hit(e.clientX, e.clientY)) { canvas.style.cursor = "move"; hoverHandle = null; return; }
  setRay(e.clientX, e.clientY);
  const hHit = selected && handleGroup.visible ? pickHandle(e.clientX, e.clientY) : null;
  hoverHandle = hHit ? hHit.object.userData.handle : null;
  if (hHit) { const hd = hHit.object.userData.handle; canvas.style.cursor = hd.rotate || hd.spin ? "grab" : hd.cursor + "-resize"; return; }
  const over = ray.intersectObjects(visibleMeshes(), false)[0];
  canvas.style.cursor = over ? (get(over.object.userData.id)?.locked ? "not-allowed" : "move") : "";
}

// ---------- Keyboard ----------
window.addEventListener("keydown", (e) => {
  const typing = e.target instanceof Element && e.target.matches("input, select, textarea");
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "z" && !typing) { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && e.key.toLowerCase() === "y" && !typing) { e.preventDefault(); redo(); return; }
  if (typing) return;
  if (mod && e.key.toLowerCase() === "d") { e.preventDefault(); duplicateSelected(); return; }
  if (mod && e.key.toLowerCase() === "a") { e.preventDefault(); selectAll(); return; }
  if (mod && e.key.toLowerCase() === "e") { e.preventDefault(); openExport(); return; }
  if (mod && e.shiftKey && e.key.toLowerCase() === "h") { e.preventDefault(); showAll(); return; }
  if (mod && e.key.toLowerCase() === "c") { e.preventDefault(); copySelection(false); return; }
  if (mod && e.key.toLowerCase() === "x") { e.preventDefault(); copySelection(true); return; }
  if (mod && e.key.toLowerCase() === "v") { e.preventDefault(); pasteClipboard(); return; }
  if (mod && e.key.toLowerCase() === "g") { e.preventDefault(); e.shiftKey ? ungroupSelected() : groupAll(); return; }
  if (e.key === "?") { $("#help-dialog").showModal(); return; }
  if (e.key.toLowerCase() === "h" && !mod) { setView("home"); return; }
  if (e.key.toLowerCase() === "f" && !mod) { setView("fit"); return; }
  if (e.key === "1" && !mod) { setView("top"); return; }
  if (e.key === "2" && !mod) { setView("front"); return; }
  if (e.key === "3" && !mod) { setView("side"); return; }
  if (e.key.toLowerCase() === "l" && !mod) { toggleAlign(); return; }
  if (e.key.toLowerCase() === "o" && !mod) { setFlatView(!flatView); say(flatView ? "Flat view." : "3D view."); return; }
  if (e.key.toLowerCase() === "w" && !mod) { placingPlane ? stopPlaneTool() : startPlaneTool(); return; }
  if (e.key === "Escape" && placingPlane) { stopPlaneTool(); say("Workplane tool cancelled."); return; }
  if (e.key === "Escape" && ruler.placing) { ruler.stopPlacing(); say("Ruler cancelled."); return; }
  if (e.key === "Escape" && aligning) { stopAlign(); say("Align finished."); return; }
  const inView = document.activeElement === host || document.activeElement === document.body;
  if (e.key === "Tab" && inView && shapes.length) {
    e.preventDefault();
    const i = shapes.findIndex((s) => s.id === selected);
    const n = (i + (e.shiftKey ? -1 : 1) + shapes.length) % shapes.length;
    select(shapes[i < 0 ? 0 : n].id);
    return;
  }
  const s = get(selected);
  if (!s) return;
  const step = (snapStep() || 1) * (e.shiftKey ? 10 : 1);
  // Arrow keys move relative to the camera direction so "up" always means away from you
  const fwd = new THREE.Vector3();
  camera.getWorldDirection(fwd);
  fwd.y = 0; fwd.normalize();
  const ax = Math.abs(fwd.x) > Math.abs(fwd.z) ? new THREE.Vector3(Math.sign(fwd.x), 0, 0) : new THREE.Vector3(0, 0, Math.sign(fwd.z));
  const right = new THREE.Vector3(-ax.z, 0, ax.x);
  let mv = null;
  if (e.key === "ArrowUp") mv = ax.clone();
  if (e.key === "ArrowDown") mv = ax.clone().negate();
  if (e.key === "ArrowRight") mv = right.clone();
  if (e.key === "ArrowLeft") mv = right.clone().negate();
  if (mv) { e.preventDefault(); for (const o of pickedShapes().filter((x) => !x.locked)) { o.x = snap(o.x + mv.x * step); o.z = snap(o.z + mv.z * step); syncMesh(o); } refresh(true); commit(); return; }
  if (e.key.toLowerCase() === "d" && !mod) { e.preventDefault(); dropToPlane(); return; }
  if (s.locked && (e.key === "PageUp" || e.key === "PageDown" || e.key.toLowerCase() === "r")) { say(`${s.name} is locked.`); return; }
  if (e.key === "PageUp") { e.preventDefault(); setProp("y", snapUp(s.y + (snapStepUp() || 1) * (e.shiftKey ? 10 : 1))); return; }
  if (e.key === "PageDown") { e.preventDefault(); setProp("y", snapUp(s.y - (snapStepUp() || 1) * (e.shiftKey ? 10 : 1))); return; }
  if (e.key.toLowerCase() === "r") { setProp("r", (s.r + (e.shiftKey ? -15 : 15)) % 360); return; }
  if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); removeSelected(); return; }
  if (e.key === "Escape") select(null);
});

// ---------- Save, load, export ----------
// The design as it was when last saved to a file, opened, or when the app started. Choosing
// "Don't save" when closing puts the kept copy back to this, so the unsaved changes are dropped.
let cleanCopy = null;
let discarded = false; // set once "Don't save" was chosen: nothing more is kept after that
const storeText = () => JSON.stringify({ name: $("#project-name").value, snap: $("#snap").value, shapes, nextId });
function markClean() { dirty = false; cleanCopy = storeText(); }
function discardChanges() {
  discarded = true;
  if (demo) return true;
  try {
    if (cleanCopy) localStorage.setItem(STORE, cleanCopy);
    else localStorage.removeItem(STORE);
  } catch { /* storage not available */ }
  return true;
}
function save() {
  const flag = $("#st-save");
  if (flag) flag.textContent = "Saved on this computer";
  updateStatus();
  if (demo || discarded) return;
  try {
    const text = storeText();
    localStorage.setItem(STORE, text);
    keepVersion(JSON.parse(text));
  } catch { /* storage may be full or blocked */ }
}

// ---------- Earlier versions: a safety net so a design can always be brought back ----------
const HISTORY = STORE + "-history";
const readVersions = () => { try { return JSON.parse(localStorage.getItem(HISTORY) || "[]"); } catch { return []; } };
function keepVersion(data) {
  if (!data.shapes.length) return;
  const list = readVersions();
  const last = list[0];
  const now = Date.now();
  const sameShapes = last && last.count === data.shapes.length && last.name === data.name;
  // keep at most one version per minute unless the number of shapes changed
  if (last && sameShapes && now - last.time < 60000) list[0] = { time: last.time, name: data.name, count: data.shapes.length, data };
  else list.unshift({ time: now, name: data.name, count: data.shapes.length, data });
  localStorage.setItem(HISTORY, JSON.stringify(list.slice(0, 30)));
}
function showVersions() {
  const box = $("#versions-list");
  const list = readVersions();
  box.innerHTML = "";
  if (!list.length) box.innerHTML = '<p class="empty">No earlier versions yet. They are kept automatically as you work.</p>';
  list.forEach((v) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "version";
    const when = new Date(v.time).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
    b.innerHTML = `<b></b><span></span>`;
    b.querySelector("b").textContent = v.name || "Untitled design";
    b.querySelector("span").textContent = `${when} · ${v.count} shape${v.count === 1 ? "" : "s"}`;
    b.addEventListener("click", () => {
      openDesign(v.data, v.name);
      $("#versions-dialog").close();
      say(`Restored the version from ${when}. Use Undo to go back.`);
    });
    box.append(b);
  });
  $("#versions-dialog").showModal();
}
$("#versions").addEventListener("click", showVersions);

// Pictures are guides for designing: every export leaves them out
const exportable = (onlySelected) => shapes.filter((s) => !s.hidden && !isPicture(s) && (!onlySelected || picked.has(s.id)));
function exportSTL(onlySelected) {
  const shown = exportable(onlySelected);
  if (onlySelected && !shown.length) { say("Select the shapes to export first."); alert("Select the shapes you want to export first (click, or Ctrl+click for several)."); return; }
  if (!shown.some((s) => !s.hole)) { say("Add a solid shape first."); alert("Add at least one visible solid shape before exporting. Hidden shapes are left out."); return; }
  const g = sealedGeometry(combine(shown)); // seams sealed, so slicers need no repairs
  g.rotateX(Math.PI / 2); // three.js is Y-up, printers are Z-up
  const data = new STLExporter().parse(new THREE.Mesh(g), { binary: true });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([data], { type: "model/stl" }));
  a.download = ($("#project-name").value.trim() || "design").replace(/[^\w-]+/g, "_") + (onlySelected ? "-selection" : "") + ".stl";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  say(shapes.some((s) => s.hole) ? "Exported, with hole shapes cut out." : "Exported.");
}

// ---------- Export window: STL for printing, OBJ and GLB keep the colours ----------
function download(data, type, ext, onlySelected) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([data], { type }));
  a.download = ($("#project-name").value.trim() || "design").replace(/[^\w-]+/g, "_") + (onlySelected ? "-selection" : "") + "." + ext;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
// one finished part per solid shape, with the holes that touch it cut out, in its own colour
function colouredParts(shown) {
  const box = (s) => { const m = meshes.get(s.id); m.updateMatrixWorld(); return new THREE.Box3().setFromObject(m); };
  const holes = shown.filter((s) => s.hole).map((s) => ({ s, b: box(s) }));
  return shown.filter((s) => !s.hole).map((s) => {
    const b = box(s);
    const cutters = holes.filter((h) => h.b.intersectsBox(b)).map((h) => h.s);
    const multi = s.type === "group" && s.multicolor;
    let g;
    if (multi && !cutters.length) { const m = meshes.get(s.id); g = m.geometry.clone().applyMatrix4(m.matrixWorld); }
    else g = combine([s, ...cutters]);
    if (g.index) g = g.toNonIndexed();
    return { name: s.name, color: new THREE.Color(multi && g.attributes.color ? "#ffffff" : s.color), geometry: g };
  });
}
function objText(parts) {
  const lines = ["# Made with FiddleCraft. Units: millimetres. Colours are stored per vertex.", ""];
  let base = 1;
  for (const p of parts) {
    const pos = p.geometry.attributes.position, col = p.geometry.attributes.color;
    const c = new THREE.Color();
    const rgb = { r: 0, g: 0, b: 0 };
    lines.push(`o ${p.name.replace(/\s+/g, "_")}`);
    for (let i = 0; i < pos.count; i++) {
      if (col) c.setRGB(col.getX(i), col.getY(i), col.getZ(i)); else c.copy(p.color);
      c.getRGB(rgb, THREE.SRGBColorSpace); // OBJ colours are ordinary screen colours
      lines.push(`v ${+pos.getX(i).toFixed(4)} ${+pos.getY(i).toFixed(4)} ${+pos.getZ(i).toFixed(4)} ${rgb.r.toFixed(3)} ${rgb.g.toFixed(3)} ${rgb.b.toFixed(3)}`);
    }
    for (let i = 0; i < pos.count; i += 3) lines.push(`f ${base + i} ${base + i + 1} ${base + i + 2}`);
    base += pos.count;
    lines.push("");
  }
  return lines.join("\n");
}
async function exportAs(format, onlySelected) {
  if (format === "stl") return exportSTL(onlySelected);
  if (format === "svg") return exportSVG(onlySelected);
  const shown = exportable(onlySelected);
  if (onlySelected && !shown.length) { alert("Select the shapes you want to export first (click, or Ctrl+click for several)."); return; }
  if (!shown.some((s) => !s.hole)) { alert("Add at least one visible solid shape before exporting. Hidden shapes are left out."); return; }
  const parts = colouredParts(shown);
  if (format === "3mf") {
    download(await make3MF(parts, $("#project-name").value.trim() || "design"), "model/3mf", "3mf", onlySelected);
  } else if (format === "obj") {
    download(objText(parts), "model/obj", "obj", onlySelected);
  } else {
    const group = new THREE.Group();
    group.scale.setScalar(0.001); // glTF measures in metres
    parts.forEach((p) => { const m = new THREE.Mesh(p.geometry, new THREE.MeshStandardMaterial({ color: p.color, roughness: 0.6, vertexColors: !!p.geometry.attributes.color })); m.name = p.name; group.add(m); });
    const data = await new GLTFExporter().parseAsync(group, { binary: true });
    download(data, "model/gltf-binary", "glb", onlySelected);
  }
  say(`Exported ${parts.length} part${parts.length === 1 ? "" : "s"} as ${format.toUpperCase()}, with colours.`);
}
// SVG for laser cutters: the outline where the design meets the workplane, seen from the top
function exportSVG(onlySelected) {
  const shown = exportable(onlySelected);
  if (onlySelected && !shown.length) { alert("Select the shapes you want to export first (click, or Ctrl+click for several)."); return null; }
  if (!shown.some((s) => !s.hole)) { alert("Add at least one visible solid shape before exporting. Hidden shapes are left out."); return null; }
  const g = combine(shown);
  g.computeBoundingBox();
  const { min, max } = g.boundingBox;
  if (max.y <= 0.001) { alert("The design is below the workplane, so there's no outline to export. Lift it up first."); return null; }
  const floor = Math.max(min.y, 0);
  const cut = floor + Math.min(0.1, (max.y - floor) / 2);
  const loops = sliceOutlines(g, cut);
  if (!loops.length) { alert("Couldn't find an outline to export. Try moving the design onto the workplane."); return null; }
  const name = $("#project-name").value.trim() || "design";
  const text = outlinesToSVG(loops, name);
  download(text, "image/svg+xml", "svg", onlySelected);
  const where = min.y > 0.05 ? "its lowest point (it doesn't touch the workplane)" : "the workplane";
  say(`Exported ${loops.length} outline${loops.length === 1 ? "" : "s"} as SVG: the design's shape where it meets ${where}, seen from the top, in millimetres.`);
  return text;
}
function openExport() {
  const dlg = $("#export-dialog");
  const some = picked.size > 0;
  $("#export-selected").disabled = !some;
  if (!some) $("#export-all").checked = true;
  $("#export-count").textContent = some ? `(${picked.size} shape${picked.size === 1 ? "" : "s"})` : "(select shapes first)";
  dlg.showModal();
  exportThinCheck();
}
function exportThinCheck() {
  const box = $("#export-thin"), text = $("#export-thin-text"), show = $("#export-thin-show");
  const list = exportable(false);
  $("#export-pictures").hidden = !shapes.some((s) => isPicture(s) && !s.hidden);
  if (!workspace.thin || !list.some((s) => !s.hole)) { box.hidden = true; return; }
  box.hidden = false; box.className = "thincheck"; show.hidden = true;
  text.textContent = "Checking for walls too thin to print…";
  setTimeout(() => {
    const r = checkThin(list);
    const limit = units.text(workspace.thin);
    if (isWorthWarning(r)) {
      box.className = "thincheck thincheck--warn";
      text.textContent = `⚠ Some walls are thinner than ${limit}${r.thinnest ? ` (thinnest about ${units.text(r.thinnest, 2)})` : ""}. They may break or not print at all.`;
      show.hidden = false;
    } else {
      box.className = "thincheck thincheck--ok";
      text.textContent = `✓ No walls thinner than ${limit}.`;
    }
  }, 30);
}
$("#export-thin-show").addEventListener("click", () => { $("#export-dialog").close(); showThinSpots(); });
document.querySelectorAll("[data-export]").forEach((b) => b.addEventListener("click", () => {
  $("#export-dialog").close();
  exportAs(b.dataset.export, $("#export-selected").checked);
}));

// Group: join every shape into one, cutting out the holes (like gluing the pieces together)
function groupAll() {
  // with two or more shapes selected, join just those; otherwise join everything
  const list = (picked.size >= 2 ? pickedShapes() : shapes).filter((s) => !isPicture(s)); // pictures stay separate
  if (list.length < 2) { say("Add at least two shapes to group them. Pictures can't be grouped."); return; }
  const children = JSON.parse(JSON.stringify(list));
  const g = combine(children);
  if (!g) { say("A group needs at least one solid shape."); return; }
  g.computeBoundingBox();
  const b = g.boundingBox, size = new THREE.Vector3();
  b.getSize(size);
  const base = { w: size.x, h: size.y, d: size.z, x: (b.min.x + b.max.x) / 2, y: b.min.y, z: (b.min.z + b.max.z) / 2 };
  const first = children.find((s) => !s.hole);
  const count = shapes.filter((s) => s.type === "group").length + 1;
  const grp = { id: nextId++, type: "group", name: `Group ${count}`, color: first.color, hole: false, ...base, r: 0, t: 0, base, children };
  const ids = new Set(list.map((s) => s.id));
  ids.forEach((id) => { scene.remove(meshes.get(id)); meshes.delete(id); });
  shapes = shapes.filter((s) => !ids.has(s.id)).concat(grp);
  buildMesh(grp);
  select(grp.id);
  commit();
  say(`${children.length} shapes grouped into ${grp.name}.`);
}

// Ungroup: put the pieces back where they are now (following any move, resize or turn of the group)
function ungroupSelected() {
  const grp = get(selected);
  if (!grp || grp.type !== "group") { say("Pick a group to ungroup."); return; }
  const k = { x: grp.w / grp.base.w, y: grp.h / grp.base.h, z: grp.d / grp.base.d };
  const turn = THREE.MathUtils.degToRad(grp.r || 0);
  const parts = grp.children.map((c) => {
    const dx = (c.x - grp.base.x) * k.x, dz = (c.z - grp.base.z) * k.z;
    return {
      ...c, id: nextId++,
      w: c.w * k.x, h: c.h * k.y, d: c.d * k.z,
      x: grp.x + dx * Math.cos(turn) + dz * Math.sin(turn),
      z: grp.z - dx * Math.sin(turn) + dz * Math.cos(turn),
      y: grp.y + (c.y - grp.base.y) * k.y,
      r: (c.r || 0) + (grp.r || 0),
    };
  });
  scene.remove(meshes.get(grp.id));
  meshes.delete(grp.id);
  shapes = shapes.filter((s) => s.id !== grp.id).concat(parts);
  parts.forEach(buildMesh);
  select(parts[0].id);
  commit();
  say(`${grp.name} split back into ${parts.length} shapes.`);
}

function sample() {
  const parts = [
    ["box", { w: 40, d: 30, h: 20, x: -30, z: 0, color: "#e5352b" }],
    ["roof", { w: 40, d: 30, h: 16, x: -30, z: 0, y: 20, color: "#2fa24a" }],
    ["cylinder", { w: 24, d: 24, h: 30, x: 30, z: -10, color: "#f08a1c" }],
    ["sphere", { w: 22, d: 22, h: 22, x: 30, z: -10, y: 30, color: "#1f8fe5" }],
    ["star", { w: 26, d: 26, h: 6, x: 10, z: 40, color: "#ffb400" }],
  ];
  parts.forEach(([type, p]) => {
    const def = SHAPES[type];
    const s = { id: nextId++, type, name: def.label, color: def.color, hole: false, w: 20, d: 20, h: 20, x: 0, y: 0, z: 0, r: 0, t: 0, ...p };
    shapes.push(s);
    buildMesh(s);
  });
}

function load() {
  if (demo) { sample(); controls.autoRotate = true; controls.autoRotateSpeed = 1.2; return; }
  try {
    const data = JSON.parse(localStorage.getItem(STORE) || "null");
    if (data && Array.isArray(data.shapes)) {
      $("#project-name").value = data.name || "My first design";
      setSnap(Number(data.snap || 1));
      shapes = data.shapes.filter((s) => SHAPES[s.type] || s.type === "mesh" || (s.type === "group" && Array.isArray(s.children)));
      nextId = data.nextId || shapes.length + 1;
      shapes.forEach(buildMesh);
    }
  } catch { /* ignore a broken save */ }
}
// Start-up: open the last design. If it can't be opened, keep a copy and start fresh instead of breaking.
try {
  load();
  lastState = snapshot();
  refresh();
  try { cleanCopy = localStorage.getItem(STORE); } catch { cleanCopy = null; }
} catch (err) {
  console.error("FiddleCraft: the last design could not be opened", err);
  try {
    const broken = localStorage.getItem(STORE);
    if (broken) localStorage.setItem(STORE + "-broken", broken);
    localStorage.removeItem(STORE);
  } catch { /* storage not available */ }
  meshes.forEach((m) => scene.remove(m));
  meshes.clear();
  shapes = [];
  selected = null;
  picked = new Set();
  lastState = snapshot();
  try { refresh(); } catch (e2) { console.error(e2); }
  setTimeout(() => alert("FiddleCraft couldn't open your last design, so it started with an empty one. Your design isn't lost: open Earlier versions to bring it back."), 400);
}
// once the letters are ready, redraw text shapes (and groups that contain text)
fontReady.then(() => shapes.forEach((s) => syncMesh(s)));
onFontLoaded(() => { shapes.forEach((s) => syncMesh(s)); refresh(true); });

// ---------- Design files: save and open like a desktop program ----------
const validShape = (s) => SHAPES[s.type] || s.type === "mesh" || (s.type === "group" && Array.isArray(s.children));
const fileName = () => ($("#project-name").value.trim() || "design").replace(/[^\w-]+/g, "_") + ".fiddlecraft";

function openDesign(data, label) {
  if (!data || !Array.isArray(data.shapes)) throw new Error("This file isn't a FiddleCraft design.");
  if (tempPlane) { tempPlane = null; showTempPlane(); } // a fresh design starts on the main workplane
  undoStack.push(snapshot());
  redoStack.length = 0;
  // a saved file carries its imported models; keep them on this computer
  if (data.meshes) for (const [id, b64] of Object.entries(data.meshes)) { if (b64 && !meshData(id)) storeMesh(id, b64); }
  const list = data.shapes.filter(validShape);
  $("#project-name").value = data.name || (label || "My design").replace(/\.(fiddlecraft|shapeforge|json)$/i, "");
  if (data.snap) setSnap(Number(data.snap));
  selected = null;
  restore(JSON.stringify({ shapes: list, nextId: data.nextId || list.length + 1 }));
  updateButtons();
  markClean();
  say(`Opened ${$("#project-name").value}.`);
}

async function saveFile() {
  const meshes = Object.fromEntries([...meshIds(shapes)].map((id) => [id, meshData(id)]).filter(([, b]) => b));
  const body = JSON.stringify({ app: "fiddlecraft", version: 1, name: $("#project-name").value, snap: $("#snap").value, shapes, nextId, meshes });
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName: fileName(), types: [{ description: "FiddleCraft design", accept: { "application/json": [".fiddlecraft", ".json"] } }] });
      const w = await handle.createWritable();
      await w.write(body);
      await w.close();
      markClean();
      say("Design saved.");
      return true;
    } catch (e) {
      if (e.name === "AbortError") return false;
    }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([body], { type: "application/json" }));
  a.download = fileName();
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  markClean();
  say("Design saved to your downloads.");
  return true;
}

const picker = document.createElement("input");
picker.type = "file";
picker.accept = ".fiddlecraft,.shapeforge,.json,application/json"; // older .shapeforge designs open too
picker.addEventListener("change", async () => {
  const f = picker.files[0];
  picker.value = "";
  if (!f) return;
  try { openDesign(JSON.parse(await f.text()), f.name); } catch (e) { alert(e.message || "That file couldn't be opened."); }
});
const openFile = () => picker.click();

$("#save-file").addEventListener("click", saveFile);
$("#open-file").addEventListener("click", openFile);
window.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const k = e.key.toLowerCase();
  if (k === "s") { e.preventDefault(); saveFile(); }
  if (k === "o") { e.preventDefault(); openFile(); }
});

// Opening a .fiddlecraft (or older .shapeforge) file from the computer starts the installed app with it
window.addEventListener("shapeforge-open", (e) => {
  try { openDesign(JSON.parse(e.detail.text), e.detail.name); } catch (err) { alert(err.message || "That file couldn't be opened."); }
});
if ("launchQueue" in window) {
  window.launchQueue.setConsumer(async (params) => {
    const handle = params.files && params.files[0];
    if (!handle) return;
    const f = await handle.getFile();
    try { openDesign(JSON.parse(await f.text()), f.name); } catch (e) { alert(e.message); }
  });
}

// ---------- Workplane size ----------
function openWorkplane() { openWorkspace(true); }
function setWorkplane(w, d) {
  planeW = Math.min(1000, Math.max(20, Math.round(w)));
  planeD = Math.min(1000, Math.max(20, Math.round(d)));
  try { localStorage.setItem(PLANE_KEY, JSON.stringify({ w: planeW, d: planeD })); } catch { /* storage full */ }
  buildWorkplane();
  fadeWorkplane();
  updateFitWarning();
  showPlaneSize();
  window.dispatchEvent(new Event("shapeforge-workplane")); // the ruler stretches to the new edges
  say(`Workplane is now ${units.num(planeW)} by ${units.num(planeD)} ${units.name()}.`);
}
document.querySelectorAll("[data-bed]").forEach((b) => b.addEventListener("click", () => {
  const [w, d] = b.dataset.bed.split("x").map(Number);
  $("#wp-w").value = units.num(w);
  $("#wp-d").value = units.num(d);
}));
$("#wp-apply").addEventListener("click", (e) => {
  e.preventDefault();
  setWorkplane(units.read(Number($("#wp-w").value)) || 200, units.read(Number($("#wp-d").value)) || 200);
  $("#workplane-dialog").close();
});
function showPlaneSize() {
  $("#wp-current").textContent = `${units.num(planeW)} × ${units.num(planeD)} ${units.label()}`;
  if (typeof syncWorkspaceSize === "function") syncWorkspaceSize();
}
showPlaneSize();


// ---------- Workspace settings (bottom-right corner): Settings button, Snap Grid list, settings panel ----------
const WS_KEY = "shapeforge-workspace";
var workspace = { bg: "", shadows: true, grid: true, low: false, cruise: true, zoom: 1, thin: 0.8 }; // var: the workplane is first drawn before this line runs
try { Object.assign(workspace, JSON.parse(localStorage.getItem(WS_KEY) || "{}")); } catch { /* defaults */ }
const saveWorkspace = () => { try { localStorage.setItem(WS_KEY, JSON.stringify(workspace)); } catch { /* storage full */ } };
function applyWorkspace() {
  host.style.background = workspace.bg || "";
  const shadows = workspace.shadows && !workspace.low;
  renderer.shadowMap.enabled = shadows;
  shadowLight.castShadow = shadows;
  shadowCatcher.visible = shadows;
  scene.traverse((o) => { if (o.material && o.material.needsUpdate !== undefined && o.isMesh) o.material.needsUpdate = true; });
  workplane.children.forEach((c) => { if (c.userData.grid) c.visible = workspace.grid; });
  // low power also draws a little under the screen's resolution
  renderer.setPixelRatio(workspace.low ? Math.min(window.devicePixelRatio, 1) * 0.75 : Math.min(window.devicePixelRatio, 2));
  if (typeof wake === "function") wake(1000);
  controls.zoomSpeed = workspace.zoom;
  if (typeof resize === "function") resize();
}
function renderSnapList() {
  const sel = $("#snap"), list = $("#snap-list");
  const opt = sel.selectedOptions[0];
  $("#snap-current").textContent = opt ? opt.textContent : "Off";
  list.innerHTML = "";
  [...sel.options].forEach((o) => {
    const li = document.createElement("li");
    li.role = "option";
    li.tabIndex = -1;
    li.textContent = o.textContent;
    if (Number(o.value) === BRICK) {
      // say what Brick means right in the list
      const small = document.createElement("small");
      small.className = "wssnap__hint";
      small.textContent = `${units.text(BRICK)} across · ${units.text(BRICK_UP)} up`;
      li.append(small);
      li.title = BRICK_HINT;
      li.setAttribute("aria-label", `Brick: ${BRICK_HINT}`);
    }
    li.dataset.value = o.value;
    li.setAttribute("aria-selected", String(o.value === sel.value));
    li.addEventListener("click", () => { sel.value = o.value; sel.dispatchEvent(new Event("change")); renderSnapList(); closeSnapList(true); });
    list.append(li);
  });
}
function openSnapList() {
  $("#snap-list").hidden = false; $("#snap-btn").setAttribute("aria-expanded", "true");
  const cur = $("#snap-list").querySelector('[aria-selected="true"]') || $("#snap-list").firstElementChild;
  if (cur) cur.focus();
}
function closeSnapList(focusBtn) { $("#snap-list").hidden = true; $("#snap-btn").setAttribute("aria-expanded", "false"); if (focusBtn) $("#snap-btn").focus(); }
$("#snap-btn").addEventListener("click", () => ($("#snap-list").hidden ? openSnapList() : closeSnapList()));
$("#snap-list").addEventListener("keydown", (ev) => {
  const items = [...$("#snap-list").children], i = items.indexOf(document.activeElement);
  if (ev.key === "ArrowDown") { ev.preventDefault(); (items[i + 1] || items[0]).focus(); }
  else if (ev.key === "ArrowUp") { ev.preventDefault(); (items[i - 1] || items.at(-1)).focus(); }
  else if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); document.activeElement.click(); }
  else if (ev.key === "Escape") { ev.preventDefault(); closeSnapList(true); }
  ev.stopPropagation();
});
document.addEventListener("pointerdown", (ev) => {
  if (!$("#snap-list").hidden && !ev.target.closest(".wssnap__box")) closeSnapList();
  if (!$("#ws-panel").hidden && !ev.target.closest("#ws-panel") && !ev.target.closest("#ws-open") && !ev.target.closest("#app-menu")) closeWorkspace();
});
$("#snap").addEventListener("change", renderSnapList);

// the settings panel
function syncWorkspaceSize() {
  if (document.activeElement !== $("#ws-w")) $("#ws-w").value = units.num(planeW);
  if (document.activeElement !== $("#ws-d")) $("#ws-d").value = units.num(planeD);
  const key = `${Math.round(planeW)}x${Math.round(planeD)}`;
  $("#ws-preset").value = [...$("#ws-preset").options].some((o) => o.value === key) ? key : "custom";
  $("#ws-scale-opt").textContent = units.get() === "in" ? "1:1 (inches)" : "1:1 (millimetres)";
}
function openWorkspace(focusSize) {
  $("#ws-bg").value = workspace.bg || "#f4f6f9";
  $("#ws-shadows").checked = workspace.shadows; $("#ws-grid").checked = workspace.grid; $("#ws-low").checked = workspace.low;
  $("#ws-cruise").checked = workspace.cruise; $("#ws-zoom").value = workspace.zoom; $("#ws-thin").value = String(workspace.thin);
  syncWorkspaceSize();
  $("#ws-panel").hidden = false; $("#ws-open").setAttribute("aria-expanded", "true");
  (focusSize ? $("#ws-w") : $("#ws-x")).focus();
}
function closeWorkspace() { $("#ws-panel").hidden = true; $("#ws-open").setAttribute("aria-expanded", "false"); }
$("#ws-open").addEventListener("click", () => ($("#ws-panel").hidden ? openWorkspace() : closeWorkspace()));
$("#ws-x").addEventListener("click", () => { closeWorkspace(); $("#ws-open").focus(); });
$("#ws-close").addEventListener("click", () => { closeWorkspace(); $("#ws-open").focus(); });
$("#ws-panel").addEventListener("keydown", (ev) => { if (ev.key === "Escape") { closeWorkspace(); $("#ws-open").focus(); } ev.stopPropagation(); });
const wsSet = (key, value, msg) => { workspace[key] = value; saveWorkspace(); applyWorkspace(); if (msg) say(msg); };
$("#ws-bg").addEventListener("input", (ev) => wsSet("bg", ev.target.value));
$("#ws-shadows").addEventListener("change", (ev) => wsSet("shadows", ev.target.checked, ev.target.checked ? "Shadows on." : "Shadows off."));
$("#ws-grid").addEventListener("change", (ev) => wsSet("grid", ev.target.checked, ev.target.checked ? "Grid shown." : "Grid hidden."));
$("#ws-low").addEventListener("change", (ev) => wsSet("low", ev.target.checked, ev.target.checked ? "Low power mode on: simpler drawing, no shadows." : "Low power mode off."));
$("#ws-cruise").addEventListener("change", (ev) => wsSet("cruise", ev.target.checked, ev.target.checked ? "New shapes land on the shape under the pointer." : "New shapes land on the workplane."));
$("#ws-zoom").addEventListener("input", (ev) => wsSet("zoom", Number(ev.target.value)));
$("#ws-thin").addEventListener("change", (ev) => {
  const v = Number(ev.target.value);
  wsSet("thin", v, v ? `FiddleCraft will warn about walls thinner than ${units.text(v)}.` : "Thin wall warnings off.");
  thinSlow = false;
  scheduleThinCheck();
});
$("#ws-preset").addEventListener("change", (ev) => { if (ev.target.value === "custom") { $("#ws-w").focus(); return; } const [w, d] = ev.target.value.split("x").map(Number); setWorkplane(w, d); });
const wsSize = () => setWorkplane(units.read(Number($("#ws-w").value)) || planeW, units.read(Number($("#ws-d").value)) || planeD);
$("#ws-w").addEventListener("change", wsSize);
$("#ws-d").addEventListener("change", wsSize);
$("#ws-default").addEventListener("click", () => { wsSize(); try { localStorage.setItem(PLANE_KEY, JSON.stringify({ w: planeW, d: planeD })); } catch { /* storage full */ } say(`${units.num(planeW)} × ${units.num(planeD)} ${units.label()} is now the default workplane.`); });
$("#units").addEventListener("change", () => syncWorkspaceSize());
applyWorkspace();
renderSnapList();
// ---------- Hide and lock ----------
function visibleMeshes() {
  return [...meshes.entries()].filter(([id]) => !get(id)?.hidden).map(([, m]) => m);
}
function toggleFlag(s, key) {
  s[key] = !s[key];
  if (key === "hidden" && s.hidden) { picked.delete(s.id); if (selected === s.id) selected = picked.size ? [...picked][picked.size - 1] : null; }
  syncMesh(s);
  refresh();
  commit();
  const words = { hidden: ["hidden", "shown again"], locked: ["locked", "unlocked"] }[key];
  say(`${s.name} ${s[key] ? words[0] : words[1]}.`);
}
function showAll() {
  const hidden = shapes.filter((s) => s.hidden);
  if (!hidden.length) { say("No hidden shapes."); return; }
  hidden.forEach((s) => { s.hidden = false; syncMesh(s); });
  refresh();
  commit();
  say(`${hidden.length} hidden shape${hidden.length === 1 ? "" : "s"} shown again.`);
}

// ---------- Drop and align ----------
function dropToPlane() {
  const list = pickedShapes();
  if (!list.length) return;
  list.forEach((s) => { s.y = 0; syncMesh(s); });
  refresh(true);
  commit();
  say(list.length === 1 ? `${list[0].name} is back on the workplane.` : `${list.length} shapes are back on the workplane.`);
}

document.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
$("#align").addEventListener("click", toggleAlign);
$("#align-start").addEventListener("click", startAlign);
$("#align-done").addEventListener("click", () => { stopAlign(); say("Align finished."); });
canvas.addEventListener("pointerleave", () => { if (aligning && aligning.hover) clearAlignPreview(); });

// ---------- Welcome tips on first launch ----------
const WELCOMED = "shapeforge-welcomed";
function showWelcome() { $("#welcome-dialog").showModal(); }
function rememberWelcome() {
  try { if ($("#welcome-hide").checked) localStorage.setItem(WELCOMED, "1"); else localStorage.removeItem(WELCOMED); } catch { /* ignore */ }
}
$("#welcome-dialog form").addEventListener("submit", rememberWelcome);
$("#welcome-dialog").addEventListener("close", rememberWelcome);
if (!demo && !localStorage.getItem(WELCOMED)) setTimeout(showWelcome, 300);

// ---------- Desktop menu actions (File / Edit menus call these) ----------
window.shapeforgeApp = {
  newDesign: () => openDesign({ shapes: [], name: "Untitled design" }),
  open: () => openFile(),
  save: () => saveFile(),
  exportSTL: () => exportSTL(),
  exportSelected: () => exportSTL(true),
  undo: () => undo(),
  redo: () => redo(),
  duplicate: () => duplicateSelected(),
  remove: () => removeSelected(),
  group: () => groupAll(),
  ungroup: () => ungroupSelected(),
  resetView: () => setView("home"),
  view: (name) => setView(name),
  help: () => $("#help-dialog").showModal(),
  welcome: () => showWelcome(),
  versions: () => showVersions(),
  selectAll: () => selectAll(),
  // the desktop window asks these before closing
  needsSave: () => dirty && shapes.length > 0,
  saveForClose: () => saveFile(),
  discardForClose: () => discardChanges(),
  saveToLibrary: () => saveToLibrary(),
  workplane: () => openWorkplane(),
  showAll: () => showAll(),
  importSTL: () => stlPicker.click(),
  exportWindow: () => openExport(),
  exportAs: (format, onlySelected) => exportAs(format, !!onlySelected),
  cut: () => copySelection(true),
  copy: () => copySelection(false),
  paste: () => pasteClipboard(),
  drop: () => dropToPlane(),
  align: (axis, where) => alignSelection(axis, where),
  alignTool: () => toggleAlign(),
  ruler: () => ruler.startPlacing(),
  planeTool: () => startPlaneTool(),
  flatView: () => { setFlatView(!flatView); return flatView; },
};

// ---------- Render loop ----------
function resize() {
  const w = host.clientWidth, h = host.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / Math.max(h, 1);
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(host);
resize();

// View cube in the top-right corner: click a side to look from there, drag it to turn the view
const viewCube = createViewCube({
  host, camera, controls, flyTo,
  onLook: (name) => say(`Looking from the ${name}.`),
});

// Ruler: shows how far the selected shapes are from a point you choose; type a number to move them
function selectionBox() {
  const list = pickedShapes().filter((s) => meshes.has(s.id) && !s.hidden);
  if (!list.length) return null;
  const b = new THREE.Box3();
  list.forEach((s) => { const m = meshes.get(s.id); m.updateMatrixWorld(); b.union(new THREE.Box3().setFromObject(m)); });
  return b;
}
function moveSelection(axis, delta) {
  const list = pickedShapes().filter((s) => !s.locked);
  if (!list.length) { say("Locked shapes can't be moved."); return; }
  list.forEach((s) => { s[axis] = Math.round((s[axis] + delta) * 100) / 100; syncMesh(s); });
  refresh(true);
  commit();
  say(`Moved ${list.length === 1 ? list[0].name : list.length + " shapes"} ${units.text(Math.abs(delta), 3)}.`);
}
// Size tags beside the shape: click a number to type a size. The side being changed moves and
// the opposite side stays put, as when dragging the handle.
const sizeTags = createSizeTags({
  host, camera, localPoint, units,
  apply: (s, key, value, handle) => {
    if (!shapes.includes(s)) return;
    if (key === "w" && handle.sx) { const o = localOffset(s, (handle.sx * (value - s.w)) / 2, 0, 0); s.x += o.x; s.y = Math.round((s.y + o.y) * 1000) / 1000; s.z += o.z; }
    if (key === "d" && handle.sz) { const o = localOffset(s, 0, 0, (handle.sz * (value - s.d)) / 2); s.x += o.x; s.y = Math.round((s.y + o.y) * 1000) / 1000; s.z += o.z; }
    s[key] = value;
    syncMesh(s);
    refresh(true);
    commit();
  },
});
const ruler = createRuler({ scene, host, camera, planeSize: () => ({ w: planeW, d: planeD }), selectionBox, moveSelection, snap, say, units });
window.addEventListener("shapeforge-workplane", () => ruler.rebuild());
$("#ruler").addEventListener("click", () => (ruler.placing ? ruler.stopPlacing() : ruler.startPlacing()));

// ---------- Workplane tool (W): a temporary workplane on any face ----------
// Click a face of a shape and new shapes land on that face, standing at right angles to it.
// Click empty space or the main workplane to go back.
const tempGrid = new THREE.Group();
tempGrid.visible = false;
{
  const sq = new THREE.Mesh(new THREE.PlaneGeometry(80, 80).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xff9a3c, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide }));
  const grid = new THREE.GridHelper(80, 8, 0xff7a1a, 0xffb36b);
  grid.material.transparent = true;
  grid.material.opacity = 0.9;
  tempGrid.add(sq, grid);
  tempGrid.renderOrder = 3;
  scene.add(tempGrid);
}
let cameraBelow = false;
function fadeWorkplane() {
  const k = (tempPlane ? 0.35 : 1) * (cameraBelow ? 0.3 : 1);
  workplane.traverse((o) => {
    if (!o.material || !("opacity" in o.material)) return;
    if (o.userData.baseOpacity === undefined) o.userData.baseOpacity = o.material.opacity;
    o.material.transparent = k < 1;
    o.material.depthWrite = k >= 1; // see shapes through it from below
    o.material.opacity = o.userData.baseOpacity * k;
    o.material.needsUpdate = true;
  });
}
function showTempPlane() {
  tempGrid.visible = !!tempPlane;
  fadeWorkplane();
  $("#plane-tool").setAttribute("aria-pressed", String(!!tempPlane));
  if (!tempPlane) return;
  tempGrid.position.copy(tempPlane.point).addScaledVector(tempPlane.normal, 0.05);
  tempGrid.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tempPlane.normal);
}
function startPlaneTool() {
  placingPlane = true;
  host.classList.add("is-placing-plane");
  say("Click a face of a shape to put a workplane on it, or click empty space for the main workplane. Esc cancels.");
}
function stopPlaneTool() { placingPlane = false; host.classList.remove("is-placing-plane"); }
// the face under a point on screen: where it is and which way it faces (in the world)
function faceAt(cx, cy) {
  scene.updateMatrixWorld();
  setRay(cx, cy);
  const hit = ray.intersectObjects(visibleMeshes(), false)[0];
  if (!hit || !hit.face) return null;
  const normal = hit.face.normal.clone().applyMatrix3(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld)).normalize();
  return { point: hit.point.clone(), normal, id: hit.object.userData.id };
}
function placePlaneAt(cx, cy) {
  stopPlaneTool();
  const f = faceAt(cx, cy);
  tempPlane = f ? { point: f.point, normal: f.normal } : null;
  showTempPlane();
  say(f ? `Workplane put on ${get(f.id).name}. New shapes land there; press W and click empty space to go back.` : "Back on the main workplane.");
}
// position and angles that stand a new shape on a face
function standOn(point, normal) {
  const n = normal.clone().normalize();
  const flat = n.y > 0.999;
  return {
    x: flat ? snap(point.x) : Math.round(point.x * 100) / 100,
    y: Math.round(point.y * 100) / 100,
    z: flat ? snap(point.z) : Math.round(point.z * 100) / 100,
    t: Math.round(THREE.MathUtils.radToDeg(Math.atan2(n.z, n.y)) * 100) / 100,
    l: Math.round(THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(-n.x, -1, 1))) * 100) / 100,
  };
}
// whether a shape stands on the temporary workplane: its base on the plane, and upright to it
function standsOnTempPlane(s) {
  const m = meshes.get(s.id);
  if (!m || !tempPlane) return false;
  m.updateMatrixWorld();
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(m.quaternion);
  const off = new THREE.Vector3(s.x, s.y, s.z).sub(tempPlane.point).dot(tempPlane.normal);
  return Math.abs(off) < 0.05 && up.dot(tempPlane.normal) > 0.999;
}
// where a dropped or clicked shape goes when a temporary workplane is in use
function onTempPlane(cx, cy) {
  if (!tempPlane) return null;
  let p = tempPlane.point.clone();
  if (cx !== undefined) {
    setRay(cx, cy);
    const hit = new THREE.Vector3();
    if (ray.ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(tempPlane.normal, tempPlane.point), hit)) p = hit;
  }
  return standOn(p, tempPlane.normal);
}
$("#plane-tool").addEventListener("click", () => (placingPlane ? stopPlaneTool() : startPlaneTool()));


const dims = $("#dims");
const extraBoxes = [];
function showExtraBoxes() {
  const many = picked.size > 1;
  meshes.forEach((m, id) => {
    if (m.material !== holeMat && m.material.emissive) m.material.emissive.setHex(many && picked.has(id) ? 0x1d4ed8 : 0x000000);
  });
  const others = [...picked].filter((id) => id !== selected && meshes.has(id));
  while (extraBoxes.length < others.length) {
    const h = new THREE.Box3Helper(new THREE.Box3(), 0x0175da);
    scene.add(h);
    extraBoxes.push(h);
  }
  extraBoxes.forEach((h, i) => {
    h.visible = i < others.length;
    if (h.visible) h.box.setFromObject(meshes.get(others[i]));
  });
}
const v = new THREE.Vector3();
// Low power mode: only draw when something has changed (input, camera movement, an animation),
// then rest. Counted so the saving can be checked.
var wakeUntil = 0; // var and a function declaration: refresh() can call wake() during start-up, before this line runs
const frameStats = { drawn: 0, rested: 0 };
function wake(ms = 700) { wakeUntil = Math.max(wakeUntil || 0, performance.now() + ms); }
["pointerdown", "pointermove", "pointerup", "wheel", "keydown", "keyup", "input", "change", "click", "drop", "dragover", "resize", "focus"]
  .forEach((type) => window.addEventListener(type, () => wake(), { capture: true, passive: true }));
controls.addEventListener("change", () => wake());
onFontLoaded(() => wake(1500));
renderer.setAnimationLoop(() => {
  stepFlight();
  const moving = controls.update();
  if (workspace.low && !moving && !flight && !drag && performance.now() > wakeUntil) { frameStats.rested++; return; }
  frameStats.drawn++;
  placeHandles();
  placeAlign();
  const s = get(selected);
  if (s) {
    box.setFromObject(meshes.get(s.id));
    selBox.visible = true;
    showExtraBoxes();
    v.set((box.min.x + box.max.x) / 2, box.max.y, (box.min.z + box.max.z) / 2).project(camera);
    dims.hidden = false;
    dims.style.left = ((v.x + 1) / 2) * host.clientWidth + "px";
    dims.style.top = ((1 - v.y) / 2) * host.clientHeight - 8 + "px";
    const sizing = drag && drag.h && ["scale", "height", "lift"].includes(drag.mode) ? drag.h : null;
    const tagsOn = sizeTags.update(s, handleGroup.visible, sizing || (drag ? null : hoverHandle), HANDLES.filter((h) => !h.sx && !h.sz || h.rotate || h.spin).map((h) => h.mesh.position));
    if (tagsOn) dims.hidden = true;
    dims.textContent = drag && drag.mode === "spin" ? (drag.key === "t" ? `Tilted ${Math.round(s.t || 0)}°` : `Rolled ${Math.round(s.l || 0)}°`) : drag && drag.mode === "rotate" ? `Turned ${Math.round(s.r || 0)}°` : `${units.num(s.w)} × ${units.num(s.d)} × ${units.num(s.h)} ${units.label()}`;
  } else {
    selBox.visible = false;
    showExtraBoxes();
    dims.hidden = true;
    sizeTags.update(null, false, null, []);
  }
  ruler.update();
  const below = camera.position.y < -0.5;
  if (below !== cameraBelow) { cameraBelow = below; fadeWorkplane(); }
  renderer.render(scene, camera);
  viewCube.render();
});

// Read-only hook for automated tests
window.__shapeforge = { kits: KITS, SHAPES, catalog: () => CATALOG_BY_KEY, combine, shapeGeometry, frameStats, scene, renderer, sizeTags, standsOnTempPlane: (id) => standsOnTempPlane(get(id)), flatView: () => flatView, camera, controls, viewCube, ruler, tempPlane: () => tempPlane, placingPlane: () => placingPlane, canvas, handles: HANDLES, placeHandles, alignDots: ALIGN_DOTS, placeAlign, aligning: () => aligning, shapes: () => shapes, selected: () => selected, picked: () => [...picked], drag: () => drag && { mode: drag.mode, sx: drag.h && drag.h.sx, sz: drag.h && drag.h.sz } };
