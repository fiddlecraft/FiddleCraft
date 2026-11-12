// View cube: a small labelled cube in the corner that turns with the camera.
// Click a face, edge or corner to look from that side; drag it to turn the view.
import * as THREE from "three";

const FACES = [
  ["Right", "x", 1], ["Left", "x", -1], ["Top", "y", 1], ["Bottom", "y", -1], ["Front", "z", 1], ["Back", "z", -1],
]; // same order as BoxGeometry's material groups
const RIM = 0.2; // how much of each side counts as an edge or corner

function faceTexture(label) {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  g.fillStyle = "#f4f6fa";
  g.fillRect(0, 0, 128, 128);
  g.strokeStyle = "#9aa3b2";
  g.lineWidth = 4;
  g.strokeRect(2, 2, 124, 124);
  g.fillStyle = "#1d2433";
  g.font = "600 27px 'IBM Plex Sans', system-ui, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(label.toUpperCase(), 64, 66);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export function createViewCube({ host, camera, controls, flyTo, onLook }) {
  const size = 96;
  const canvas = document.createElement("canvas");
  canvas.className = "viewcube";
  canvas.title = "Click a side to look from there, or drag to turn the view";
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "View cube");
  host.append(canvas);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(size, size, false);

  const scene = new THREE.Scene();
  const cam = new THREE.OrthographicCamera(-0.95, 0.95, 0.95, -0.95, 0.1, 10);
  const mats = FACES.map(([label]) => new THREE.MeshBasicMaterial({ map: faceTexture(label) }));
  const cube = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mats);
  scene.add(cube);
  cube.add(new THREE.LineSegments(new THREE.EdgesGeometry(cube.geometry), new THREE.LineBasicMaterial({ color: 0x6b7385 })));
  // the part under the pointer lights up blue
  const glow = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0x0175da, transparent: true, opacity: 0.45, depthTest: false }));
  glow.renderOrder = 2;
  glow.visible = false;
  scene.add(glow);
  // redraw the labels once the app's font has loaded
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { mats.forEach((m, i) => { m.map.dispose(); m.map = faceTexture(FACES[i][0]); m.needsUpdate = true; }); });

  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  // which face, edge or corner is under a point on the cube canvas: a direction like (1, 1, 0)
  function zoneAt(cx, cy) {
    const r = canvas.getBoundingClientRect();
    ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, cam);
    const hit = ray.intersectObject(cube, false)[0];
    if (!hit) return null;
    const p = hit.point;
    const s = (v) => (v > 0.5 - RIM ? 1 : v < -0.5 + RIM ? -1 : 0);
    return new THREE.Vector3(s(p.x), s(p.y), s(p.z));
  }
  function nameOf(z) {
    const parts = [];
    if (z.y) parts.push(z.y > 0 ? "top" : "bottom");
    if (z.z) parts.push(z.z > 0 ? "front" : "back");
    if (z.x) parts.push(z.x > 0 ? "right" : "left");
    return parts.join(" ");
  }
  function showGlow(z) {
    glow.visible = !!z;
    if (!z) return;
    const ext = (v) => (v ? RIM : 1 - 2 * RIM);
    const at = (v) => (v ? v * (0.5 - RIM / 2) : 0);
    glow.scale.set(ext(z.x) * 1.02, ext(z.y) * 1.02, ext(z.z) * 1.02);
    glow.position.set(at(z.x) * 1.01, at(z.y) * 1.01, at(z.z) * 1.01);
  }
  function lookFrom(z) {
    const dir = z.clone();
    if (!dir.lengthSq()) return false;
    if (!dir.x && !dir.z) dir.z = 0.0001; // straight up or down
    const target = controls.target.clone();
    const dist = Math.max(80 * (40 / camera.fov > 2 ? 25 : 1), camera.position.distanceTo(target));
    flyTo(target.clone().add(dir.normalize().multiplyScalar(dist)), target);
    if (onLook) onLook(nameOf(z));
    return true;
  }

  let press = null;
  canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    press = { x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY, moved: false, id: e.pointerId };
    try { canvas.setPointerCapture(e.pointerId); } catch { /* not a real pointer */ }
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!press) { const z = zoneAt(e.clientX, e.clientY); showGlow(z); canvas.style.cursor = z ? "pointer" : "grab"; return; }
    if (!press.moved && Math.hypot(e.clientX - press.x, e.clientY - press.y) < 3) return;
    press.moved = true;
    showGlow(null);
    canvas.style.cursor = "grabbing";
    // turn the camera around what it looks at
    const off = camera.position.clone().sub(controls.target);
    const sph = new THREE.Spherical().setFromVector3(off);
    sph.theta -= (e.clientX - press.lastX) * 0.012;
    sph.phi = THREE.MathUtils.clamp(sph.phi - (e.clientY - press.lastY) * 0.012, 0.01, controls.maxPolarAngle);
    camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(sph));
    camera.lookAt(controls.target);
    press.lastX = e.clientX;
    press.lastY = e.clientY;
  });
  const end = (e) => {
    if (!press) return;
    const p = press;
    press = null;
    try { canvas.releasePointerCapture(p.id); } catch { /* already released */ }
    canvas.style.cursor = "pointer";
    if (!p.moved && e.type === "pointerup") { const z = zoneAt(e.clientX, e.clientY); if (z) lookFrom(z); }
  };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
  canvas.addEventListener("pointerleave", () => { if (!press) showGlow(null); });

  const dir = new THREE.Vector3();
  function render() {
    dir.copy(camera.position).sub(controls.target).normalize().multiplyScalar(4);
    cam.position.copy(dir);
    cam.up.copy(camera.up);
    cam.lookAt(0, 0, 0);
    renderer.render(scene, cam);
  }
  return { canvas, render, zoneAt, lookFrom };
}
