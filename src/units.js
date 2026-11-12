// Display units. Designs are always kept in millimetres; this only changes what is shown and typed.
const KEY = "shapeforge-units";
const MM_PER_IN = 25.4;
let unit = "mm";
try { if (localStorage.getItem(KEY) === "in") unit = "in"; } catch { /* default */ }
const listeners = [];

export const units = {
  get: () => unit,
  set(u) {
    unit = u === "in" ? "in" : "mm";
    try { localStorage.setItem(KEY, unit); } catch { /* storage full */ }
    listeners.forEach((f) => f(unit));
  },
  onChange: (f) => listeners.push(f),
  /** a length in millimetres, in the chosen unit */
  show: (mm) => (unit === "in" ? mm / MM_PER_IN : mm),
  /** a typed number in the chosen unit, back to millimetres */
  read: (v) => (unit === "in" ? v * MM_PER_IN : v),
  /** short label: "mm" or "in" */
  label: () => unit,
  /** long name for the status bar */
  name: () => (unit === "in" ? "inches" : "millimetres"),
  /** a length as a short number in the chosen unit (no unit label) */
  num(mm) {
    const v = unit === "in" ? mm / MM_PER_IN : mm;
    return String(+v.toFixed(unit === "in" ? 4 : 2));
  },
  /** a length with its unit, e.g. "20 mm" or "0.787 in" */
  text(mm, digits) {
    const v = unit === "in" ? mm / MM_PER_IN : mm;
    return `${+v.toFixed(digits ?? (unit === "in" ? 2 : 1))} ${unit}`;
  },
  /** grid snap choices for the current unit: [value in mm, label] */
  snaps: () => (unit === "in"
    ? [[0, "Off"], [MM_PER_IN / 64, "1/64 in"], [MM_PER_IN / 32, "1/32 in"], [MM_PER_IN / 16, "1/16 in"], [MM_PER_IN / 8, "1/8 in"], [MM_PER_IN / 4, "1/4 in"], [MM_PER_IN / 2, "1/2 in"], [MM_PER_IN, "1 in"], [BRICK, "Brick"]]
    : [[0, "Off"], [0.1, "0.1 mm"], [0.25, "0.25 mm"], [0.5, "0.5 mm"], [1, "1.0 mm"], [2, "2.0 mm"], [5, "5.0 mm"], [BRICK, "Brick"]]),
};

// Brick snap follows toy building bricks: 8 mm between studs sideways, and 3.2 mm (one thin plate)
// up and down, so three steps make one full 9.6 mm brick.
export const BRICK = 8;
export const BRICK_UP = 3.2;
export const BRICK_HINT = "Building-brick sizes: 8 mm steps sideways (one stud), 3.2 mm steps up and down (one plate; 3 plates = 1 brick)";
