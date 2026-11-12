import * as THREE from "three";
import { parse } from "opentype.js";
import { normalize } from "./shapes.js";

// Text shapes: letters from free fonts (all under the SIL Open Font License), extruded into 3D.
export const FONTS = {
  sans: { label: "Sans", file: "fonts/plex-700.woff" },        // IBM Plex Sans Bold
  serif: { label: "Serif", file: "fonts/serif-700.woff" },     // Zilla Slab Bold
  mono: { label: "Typewriter", file: "fonts/mono-700.woff" },  // IBM Plex Mono Bold
  script: { label: "Handwriting", file: "fonts/script-400.woff" }, // Pacifico
};

const fonts = {};
const loading = {};
const listeners = [];

function loadBytes(url) {
  // XMLHttpRequest works for the desktop app's pages and for files opened straight from disk
  return new Promise((ok, fail) => {
    const req = new XMLHttpRequest();
    req.open("GET", url);
    req.responseType = "arraybuffer";
    req.onload = () => (req.response ? ok(req.response) : fail(new Error("empty font file")));
    req.onerror = () => fail(new Error("font file not found"));
    req.send();
  });
}

export function loadFont(key) {
  const k = FONTS[key] ? key : "sans";
  if (!loading[k]) {
    loading[k] = loadBytes(new URL(FONTS[k].file, document.baseURI).href)
      .then((buf) => { fonts[k] = parse(buf); })
      .catch((e) => console.warn(`FiddleCraft: could not load the ${FONTS[k].label} font`, e))
      .then(() => listeners.forEach((fn) => { try { fn(k); } catch (e) { console.warn(e); } }));
  }
  return loading[k];
}

export const fontReady = loadFont("sans");
// call fn whenever another font finishes loading (to redraw text shapes that use it)
export const onFontLoaded = (fn) => listeners.push(fn);
// true when no font is still on its way
export const isFontReady = () => Object.keys(loading).every((k) => fonts[k]);

const cache = new Map();

export function textGeometry(str, fontKey) {
  const k = FONTS[fontKey] ? fontKey : "sans";
  const text = (str || "").trim().slice(0, 40) || "Text";
  const font = fonts[k];
  if (!font) { loadFont(k); return null; }
  const key = k + "|" + text;
  if (cache.has(key)) return cache.get(key);
  // ligatures are switched off: 3D letters don't need them, and some fonts use a kind the reader can't handle
  let path;
  try { path = font.getPath(text, 0, 0, 100, { features: { liga: false, rlig: false } }); }
  catch (e) {
    console.warn(`FiddleCraft: ${FONTS[k].label} can't draw "${text}", using Sans instead`, e);
    if (k === "sans" || !fonts.sans) return null;
    path = fonts.sans.getPath(text, 0, 0, 100, { features: { liga: false, rlig: false } });
  }
  const sp = new THREE.ShapePath();
  for (const c of path.commands) {
    // opentype gives screen coordinates (y down); three.js wants y up
    if (c.type === "M") sp.moveTo(c.x, -c.y);
    else if (c.type === "L") sp.lineTo(c.x, -c.y);
    else if (c.type === "Q") sp.quadraticCurveTo(c.x1, -c.y1, c.x, -c.y);
    else if (c.type === "C") sp.bezierCurveTo(c.x1, -c.y1, c.x2, -c.y2, c.x, -c.y);
  }
  const shapes = sp.toShapes();
  if (!shapes.length) return null;
  const geo = normalize(new THREE.ExtrudeGeometry(shapes, { depth: 20, bevelEnabled: false, curveSegments: 6 }));
  cache.set(key, geo);
  return geo;
}

// How wide some text is for its height (null until its font has loaded)
export function textAspect(str, fontKey) {
  const font = fonts[FONTS[fontKey] ? fontKey : "sans"];
  if (!font) return null;
  try {
    const b = font.getPath(str, 0, 0, 100, { features: { liga: false, rlig: false } }).getBoundingBox();
    const w = b.x2 - b.x1, h = b.y2 - b.y1;
    return w > 0 && h > 0 ? w / h : null;
  } catch { return null; }
}
