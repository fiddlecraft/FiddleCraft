# FiddleCraft

A free, open-source 3D design app for everyone. Drag shapes onto the workplane, stretch them, stack them, cut holes with them and group them together. Then export for 3D printing. FiddleCraft runs fully offline on your own computer, with no account and no internet connection.

## Features

- **Hundreds of ready-made shapes** in categories: basic shapes, text and numbers, letters, symbols, connectors, electronics, vehicles, nature, characters, buildings, maths solids and more. Each category starts with its hole shapes.
- **Solids and holes:** turn any shape into a hole, group it with others, and it cuts itself out.
- **Simple handles:** white corner and black side squares resize, the cone lifts, and curved arrows turn, tilt and roll. A rotation wheel snaps to 22.5° or single degrees, and you can type an exact angle. Everything follows the snap grid: 0.1 mm to 5 mm, inches, or Brick (8 mm studs, 3.2 mm plates).
- **Align, mirror, ruler, workplanes, hide and show, and lock**, plus undo and redo.
- **Text** in several fonts, **scribble** drawing, and **Import photo**: PNG or JPG pictures (or SVG drawings) become a flat outline shape, a shaded-height relief (lithophanes too), or a flat picture to trace over. Pasting a copied picture works too.
- **Export** to 3MF (keeps colours) and STL for 3D printing, OBJ and GLB, or SVG for laser cutters. A warning shows walls too thin to print.
- **Workspace settings:** background, shadows, grid, low power mode for older computers, camera speed, and millimetres or inches.
- **Works on small screens** such as 720p laptops and the Steam Deck.
- Designs save themselves as you work. **Save** and **Open** use `.fiddlecraft` files.

## Download

Get the latest version from the [Releases page](https://github.com/fiddlecraft/FiddleCraft/releases/latest).

| Computer | File to download |
| --- | --- |
| Windows (most PCs) | `FiddleCraft-Setup-<version>-x64.exe` (installer) or `FiddleCraft-Portable-<version>-x64.exe` (no install) |
| Windows on ARM | `FiddleCraft-Setup-<version>-arm64.exe` |
| Mac (Apple silicon and Intel) | `FiddleCraft-<version>-mac-universal.dmg` |
| Linux (any) | `FiddleCraft-<version>-x86_64.AppImage`, or `-arm64.AppImage` for ARM boards such as the Raspberry Pi |
| Ubuntu, Debian, Mint | `FiddleCraft-<version>-linux-amd64.deb` (or `-arm64.deb`) |
| Fedora, openSUSE | `FiddleCraft-<version>-linux-x86_64.rpm` (or `-arm64.rpm`) |
| Arch, CachyOS and other Linux (small download) | `FiddleCraft-<version>-linux-x86_64.tar.gz` (or `-arm64.tar.gz`) |

The AppImage is about 108 MB because it carries its own web engine, so it runs on any Linux. The `.deb`, `.rpm` and `.tar.gz` are about 2.5 MB because they use the WebKitGTK web engine already on most Linux desktops (package `webkit2gtk-4.1`).

**Coming from 0.3.x:** version 0.4.0 keeps its designs in a new place. To carry on with a design from an older version, open it there, choose **Save design…**, then open that file in 0.4.0.

### First start

- **Windows:** the app isn't signed with a paid certificate yet, so Windows may show "Windows protected your PC". Click **More info**, then **Run anyway**.
- **macOS:** open the `.dmg` and drag FiddleCraft into Applications. The first time, macOS will say it can't check the app. Open **System Settings → Privacy & Security**, scroll down, click **Open Anyway** next to FiddleCraft, and confirm.
- **AppImage:** make it runnable once (right-click → Properties → "Allow executing as program", or `chmod +x FiddleCraft-*.AppImage`), then double-click it.
- **Steam Deck and other small screens:** in Desktop Mode, download the `x86_64.AppImage`, make it runnable as above and open it. FiddleCraft fills the screen and uses a compact layout at 1280 × 800 and 720p. To start it from Game Mode, add it to Steam with "Add a Non-Steam Game".
- **Small Linux download (.tar.gz):** unpack it and run `./fiddlecraft`, or run `./install.sh` to add FiddleCraft to your app menu.

## Build it yourself

You need [Node.js](https://nodejs.org/) 20 or newer and [Rust](https://rustup.rs/). On Linux you also need the WebKitGTK 4.1 development files (Arch: `webkit2gtk-4.1`, Debian and Ubuntu: `libwebkit2gtk-4.1-dev`).

```sh
npm install          # first time only
npm run build        # builds the 3D workspace into dist/

cd desktop-tauri
npm install          # first time only
npm run appimage     # just the Linux AppImage, quickest
npm run dist:linux   # AppImage, deb and rpm
npm run dist:win     # Windows installer (run on Windows)
npm run dist:mac     # macOS disk image (run on a Mac)
npm run package      # copies the packages into desktop-tauri/release/ (and makes the Linux .tar.gz)
```

See `desktop-tauri/README.md` for the self-tests. The older Electron version of the desktop app is still in `desktop/`.

GitHub builds every version automatically on Linux, Windows and macOS (see `.github/workflows/build.yml`). To publish a release, push a version tag such as `v0.2.0`. The packages are then attached to a new release on the Releases page.

## How it's made

- [three.js](https://threejs.org/) draws the 3D view.
- [three-bvh-csg](https://github.com/gkjohnson/three-bvh-csg) combines solids and holes.
- [opentype.js](https://opentype.js.org/) turns text into shapes.
- [Tauri](https://tauri.app/) wraps it as a desktop app (before 0.4.0, [Electron](https://www.electronjs.org/) did).
- [Vite](https://vite.dev/) builds it.
- Fonts: IBM Plex Sans and IBM Plex Mono, Pacifico and Zilla Slab, all under the SIL Open Font License (see `public/fonts/OFL-LICENSE.txt`).

## Licence

FiddleCraft is released under the [MIT License](LICENSE).
