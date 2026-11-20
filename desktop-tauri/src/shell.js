// FiddleCraft desktop: the small bridge between the workspace page and the desktop app.
// Runs before the page's own scripts in every window.
(function () {
  const invoke = (cmd, args, options) => window.__TAURI__.core.invoke(cmd, args, options);
  const bytesOf = (data) => {
    if (typeof data === "string") return new TextEncoder().encode(data);
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (data instanceof Blob) return data.arrayBuffer().then((b) => new Uint8Array(b));
    throw new Error("Unknown file contents");
  };
  let closing = false;

  window.__fiddlecraftNative = {
    // Save through the computer's own Save dialog. Resolves to the saved path, or null if they cancelled.
    async save(data, name, label, extensions) {
      const body = await bytesOf(data);
      return invoke("save_file", body, {
        headers: {
          "x-name": encodeURIComponent(name),
          "x-label": encodeURIComponent(label),
          "x-exts": extensions.join(","),
        },
      });
    },

    // The window's close button (or Quit) was pressed: ask to save first if the design changed
    async closeRequested() {
      invoke("close_ack");
      if (closing) return;
      closing = true;
      try {
        let needsSave = false;
        try { needsSave = !!(window.shapeforgeApp && window.shapeforgeApp.needsSave()); } catch (e) { needsSave = false; }
        if (needsSave) {
          const answer = await invoke("ask_save"); // 0 Save, 1 Don't save, 2 Cancel
          if (window.__fiddlecraftSelftest) window.__fiddlecraftSelftest.log("close | prompt shown, answered " + ["Save", "Don't save", "Cancel"][answer]);
          if (answer === 2) return; // keep working
          if (answer === 0) {
            let saved = false;
            try { saved = await window.shapeforgeApp.saveForClose(); } catch (e) { saved = false; }
            if (!saved) return; // they backed out of the Save dialog: keep the window open
          }
          if (answer === 1) {
            // Don't save: put the kept copy back to the last saved design so the changes don't return next time
            try { await window.shapeforgeApp.discardForClose(); } catch (e) { /* nothing kept */ }
            if (window.__fiddlecraftSelftest) {
              const d = JSON.parse(localStorage.getItem("shapeforge-design-v1") || "null");
              window.__fiddlecraftSelftest.log("close | after Don't save, design kept for next time: " + (d ? d.shapes.length + " shapes" : "nothing"));
            }
          }
        }
        await invoke("close_window");
      } finally {
        closing = false;
      }
    },

    // Menu items for editing: in a text box they edit the text, otherwise they act on shapes
    edit(action, command) {
      const a = document.activeElement;
      const typing = !!a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));
      if (typing) document.execCommand(command);
      else if (window.shapeforgeApp && window.shapeforgeApp[action]) window.shapeforgeApp[action]();
    },
  };
})();
