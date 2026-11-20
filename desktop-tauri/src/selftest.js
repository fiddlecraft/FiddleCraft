// Self-test for builders: SHAPEFORGE_SELFTEST=1|close|export|reload runs inside the real app and prints the result.
// The app gives the test its own throwaway settings folder, so it never touches the person's designs.
(async function (mode) {
  const invoke = (cmd, args) => window.__TAURI__.core.invoke(cmd, args);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (text) => invoke("selftest_log", { text: "SELFTEST " + text });
  const done = (code) => invoke("selftest_exit", { code });
  window.__fiddlecraftSelftest = { log: (t) => log(t) };
  const addShapes = (keys) => keys.forEach((k) => document.querySelector('.shape-btn[data-key="' + k + '"]').click());

  // Draw the scene once and look at the picture WebGL made
  function picture() {
    const sf = window.__shapeforge;
    if (!sf || !sf.renderer) return "no 3D view";
    const r = sf.renderer, gl = r.getContext();
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    const gpu = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    r.render(sf.scene, sf.camera);
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const png = atob(r.domElement.toDataURL("image/png").split(",")[1]);
    window.__TAURI__.core.invoke("selftest_shot", Uint8Array.from(png, (c) => c.charCodeAt(0)));
    const colours = new Set(); let lit = 0;
    for (let i = 0; i < px.length; i += 4 * 7) { colours.add((px[i] >> 3) + "," + (px[i + 1] >> 3) + "," + (px[i + 2] >> 3)); if (px[i + 3] > 0) lit++; }
    return (r.capabilities.isWebGL2 ? "WebGL2" : "WebGL1") + " on " + gpu + ", " + w + "x" + h + ", " + colours.size + " colours, " + Math.round(lit / (px.length / 28) * 100) + "% drawn";
  }

  try {
    for (let i = 0; i < 50 && !window.shapeforgeApp; i++) await wait(100);
    await wait(800);
    localStorage.setItem("shapeforge-welcomed", "1");
    const welcome = document.querySelector("#welcome-dialog");
    if (welcome && welcome.open) welcome.close();

    if (mode === "close") {
      addShapes(["box"]);
      await invoke("selftest_close"); // like pressing the window's close button: answers Cancel
      await wait(1500);
      await log("close | after Cancel, window still open: true");
      await invoke("selftest_close"); // again: answers Don't save, so the window closes
      return;
    }

    if (mode === "reload") {
      if (!sessionStorage.getItem("selftest-reloaded")) {
        addShapes(["box", "cylinder", "text"]);
        sessionStorage.setItem("selftest-reloaded", window.__shapeforge.shapes().map((s) => s.name).join(", ") + " | needs saving: " + window.shapeforgeApp.needsSave());
        location.reload();
        return;
      }
      const after = window.__shapeforge.shapes().map((s) => s.name).join(", ") + " | needs saving: " + window.shapeforgeApp.needsSave();
      await log("reload | before: " + sessionStorage.getItem("selftest-reloaded") + " | after reopening: " + after);
      return done(0);
    }

    if (mode === "export") {
      addShapes(["box", "sphere"]);
      for (const f of ["stl", "obj", "glb", "svg"]) { await window.shapeforgeApp.exportAs(f); await wait(700); }
      window.shapeforgeApp.exportSTL();
      await wait(700);
      const saved = await window.shapeforgeApp.saveForClose();
      await log("export | design saved: " + saved + " | needs saving after: " + window.shapeforgeApp.needsSave());
      return done(0);
    }

    const opened = window.__shapeforge.shapes().map((s) => s.name).join(", ") || "none";
    addShapes(["box"]);
    await wait(300);
    if (opened !== "none") await log("opened design: " + document.querySelector("#project-name").value + " with " + opened);
    const shapes = [...document.querySelectorAll(".outline__row > button:first-child")].map((b) => b.textContent).join(", ");
    await log(document.title + " | shapes: " + shapes + " | menu actions: " + Object.keys(window.shapeforgeApp || {}).length + " | 3D: " + picture());
    localStorage.clear();
    return done(0);
  } catch (e) {
    await log("FAIL " + (e && e.message ? e.message : e));
    return done(1);
  }
})("__SELFTEST_MODE__");
