// Button pictures drawn from the shapes themselves: each part is rendered once, small, from the
// same angle as the home view, when its button first scrolls into sight.
import * as THREE from "three";

export function createThumbs({ shapeGeometry, combineColoured }) {
  const SIZE = 112;
  let renderer = null, scene, camera;
  const cache = new Map();
  const queue = [];
  let busy = false;

  function setup() {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.setSize(SIZE, SIZE);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8a94a6, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(2, 4, 3);
    scene.add(sun);
    camera = new THREE.PerspectiveCamera(28, 1, 0.1, 10000);
  }

  // i: the part's place in the list. Each part is drawn a hair in front of the one before, so where
  // parts overlap at exactly the same height their faces don't flicker into rings and stripes.
  function meshFor(s, i = 0) {
    const m = new THREE.Mesh(shapeGeometry(s), new THREE.MeshStandardMaterial({ color: s.color || "#9aa0a8", roughness: 0.55, metalness: 0.05, transparent: !!s.clear, opacity: s.clear ? 0.6 : 1,
      polygonOffset: i > 0, polygonOffsetFactor: -0.4 * i, polygonOffsetUnits: -2 * i }));
    m.scale.set(s.w, s.h, s.d);
    m.position.set(s.x || 0, s.y || 0, s.z || 0);
    m.rotation.set(THREE.MathUtils.degToRad(s.t || 0), THREE.MathUtils.degToRad(s.r || 0), THREE.MathUtils.degToRad(s.l || 0), "YXZ");
    return m;
  }

  // parts: shapes in millimetres (holes are left out of the little picture)
  function draw(parts) {
    if (!renderer) setup();
    const group = new THREE.Group();
    // with holes, cut them for real so faces, windows and slots show in the picture
    let cut = null;
    if (combineColoured && parts.some((p) => p.hole) && parts.some((p) => !p.hole)) {
      try { cut = combineColoured(parts.map((p) => ({ x: 0, y: 0, z: 0, r: 0, t: 0, l: 0, ...p }))); } catch { cut = null; }
      if (cut && !cut.attributes.position.count) cut = null;
    }
    if (cut) group.add(new THREE.Mesh(cut, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.05 })));
    else if (parts.some((p) => !p.hole)) parts.filter((p) => !p.hole).forEach((p, i) => group.add(meshFor(p, i)));
    else parts.forEach((p, i) => group.add(meshFor({ ...p, color: "#9aa0a8" }, i))); // only holes: show them in grey
    scene.add(group);
    group.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(group);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const dir = new THREE.Vector3(1, 0.8, 1.25).normalize();
    const dist = sphere.radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.02;
    camera.position.copy(sphere.center).addScaledVector(dir, dist);
    camera.near = dist / 100; camera.far = dist * 4;
    camera.updateProjectionMatrix();
    camera.lookAt(sphere.center);
    renderer.render(scene, camera);
    const url = renderer.domElement.toDataURL("image/png");
    scene.remove(group);
    group.traverse((o) => { if (o.material) o.material.dispose(); });
    return url;
  }

  function pump() {
    if (busy || !queue.length) return;
    busy = true;
    const { key, parts, img } = queue.shift();
    try {
      if (!cache.has(key)) cache.set(key, draw(parts()));
      img.src = cache.get(key);
    } catch (e) { console.warn("FiddleCraft: couldn't draw a shape picture", e); }
    busy = false;
    setTimeout(pump, 0);
  }

  const watcher = typeof IntersectionObserver === "function" ? new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      watcher.unobserve(en.target);
      const job = en.target._thumbJob;
      if (job) { queue.push(job); pump(); }
    }
  }, { rootMargin: "200px" }) : null;

  // give an <img> its picture when it first comes into view
  function attach(img, key, parts) {
    if (cache.has(key)) { img.src = cache.get(key); return; }
    img._thumbJob = { key, parts, img };
    if (watcher) watcher.observe(img);
    else { queue.push(img._thumbJob); pump(); }
  }
  return { attach, draw };
}
