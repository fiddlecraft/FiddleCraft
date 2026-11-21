# FiddleCraft desktop (Tauri)

From version 0.4.0 the desktop app is a small Rust program ([Tauri](https://tauri.app)) around the
same 3D workspace (`../dist`). It replaces the Electron shell in `../desktop`, which still works
and is kept for reference.

What the shell does (`src/main.rs`, `src/shell.js`):

- one window per design, sized to the screen; **New window** opens another
- the File / Edit / View / Help menus, which call `window.shapeforgeApp` in the page
- **Save your design?** before a window closes (Save… / Don't save / Cancel)
- saving designs and exporting STL, OBJ, GLB and SVG through the computer's own Save dialog
- opening `.fiddlecraft` (and older `.shapeforge`) files given on the command line or double-clicked;
  a second launch adds a window to the running app
- website links open in the normal browser

## Build

Needs Rust (`rustup`), Node.js and, on Linux, the WebKitGTK 4.1 development files
(Arch: `webkit2gtk-4.1`, Debian/Ubuntu: `libwebkit2gtk-4.1-dev`).

```sh
cd ..            # app/
npm install && npm run build      # the workspace -> dist/
cd desktop-tauri
npm install
npm run dist:linux                # AppImage, .deb and .rpm
npm run package                   # copies them to release/ and makes the small .tar.gz
```

Downloads, from biggest to smallest:

| File | Size | Notes |
| --- | --- | --- |
| `FiddleCraft-0.4.0-x86_64.AppImage` | about 75 MB | runs on any Linux; carries its own WebKitGTK |
| `FiddleCraft-0.4.0-linux-amd64.deb` / `-linux-x86_64.rpm` | about 2.5 MB | uses the system's WebKitGTK |
| `FiddleCraft-0.4.0-linux-x86_64.tar.gz` | about 2.5 MB | any distro with `webkit2gtk-4.1`; `./install.sh` adds it to the app menu |

## Self-test

```sh
SHAPEFORGE_SELFTEST=1 ./fiddlecraft          # adds a shape, checks the 3D view draws, quits
SHAPEFORGE_SELFTEST=close ./fiddlecraft      # the save prompt: Cancel keeps the window, Don't save closes it
SHAPEFORGE_SELFTEST=reload ./fiddlecraft     # the design comes back after reopening
SHAPEFORGE_SELFTEST=export ./fiddlecraft     # STL, OBJ, GLB, SVG and the design file are written
```

Add `SHAPEFORGE_SELFTEST_SHOW=1` to show the window (the 3D check needs it) and
`SHAPEFORGE_SHOT=/tmp/view.png` to keep a picture of the 3D view. Tests use a throwaway settings folder.

Note: designs kept inside the Electron version (0.3.x) don't move over by themselves — open the old
version, use **Save design…**, then open that file in 0.4.0.
