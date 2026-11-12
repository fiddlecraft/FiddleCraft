// Ruler: put it down on the workplane, then pick a shape to see (and type) how far it is from the ruler.
import * as THREE from "three";

const STORE = "shapeforge-ruler";

export function createRuler({ scene, host, camera, planeSize, selectionBox, moveSelection, snap, say, units }) {
  let origin = null; // THREE.Vector3 on the workplane, or null when there's no ruler
  try { const o = JSON.parse(localStorage.getItem(STORE) || "null"); if (o && isFinite(o.x) && isFinite(o.z)) origin = new THREE.Vector3(o.x, 0, o.z); } catch { /* none */ }
  let placing = false;

  const group = new THREE.Group();
  group.renderOrder = 9;
  scene.add(group);
  const axisMat = new THREE.LineBasicMaterial({ color: 0x1d2433, depthTest: false });
  const tickMat = new THREE.LineBasicMaterial({ color: 0x1d2433, depthTest: false, transparent: true, opacity: 0.7 });
  const measureMat = new THREE.LineBasicMaterial({ color: 0xff7a1a, depthTest: false });
  const guideMat = new THREE.LineDashedMaterial({ color: 0xff7a1a, dashSize: 2, gapSize: 1.5, depthTest: false });
  let axes = null, ticks = null;
  let lenX = 0, lenZ = 0; // how far the ruler's arms reach, in millimetres
  const measure = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(12), 3)), measureMat);
  const guides = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(18), 3)), guideMat);
  [measure, guides].forEach((l) => { l.frustumCulled = false; l.renderOrder = 10; scene.add(l); });
  const marker = new THREE.Mesh(new THREE.CircleGeometry(2.2, 24).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xff7a1a, depthTest: false }));
  marker.renderOrder = 10;
  group.add(marker);

  // HTML labels: numbers along the ruler, and the distances you can type into
  const layer = document.createElement("div");
  layer.className = "ruler-layer";
  host.append(layer);
  const tickLabels = [];
  const field = (key, title) => {
    const wrap = document.createElement("label");
    wrap.className = "ruler-field";
    wrap.title = title;
    const input = document.createElement("input");
    input.type = "number";
    input.step = "any";
    input.setAttribute("aria-label", title);
    wrap.append(input);
    layer.append(wrap);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === "Escape") input.blur(); e.stopPropagation(); });
    input.addEventListener("change", () => {
      const v = units.read(parseFloat(input.value));
      const b = selectionBox();
      if (!isFinite(v) || !b || !origin) return;
      const now = key === "x" ? b.min.x - origin.x : key === "z" ? origin.z - b.max.z : b.min.y;
      const delta = v - now;
      if (Math.abs(delta) < 1e-6) return;
      moveSelection(key === "x" ? "x" : key === "z" ? "z" : "y", key === "z" ? -delta : delta);
    });
    return { wrap, input };
  };
  const fx = field("x", "Distance from the ruler, left to right");
  const fz = field("z", "Distance from the ruler, front to back");
  const fy = field("y", "Height above the workplane");
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "ruler-remove";
  remove.title = "Take the ruler away";
  remove.setAttribute("aria-label", "Take the ruler away");
  remove.textContent = "×";
  remove.addEventListener("click", () => { setOrigin(null); say("Ruler taken away."); });
  layer.append(remove);

  function line(points, mat) {
    const g = new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
    const l = new THREE.LineSegments(g, mat);
    l.renderOrder = 9;
    l.frustumCulled = false;
    return l;
  }
  function build() {
    if (axes) { group.remove(axes, ticks); axes.geometry.dispose(); ticks.geometry.dispose(); }
    tickLabels.forEach((t) => t.el.remove());
    tickLabels.length = 0;
    if (!origin) return;
    const { w, d } = planeSize();
    // the ruler runs right and away from you, to the edge of the workplane
    const lx = Math.max(40, Math.round(w / 2 - origin.x)), lz = Math.max(40, Math.round(origin.z + d / 2));
    lenX = lx; lenZ = lz;
    axes = line([0, 0, 0, lx, 0, 0, 0, 0, 0, 0, 0, -lz], axisMat);
    const t = [];
    // millimetres: a tick every 5 mm, longer every 10; inches: every quarter inch, longer every inch
    const inch = units.get() === "in";
    const step = inch ? 25.4 / 4 : 5, every = inch ? 4 : 2;
    for (let n = 1; n * step <= lx; n++) { const i = n * step, k = n % every ? 1.5 : 3; t.push(i, 0, 0, i, 0, k); }
    for (let n = 1; n * step <= lz; n++) { const i = n * step, k = n % every ? 1.5 : 3; t.push(0, 0, -i, -k, 0, -i); }
    ticks = line(t, tickMat);
    group.add(axes, ticks);
    const label = (text, pos) => { const el = document.createElement("span"); el.className = "ruler-tick"; el.textContent = text; layer.prepend(el); tickLabels.push({ el, pos }); };
    const gap = inch ? 25.4 : 20;
    for (let n = 1; n * gap <= lx; n++) label(units.num(n * gap), new THREE.Vector3(n * gap, 0, 7));
    for (let n = 1; n * gap <= lz; n++) label(units.num(n * gap), new THREE.Vector3(-7, 0, -n * gap));
  }
  function setOrigin(p) {
    origin = p ? new THREE.Vector3(snap(p.x), 0, snap(p.z)) : null;
    if (origin) localStorage.setItem(STORE, JSON.stringify({ x: origin.x, z: origin.z }));
    else localStorage.removeItem(STORE);
    build();
  }
  build();

  function startPlacing() {
    placing = true;
    host.classList.add("is-placing-ruler");
    say("Click on the workplane where the ruler should start. Esc cancels.");
  }
  function stopPlacing() { placing = false; host.classList.remove("is-placing-ruler"); }
  // called by the editor's pointer handler; returns true when the click was used
  function pointerDown(point) {
    if (!placing) return false;
    stopPlacing();
    if (point) { setOrigin(point); say("Ruler placed. Pick a shape to see how far it is from the ruler; type a number to move it."); }
    return true;
  }

  const v = new THREE.Vector3();
  function toScreen(p, el) {
    v.copy(p).project(camera);
    const off = v.z > 1 || Math.abs(v.x) > 1.05 || Math.abs(v.y) > 1.05;
    el.hidden = off;
    if (off) return;
    el.style.left = ((v.x + 1) / 2) * host.clientWidth + "px";
    el.style.top = ((1 - v.y) / 2) * host.clientHeight + "px";
  }
  function setField(f, value, pos) {
    toScreen(pos, f.wrap);
    if (document.activeElement !== f.input) f.input.value = units.num(value);
    f.input.title = `${f.input.getAttribute("aria-label")} (${units.label()})`;
  }
  function update() {
    group.visible = !!origin;
    layer.hidden = !origin;
    measure.visible = guides.visible = false;
    if (!origin) return;
    group.position.copy(origin);
    tickLabels.forEach((t) => toScreen(v.copy(t.pos).add(origin).clone(), t.el));
    toScreen(origin.clone().add(new THREE.Vector3(-6, 0, 6)), remove);
    const b = selectionBox();
    const show = !!b && !b.isEmpty();
    [fx, fz, fy].forEach((f) => { f.wrap.hidden = !show; });
    if (!show) return;
    // orange lines along the ruler up to the shape, dashed lines from there to its corner
    const cx = b.min.x, cz = b.max.z, y = 0;
    const m = measure.geometry.attributes.position;
    m.setXYZ(0, origin.x, y, origin.z); m.setXYZ(1, cx, y, origin.z);
    m.setXYZ(2, origin.x, y, origin.z); m.setXYZ(3, origin.x, y, cz);
    m.needsUpdate = true;
    const g = guides.geometry.attributes.position;
    g.setXYZ(0, cx, y, origin.z); g.setXYZ(1, cx, y, cz);
    g.setXYZ(2, origin.x, y, cz); g.setXYZ(3, cx, y, cz);
    g.setXYZ(4, cx, 0, cz); g.setXYZ(5, cx, b.min.y, cz);
    g.needsUpdate = true;
    guides.computeLineDistances();
    measure.visible = guides.visible = true;
    setField(fx, cx - origin.x, new THREE.Vector3((origin.x + cx) / 2, 0, origin.z));
    setField(fz, origin.z - cz, new THREE.Vector3(origin.x, 0, (origin.z + cz) / 2));
    fy.wrap.hidden = false;
    setField(fy, b.min.y, new THREE.Vector3(cx, b.min.y / 2, cz));
    if (b.min.y < 0.01 && document.activeElement !== fy.input) fy.wrap.hidden = true; // nothing to show while it sits on the workplane
  }
  // Is the pointer on the ruler (its orange corner or either arm)? Used to pick it up and drag it.
  const sv = new THREE.Vector3();
  function screenOf(p) { sv.copy(p).project(camera); const rc = host.getBoundingClientRect(); return { x: rc.left + ((sv.x + 1) / 2) * rc.width, y: rc.top + ((1 - sv.y) / 2) * rc.height, behind: sv.z > 1 }; }
  function nearSegment(px, py, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / len2));
    return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
  }
  function hit(cx, cy) {
    if (!origin || placing) return false;
    const o = screenOf(origin);
    if (o.behind) return false;
    if (Math.hypot(cx - o.x, cy - o.y) < 14) return true;
    const ax = screenOf(origin.clone().add(new THREE.Vector3(lenX, 0, 0))), az = screenOf(origin.clone().add(new THREE.Vector3(0, 0, -lenZ)));
    return nearSegment(cx, cy, o, ax) < 7 || nearSegment(cx, cy, o, az) < 7;
  }
  // while dragging, move the ruler without saving; save (and redraw its arms to the workplane edges) at the end
  function dragTo(p) { if (origin && p) { origin.set(snap(p.x), 0, snap(p.z)); } }
  function endDrag() { if (origin) { setOrigin(origin.clone()); say("Ruler moved."); } }
  units.onChange(build);
  return {
    hit, dragTo, endDrag,
    update, startPlacing, stopPlacing, pointerDown, rebuild: build,
    get placing() { return placing; },
    get origin() { return origin; },
    remove: () => setOrigin(null),
    fields: { x: fx.input, z: fz.input, y: fy.input },
  };
}
