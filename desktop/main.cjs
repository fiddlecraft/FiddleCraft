// FiddleCraft desktop: opens the 3D workspace in its own window, fully offline.
const { app, BrowserWindow, protocol, net, shell, Menu, dialog } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");

// The self-test gets its own throwaway profile so it can never touch the person's saved designs
if (process.env.SHAPEFORGE_SELFTEST) {
  app.setPath("userData", path.join(require("node:os").tmpdir(), `shapeforge-selftest-${process.pid}`));
}

// The app was called Shapeforge before: keep using that settings folder (designs, My shapes,
// earlier versions) so nothing is lost after the rename.
if (!process.env.SHAPEFORGE_SELFTEST) {
  const appData = app.getPath("appData");
  const before = path.join(appData, "Shapeforge");
  if (fs.existsSync(before) && !fs.existsSync(path.join(appData, "FiddleCraft"))) app.setPath("userData", before);
}

const WEB = path.join(__dirname, "web");
const ORIGIN = "app://shapeforge";

// A private address for the bundled pages, so links like /assets/... work exactly as on the website
protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

function resolveFile(urlPath) {
  let rel = decodeURIComponent(urlPath).replace(/^\/+/, "");
  let file = path.normalize(path.join(WEB, rel));
  if (!file.startsWith(WEB)) return null; // never serve files outside the app
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  return fs.existsSync(file) ? file : null;
}

// A design file passed on the command line (for example by double-clicking a .fiddlecraft or older .shapeforge file)
function designFromArgs(argv) {
  return argv.slice(1).find((a) => /\.(fiddlecraft|shapeforge)$/i.test(a) && fs.existsSync(a)) || null;
}

