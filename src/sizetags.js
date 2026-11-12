// Size tags: point at a resize handle and the shape's sizes appear next to it.
// Click a number to type a new size; Enter or Tab applies it, Esc puts it back.
import * as THREE from "three";

const WORDS = { w: "Width", d: "Depth", h: "Height", y: "Height above the workplane" };
const LIMITS = { w: [0.5, 400], d: [0.5, 400], h: [0.5, 400], y: [-400, 400] };
const ORDER = ["w", "d", "h", "y"];
const HOLD_MS = 1500; // the tags stay this long after the pointer leaves a handle, so they can be reached

export function createSizeTags({ host, camera, localPoint, apply, units }) {
  const layer = document.createElement("div");
  layer.className = "sizetag-layer";
  layer.hidden = true;
  host.append(layer);

  let shape = null; // the shape the tags belong to
  let focus = null; // the handle they were opened from: { sx, sz, top, lift }
  let holdUntil = 0;
  let over = false; // pointer is over a tag
  let editing = null; // key being typed
  const tags = {};

  for (const key of ORDER) {
    const el = document.createElement("div");
    el.className = "sizetag";
    el.hidden = true;
    const btn = document.createElement("button");
    btn.type = "button";
    const input = document.createElement("input");
    input.type = "number";
    input.step = "any";
    input.hidden = true;
    el.append(btn, input);
    layer.append(el);
    tags[key] = { el, btn, input, shown: false };
    btn.addEventListener("click", () => startEdit(key));
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); finish(key, true); }
      else if (e.key === "Escape") { e.preventDefault(); finish(key, false); }
      else if (e.key === "Tab") {
        e.preventDefault();
        const list = ORDER.filter((k) => tags[k].shown);
        const next = list[(list.indexOf(key) + (e.shiftKey ? list.length - 1 : 1)) % list.length];
        finish(key, true);
        if (next && next !== key) startEdit(next);
      }
    });
    input.addEventListener("blur", () => { if (editing === key) finish(key, true); });
  }
  layer.addEventListener("pointerenter", () => { over = true; });
  layer.addEventListener("pointerleave", () => { over = false; holdUntil = performance.now() + HOLD_MS; });
  // the tags sit over the 3D view: keep their clicks away from it
  layer.addEventListener("pointerdown", (e) => e.stopPropagation());

  const fmt = (v) => units.num(+v);

  function startEdit(key) {
    if (!shape) return;
    const t = tags[key];
    editing = key;
    t.btn.hidden = true;
    t.input.hidden = false;
    t.input.value = fmt(shape[key]);
    t.input.setAttribute("aria-label", `${WORDS[key]} in ${units.name()}`);
    t.input.focus();
    t.input.select();
  }
  function finish(key, keep) {
    const t = tags[key];
    if (editing !== key) return;
    editing = null;
    const v = units.read(Number(t.input.value));
    t.input.hidden = true;
    t.btn.hidden = false;
    holdUntil = performance.now() + HOLD_MS;
    if (!keep || !shape || t.input.value.trim() === "" || !Number.isFinite(v)) return;
    const [lo, hi] = LIMITS[key];
    const val = Math.round(Math.min(hi, Math.max(lo, v)) * 100) / 100;
    if (val !== shape[key]) apply(shape, key, val, focus || {});
  }

  const tmp = new THREE.Vector3();
  function screen(x, y, z) {
    tmp.set(x, y, z).project(camera);
    return { x: ((tmp.x + 1) / 2) * host.clientWidth, y: ((1 - tmp.y) / 2) * host.clientHeight, behind: tmp.z > 1 };
  }
  // put a tag `gap` pixels out from point m, away from point c, and clear of the handles
  function outward(m, c, gap, avoid) {
    let dx = m.x - c.x, dy = m.y - c.y;
    const len = Math.hypot(dx, dy);
    if (len < 1) { dx = 0; dy = 1; } else { dx /= len; dy /= len; }
    let p = { x: m.x + dx * gap, y: m.y + dy * gap };
    for (let i = 0; i < 3; i++) {
      const hit = avoid.find((a) => Math.hypot(a.x - p.x, a.y - p.y) < 26);
      if (!hit) break;
      p = { x: p.x + dx * 24, y: p.y + dy * 24 };
    }
    return p;
  }

  /**
   * Called every frame. s: the selected shape (or null); allowed: whether its handles are showing;
   * active: the handle under the pointer or being dragged (or null); avoid: handle points in the world.
   */
  function update(s, allowed, active, avoid) {
    const now = performance.now();
    if (!s || !allowed || (shape && s.id !== shape.id)) {
      if (editing) finish(editing, true); // a size being typed still goes to the shape it was typed for
      focus = null;
      holdUntil = 0;
    }
    shape = s;
    if (active && (active.top || active.lift || active.sx || active.sz)) { focus = active; holdUntil = now + HOLD_MS; }
    const visible = !!(s && allowed && focus && (active || editing || over || now < holdUntil));
    layer.hidden = !visible;
    if (!visible) { if (!editing) focus = null; ORDER.forEach((k) => { tags[k].shown = false; }); return false; }

    const want = focus.top ? ["h"] : focus.lift ? ["y"] : ["w", "d"];
    const avoidPx = avoid.map((p) => screen(p.x, p.y, p.z));
    const centre = screen(s.x, s.y, s.z);
    const sx = focus.sx || 0, sz = focus.sz || 0;
    const place = {
      w: () => { const o = localPoint(s, (sx * s.w) / 4, 0, (sz || 1) * (s.d / 2)); return outward(screen(o.x, o.y, o.z), centre, 30, avoidPx); },
      d: () => { const o = localPoint(s, (sx || 1) * (s.w / 2), 0, (sz * s.d) / 4); return outward(screen(o.x, o.y, o.z), centre, 30, avoidPx); },
      h: () => { const o = localPoint(s, 0, s.h + 4, 0); const p = screen(o.x, o.y, o.z); return { x: p.x + 44, y: p.y }; },
      y: () => { const o = localPoint(s, 0, s.h, 0); const p = screen(o.x, o.y + 14, o.z); return { x: p.x + 44, y: p.y }; },
    };
    for (const key of ORDER) {
      const t = tags[key];
      const on = want.includes(key) || editing === key;
      t.shown = on;
      t.el.hidden = !on;
      if (!on) continue;
      const p = place[key]();
      t.el.style.left = Math.round(p.x) + "px";
      t.el.style.top = Math.round(p.y) + "px";
      if (editing !== key) {
        const text = fmt(s[key] || 0);
        if (t.btn.textContent !== text) t.btn.textContent = text;
        t.btn.title = `${WORDS[key]}: ${text} ${units.label()}. Click to type a new size.`;
        t.btn.setAttribute("aria-label", t.btn.title);
      }
    }
    return true;
  }

  return { update, layer, editing: () => editing, startEdit };
}