function createWindow(designPath) {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 520,
    title: "FiddleCraft",
    backgroundColor: "#f9fafb",
    icon: path.join(WEB, "icons", "icon-512.png"),
    autoHideMenuBar: false,
    show: !process.env.SHAPEFORGE_SELFTEST, // the self-test runs without showing a window
    webPreferences: { contextIsolation: true, sandbox: true },
  });

  // Website links leave the app and open in the normal browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (/^https?:/i.test(url)) { e.preventDefault(); shell.openExternal(url); }
  });

  win.loadURL(`${ORIGIN}/`);

  // Ask to save before the window closes, if the design changed since it was last saved to a file
  let closingAllowed = !!process.env.SHAPEFORGE_SELFTEST && process.env.SHAPEFORGE_SELFTEST !== "close";
  if (process.env.SHAPEFORGE_SELFTEST === "close") {
    // Self-test for the save prompt: answer Cancel first (window must stay), then Don't save (window must close)
    const answers = [2, 1];
    dialog.showMessageBox = async () => { const response = answers.shift(); console.log(`SELFTEST close | prompt shown, answering ${response === 2 ? "Cancel" : "Don't save"}`); return { response }; };
    setTimeout(() => { console.log("SELFTEST TIMEOUT"); app.exit(2); }, 30000);
    win.webContents.once("did-finish-load", async () => {
      await new Promise((r) => setTimeout(r, 1500));
      await win.webContents.executeJavaScript(`localStorage.setItem("shapeforge-welcomed", "1"); document.querySelector('.shape-btn[data-key="box"]').click();`);
      win.close();
      await new Promise((r) => setTimeout(r, 1500));
      console.log(`SELFTEST close | after Cancel, window still open: ${!win.isDestroyed()}`);
      win.on("closed", () => { console.log("SELFTEST close | after Don't save, window closed: true"); });
      win.close();
    });
  }
  win.on("close", (e) => {
    if (closingAllowed) return;
    e.preventDefault();
    (async () => {
      let needsSave = false;
      try { needsSave = await win.webContents.executeJavaScript("!!(window.shapeforgeApp && window.shapeforgeApp.needsSave())"); } catch { /* page not ready: nothing to save */ }
      if (needsSave) {
        const { response } = await dialog.showMessageBox(win, {
          type: "question",
          buttons: ["Save…", "Don't save", "Cancel"],
          defaultId: 0,
          cancelId: 2,
          noLink: true,
          title: "Save your design?",
          message: "Save changes to your design before closing?",
          detail: "FiddleCraft also keeps your latest design on this computer, but saving makes a .fiddlecraft file you can keep, back up or share.",
        });
        if (response === 2) return; // Cancel: keep working
        if (response === 0) {
          let saved = false;
          try { saved = await win.webContents.executeJavaScript("window.shapeforgeApp.saveForClose()", true); } catch { saved = false; }
          if (!saved) return; // they backed out of the save dialog: keep the window open
        }
        if (response === 1) {
          // Don't save: put the kept copy back to the last saved design so the changes don't return next time
          try { await win.webContents.executeJavaScript("window.shapeforgeApp.discardForClose()", true); } catch { /* page gone: nothing kept */ }
          if (process.env.SHAPEFORGE_SELFTEST === "close") {
            const kept = await win.webContents.executeJavaScript(`(() => { const d = JSON.parse(localStorage.getItem("shapeforge-design-v1") || "null"); return d ? d.shapes.length + " shapes" : "nothing"; })()`).catch(() => "unknown");
            console.log(`SELFTEST close | after Don't save, design kept for next time: ${kept}`);
          }
        }
      }
      closingAllowed = true;
      win.close();
    })();
  });

  // Self-test for builders: SHAPEFORGE_SELFTEST=1 adds a shape, prints the result and quits
  if (process.env.SHAPEFORGE_SELFTEST === "reload") {
    // Place shapes, reload the page (like closing and reopening), and check the design came back
    setTimeout(() => { console.log("SELFTEST TIMEOUT"); app.exit(2); }, 40000);
    const js = (code) => win.webContents.executeJavaScript(code);
    win.webContents.once("did-finish-load", async () => {
      try {
        await new Promise((r) => setTimeout(r, 1500));
        const before = await js(`(() => { localStorage.setItem("shapeforge-welcomed", "1"); const b = document.querySelectorAll(".shape-btn"); const k = (key) => document.querySelector('.shape-btn[data-key="' + key + '"]'); k("box").click(); k("cylinder").click(); k("text").click(); return window.__shapeforge.shapes().map((s) => s.name).join(", ") + " | needs saving: " + window.shapeforgeApp.needsSave(); })()`);
        win.webContents.once("did-finish-load", async () => {
          await new Promise((r) => setTimeout(r, 1500));
          const after = await js(`window.__shapeforge ? window.__shapeforge.shapes().map((s) => s.name).join(", ") + " | needs saving: " + window.shapeforgeApp.needsSave() : "APP DID NOT START"`);
          console.log(`SELFTEST reload | before: ${before} | after reopening: ${after}`);
          app.exit(0);
        });
        win.webContents.reload();
      } catch (e) { console.log("SELFTEST FAIL " + e.message); app.exit(1); }
    });
  } else if (process.env.SHAPEFORGE_SELFTEST === "export") {
    // Export STL, OBJ and GLB inside the real app and check the files arrive; then import an SVG
    // drawing and check it survives closing and reopening
    setTimeout(() => { console.log("SELFTEST TIMEOUT"); app.exit(2); }, 45000);
    const js = (code) => win.webContents.executeJavaScript(code, true);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const outDir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "shapeforge-export-"));
    const got = [];
    win.webContents.session.on("will-download", (_e, item) => {
      const file = path.join(outDir, item.getFilename());
      item.setSavePath(file);
      item.once("done", (_ev, state) => { got.push(`${item.getFilename()} ${state === "completed" ? fs.statSync(file).size + " bytes" : state}`); });
    });
    win.webContents.once("did-finish-load", async () => {
      try {
        await wait(1500);
        await js(`(() => { localStorage.setItem("shapeforge-welcomed", "1"); const d = document.querySelector("#welcome-dialog"); if (d && d.open) d.close();
          const b = [...document.querySelectorAll(".shape-btn")]; b.find((x) => x.textContent.trim() === "Box").click(); b.find((x) => x.textContent.trim() === "Sphere").click(); })()`);
        for (const f of ["stl", "obj", "glb", "svg"]) { await js(`window.shapeforgeApp.exportAs("${f}")`); await wait(700); }
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><path fill-rule="evenodd" d="M0 0H200V100H0Z M50 25H150V75H50Z"/></svg>';
        const imported = await js(`(async () => { const dt = new DataTransfer(); dt.items.add(new File([${JSON.stringify(svg)}], "logo.svg", { type: "image/svg+xml" }));
          const sf = window.__shapeforge, r = sf.canvas.getBoundingClientRect();
          sf.canvas.parentElement.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 40, clientY: r.bottom - 40 }));
          await new Promise((r) => setTimeout(r, 600)); const s = sf.shapes().find((x) => x.name === "logo"); return s ? s.w + " x " + s.d + " x " + s.h + " mm" : "missing"; })()`);
        console.log(`SELFTEST export | files: ${got.join(", ") || "none"} | svg imported: ${imported}`);
        win.webContents.once("did-finish-load", async () => {
          await wait(1500);
          const after = await js(`(() => { const sf = window.__shapeforge; if (!sf) return "APP DID NOT START"; const s = sf.shapes().find((x) => x.name === "logo"); return sf.shapes().map((x) => x.name).join(", ") + (s ? " | logo size " + s.w + " x " + s.d + " x " + s.h : " | logo missing"); })()`);
          console.log(`SELFTEST export | after reopening: ${after}`);
          app.exit(0);
        });
        win.webContents.reload();
      } catch (e) { console.log("SELFTEST FAIL " + e.message); app.exit(1); }
    });
  } else if (process.env.SHAPEFORGE_SELFTEST === "input") {
    // Real mouse and keyboard events: Ctrl+click to add shapes, Ctrl+A to select everything
    setTimeout(() => { console.log("SELFTEST TIMEOUT"); app.exit(2); }, 40000);
    win.webContents.once("did-finish-load", async () => {
      const js = (code) => win.webContents.executeJavaScript(code);
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const click = async (pt, modifiers = []) => {
        win.webContents.sendInputEvent({ type: "mouseMove", x: pt.x, y: pt.y, modifiers });
        win.webContents.sendInputEvent({ type: "mouseDown", x: pt.x, y: pt.y, button: "left", clickCount: 1, modifiers });
        await wait(40);
        win.webContents.sendInputEvent({ type: "mouseUp", x: pt.x, y: pt.y, button: "left", clickCount: 1, modifiers });
        await wait(120);
      };
      try {
        await wait(1500);
        await js("document.querySelector('#welcome-dialog') && document.querySelector('#welcome-dialog').close()");
        win.webContents.focus();
        const pts = await js(`(() => {
          localStorage.clear();
          ["box", "cylinder", "sphere"].forEach((key) => document.querySelector('.shape-btn[data-key="' + key + '"]').click());
          const sf = window.__shapeforge, V3 = sf.camera.position.constructor, r = sf.canvas.getBoundingClientRect();
          sf.camera.updateMatrixWorld();
          return sf.shapes().map((s) => { const p = new V3(s.x, s.y + s.h / 2, s.z).project(sf.camera); return { x: Math.round(r.left + (p.x + 1) / 2 * r.width), y: Math.round(r.top + (1 - p.y) / 2 * r.height) }; });
        })()`);
        await click(pts[0]);
        const one = await js("window.__shapeforge.picked().length");
        await click(pts[1], ["control"]);
        const two = await js("window.__shapeforge.picked().length");
        const panel = await js("!document.querySelector('#align-box').hidden");
        // put the cursor in the design-name box, then click empty space in the 3D view (like a real person might)
        await js("document.querySelector('#project-name').focus()");
        const empty = await js("(() => { const r = window.__shapeforge.canvas.getBoundingClientRect(); return { x: Math.round(r.left + 140), y: Math.round(r.bottom - 40) }; })()");
        await click(empty);
        win.webContents.sendInputEvent({ type: "keyDown", keyCode: "A", modifiers: ["control"] });
        win.webContents.sendInputEvent({ type: "char", keyCode: "a", modifiers: ["control"] });
        win.webContents.sendInputEvent({ type: "keyUp", keyCode: "A", modifiers: ["control"] });
        await wait(200);
        const all = await js("window.__shapeforge.picked().length");
        // Align tool: L shows the dots, hovering one previews, clicking lines the shapes up
        win.webContents.sendInputEvent({ type: "keyDown", keyCode: "L" });
        win.webContents.sendInputEvent({ type: "char", keyCode: "l" });
        win.webContents.sendInputEvent({ type: "keyUp", keyCode: "L" });
        await wait(300);
        const dotPt = await js(`(() => { const sf = window.__shapeforge, r = sf.canvas.getBoundingClientRect(); sf.placeAlign();
          const d = sf.alignDots.find((x) => x.axis === "z" && x.where === "max"); const p = d.mesh.position.clone().project(sf.camera);
          return { x: Math.round(r.left + (p.x + 1) / 2 * r.width), y: Math.round(r.top + (1 - p.y) / 2 * r.height) }; })()`);
        win.webContents.sendInputEvent({ type: "mouseMove", x: dotPt.x, y: dotPt.y });
        await wait(300);
        const hovered = await js("(() => { const a = window.__shapeforge.aligning(); return a && a.hover ? a.hover.axis + ':' + a.hover.where : 'none'; })()").catch(() => "none");
        if (process.env.SHAPEFORGE_SHOT) { const img = await win.webContents.capturePage(); require("fs").writeFileSync(process.env.SHAPEFORGE_SHOT, img.toPNG()); }
        await click(dotPt);
        const fronts = await js("window.__shapeforge.shapes().map((s) => Math.round((s.z + s.d / 2) * 10) / 10).join('/')");
        const aligned = await js("!!window.__shapeforge.aligning()") ? "on" : "off";
        // Ruler: click the toolbar button, then a spot on the workplane, then pick one shape
        win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
        win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
        const rb = await js("(() => { const r = document.querySelector('#ruler').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()");
        await click(rb);
        const spot = await js(`(() => { const sf = window.__shapeforge, r = sf.canvas.getBoundingClientRect(); const p = new sf.camera.position.constructor(40, 0, 70).project(sf.camera);
          return { x: Math.round(r.left + (p.x + 1) / 2 * r.width), y: Math.round(r.top + (1 - p.y) / 2 * r.height) }; })()`);
        await click(spot);
        const shape3 = await js(`(() => { const sf = window.__shapeforge, r = sf.canvas.getBoundingClientRect(), s = sf.shapes()[2]; const p = new sf.camera.position.constructor(s.x, s.y + s.h / 2, s.z).project(sf.camera);
          return { x: Math.round(r.left + (p.x + 1) / 2 * r.width), y: Math.round(r.top + (1 - p.y) / 2 * r.height) }; })()`);
        await click(shape3);
        await wait(300);
        const rulerInfo = await js("(() => { const ru = window.__shapeforge.ruler; ru.update(); return ru.origin ? 'at ' + ru.origin.x + ',' + ru.origin.z + ', distances ' + ru.fields.x.value + '/' + ru.fields.z.value : 'not placed'; })()");
        if (process.env.SHAPEFORGE_SHOT2) { const img = await win.webContents.capturePage(); require("fs").writeFileSync(process.env.SHAPEFORGE_SHOT2, img.toPNG()); }
        await js("window.shapeforgeApp.view('top')"); // the view cube and the 1 key do this now
        await wait(700);
        const top = await js("(() => { const c = window.__shapeforge.camera.position; return Math.round(c.y) + ' up, ' + Math.round(Math.hypot(c.x, c.z)) + ' sideways'; })()");
        console.log(`SELFTEST input | click: ${one} selected | ctrl+click: ${two} selected | line-up panel shown: ${panel} | ctrl+A: ${all} of 3 selected | align: hover ${hovered}, dots ${aligned}, front edges after clicking a dot ${fronts} | ruler: ${rulerInfo} | top view camera: ${top}`);
        await js("localStorage.clear()");
      } catch (e) { console.log("SELFTEST FAIL " + e.message); }
      app.exit(0);
    });
  } else if (process.env.SHAPEFORGE_SELFTEST && process.env.SHAPEFORGE_SELFTEST !== "close") {
    setTimeout(() => { console.log("SELFTEST TIMEOUT: the page did not finish loading in 30 seconds"); app.exit(2); }, 30000);
    win.webContents.once("did-finish-load", async () => {
      try {
        const out = await win.webContents.executeJavaScript(`new Promise((ok) => setTimeout(() => {
          document.querySelector('.shape-btn[data-key="box"]').click();
          const shapes = [...document.querySelectorAll(".outline__row > button:first-child")].map((b) => b.textContent).join(", ");
          localStorage.clear(); // leave no test shapes behind
          ok("SELFTEST " + document.title + " | shapes: " + shapes + " | menu actions: " + Object.keys(window.shapeforgeApp || {}).length);
        }, 1500))`);
        console.log(out);
      } catch (e) { console.log("SELFTEST FAIL " + e.message); }
      app.exit(0);
    });
    win.webContents.on("did-fail-load", (_e, code, desc) => { console.log("SELFTEST LOAD FAIL " + code + " " + desc); app.exit(1); });
  }

  if (designPath) {
    win.webContents.once("did-finish-load", () => {
      const text = fs.readFileSync(designPath, "utf8");
      const name = path.basename(designPath);
      win.webContents.executeJavaScript(
        `window.dispatchEvent(new CustomEvent("shapeforge-open", { detail: { text: ${JSON.stringify(text)}, name: ${JSON.stringify(name)} } }))`
      );
    });
  }
  return win;
}

// macOS hands over double-clicked design files with an event instead of the command line
const isMac = process.platform === "darwin";
let pendingOpen = null;
app.on("open-file", (e, file) => {
  e.preventDefault();
  if (!/\.(fiddlecraft|shapeforge)$/i.test(file)) return;
  if (app.isReady()) createWindow(file);
  else pendingOpen = file;
});

const single = app.requestSingleInstanceLock();
if (!single) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    const design = designFromArgs(argv);
    if (design) createWindow(design);
    else {
      const [win] = BrowserWindow.getAllWindows();
      if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
    }
  });

  app.whenReady().then(() => {
    protocol.handle("app", (req) => {
      const file = resolveFile(new URL(req.url).pathname);
      if (!file) return new Response("Not found", { status: 404 });
      return net.fetch(pathToFileURL(file).toString());
    });

    // Menu items call the workspace. Shortcuts are handled inside the workspace,
    // so they are shown here but not registered twice.
    const act = (name) => (_item, win) => {
      const w = win || BrowserWindow.getFocusedWindow();
      if (w) w.webContents.executeJavaScript(`window.shapeforgeApp && window.shapeforgeApp.${name}()`);
    };
    const key = (accelerator) => ({ accelerator, registerAccelerator: false });
    // Editing keys: in a text box they edit the text, otherwise they act on shapes.
    // macOS only delivers Cmd+C/V/X/Z/A through the menu, so there they are registered for real.
    const typing = "(() => { const a = document.activeElement; return !!a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)); })()";
    const edit = (name, native, accelerator) => ({
      ...(isMac ? { accelerator } : key(accelerator)),
      click: async (_item, win) => {
        const w = win || BrowserWindow.getFocusedWindow();
        if (!w) return;
        if (await w.webContents.executeJavaScript(typing).catch(() => false)) w.webContents[native]();
        else act(name)(_item, w);
      },
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      ...(isMac ? [{ role: "appMenu" }] : []),
      { label: "File", submenu: [
        { label: "New design", click: act("newDesign") },
        { label: "Open design…", ...key("CmdOrCtrl+O"), click: act("open") },
        { label: "Save design…", ...key("CmdOrCtrl+S"), click: act("save") },
        { label: "Import STL model, SVG drawing or picture…", click: act("importSTL") },
        { type: "separator" },
        { label: "Restore an earlier version…", click: act("versions") },
        { label: "Export for 3D printing (STL)…", click: act("exportSTL") },
        { label: "Export selected shapes (STL)…", click: act("exportSelected") },
        { label: "Export as STL, OBJ, GLB or SVG…", ...key("CmdOrCtrl+E"), click: act("exportWindow") },
        { type: "separator" },
        { label: "New window", accelerator: "CmdOrCtrl+N", click: () => createWindow() },
        ...(isMac ? [{ role: "close" }] : [{ role: "quit" }]),
      ] },
      { label: "Edit", submenu: [
        { label: "Undo", ...edit("undo", "undo", "CmdOrCtrl+Z") },
        { label: "Redo", ...edit("redo", "redo", isMac ? "Cmd+Shift+Z" : "CmdOrCtrl+Y") },
        { type: "separator" },
        { label: "Select all shapes", ...edit("selectAll", "selectAll", "CmdOrCtrl+A") },
        { label: "Hide selected shapes", ...key("CmdOrCtrl+H"), click: act("hideSelected") },
        { label: "Show hidden shapes", ...key("CmdOrCtrl+Shift+H"), click: act("showAll") },
        { label: "Hide and show…", ...key("V"), click: act("visMode") },
        { label: "Mirror…", ...key("M"), click: act("mirror") },
        { label: "Save selection to My shapes…", click: act("saveToLibrary") },
        { type: "separator" },
        { label: "Cut", ...edit("cut", "cut", "CmdOrCtrl+X") },
        { label: "Copy", ...edit("copy", "copy", "CmdOrCtrl+C") },
        { label: "Paste", ...edit("paste", "paste", "CmdOrCtrl+V") },
        { label: "Duplicate", ...key("CmdOrCtrl+D"), click: act("duplicate") },
        { label: "Delete shape", ...key("Delete"), click: act("remove") },
        { type: "separator" },
        { label: "Group", ...key("CmdOrCtrl+G"), click: act("group") },
        { label: "Ungroup", ...key("CmdOrCtrl+Shift+G"), click: act("ungroup") },
        { type: "separator" },
        { label: "Drop to workplane", ...key("D"), click: act("drop") },
        { label: "Align tool", ...key("L"), click: act("alignTool") },
        { label: "Line up", submenu: [
          { label: "Left edges", click: (_i, w) => w && w.webContents.executeJavaScript("shapeforgeApp.align('x','min')") },
          { label: "Centres (left–right)", click: (_i, w) => w && w.webContents.executeJavaScript("shapeforgeApp.align('x','mid')") },
          { label: "Right edges", click: (_i, w) => w && w.webContents.executeJavaScript("shapeforgeApp.align('x','max')") },
          { label: "Bottoms", click: (_i, w) => w && w.webContents.executeJavaScript("shapeforgeApp.align('y','min')") },
        ] },
      ] },
      { label: "View", submenu: [
        { label: "Workplane size…", click: act("workplane") },
        { label: "Ruler", click: act("ruler") },
        { label: "Workplane on a face", ...key("W"), click: act("planeTool") },
        { label: "Reset view", ...key("H"), click: act("resetView") },
        { label: "Zoom to fit", ...key("F"), click: (_i, w) => w && w.webContents.executeJavaScript("shapeforgeApp.view('fit')") },
        { label: "Top", ...key("1"), click: (_i, w) => w && w.webContents.executeJavaScript("shapeforgeApp.view('top')") },
        { label: "Flat view on/off", ...key("O"), click: act("flatView") },
        { label: "Front", ...key("2"), click: (_i, w) => w && w.webContents.executeJavaScript("shapeforgeApp.view('front')") },
        { label: "Side", ...key("3"), click: (_i, w) => w && w.webContents.executeJavaScript("shapeforgeApp.view('side')") },
        { type: "separator" },
        { role: "togglefullscreen" }, { role: "zoomIn" }, { role: "zoomOut" }, { role: "resetZoom" },
      ] },
      ...(isMac ? [{ role: "windowMenu" }] : []),
      { label: "Help", submenu: [{ label: "Getting started", click: act("welcome") }, { label: "Keyboard and mouse", ...key("?"), click: act("help") }] },
    ]));

    createWindow(pendingOpen || designFromArgs(process.argv));
    app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });

  app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
}
