# FiddleCraft

A free, open-source 3D design app for everyone. Drag shapes onto the workplane, stretch them, stack them, cut holes with them and group them together. Then export for 3D printing. FiddleCraft runs fully offline on your own computer, with no account and no internet connection.

## Features

- **Hundreds of ready-made shapes** in categories: basic shapes, text and numbers, letters, symbols, connectors, electronics, vehicles, nature, characters, buildings, maths solids and more. Each category starts with its hole shapes.
- **Solids and holes:** turn any shape into a hole, group it with others, and it cuts itself out.
- **Simple handles:** black squares resize, the cone lifts, and arrows turn. Everything follows the snap grid: 0.1 mm to 5 mm, inches, or Brick (8 mm studs, 3.2 mm plates).
- **Align, mirror, ruler, workplanes, hide and lock**, plus undo and redo.
- **Text** in several fonts, **scribble** drawing, and **pictures** (PNG, JPG) or **SVG drawings** turned into flat 3D shapes.
- **Export** to 3MF (keeps colours) and STL for 3D printing, OBJ and GLB, or SVG for laser cutters. A warning shows walls too thin to print.
- **Workspace settings:** background, shadows, grid, low power mode for older computers, camera speed, and millimetres or inches.
- Designs save themselves as you work. **Save** and **Open** use `.fiddlecraft` files.

## Download

Get the latest version from the [Releases page](https://github.com/fiddlecraft/FiddleCraft/releases/latest).

| Computer | File to download |
| --- | --- |
| Windows (most PCs) | `FiddleCraft-Setup-<version>-x64.exe` (installer) or `FiddleCraft-Portable-<version>-x64.exe` (no install) |
| Windows on ARM | `FiddleCraft-Setup-<version>-arm64.exe` |
| Mac with Apple silicon (M1 and newer) | `FiddleCraft-<version>-mac-arm64.dmg` |
| Mac with Intel | `FiddleCraft-<version>-mac-x64.dmg` |
| Linux (any) | `FiddleCraft-<version>-x86_64.AppImage`, or `-arm64.AppImage` for ARM boards such as the Raspberry Pi |
| Ubuntu, Debian, Mint | `FiddleCraft-<version>-linux-amd64.deb` (or `-arm64.deb`) |
| Fedora, openSUSE | `FiddleCraft-<version>-linux-x86_64.rpm` |
| Flatpak | `FiddleCraft-<version>-linux-x86_64.flatpak` |

### First start

- **Windows:** the app isn't signed with a paid certificate yet, so Windows may show "Windows protected your PC". Click **More info**, then **Run anyway**.
- **macOS:** open the `.dmg` and drag FiddleCraft into Applications. The first time, macOS will say it can't check the app. Open **System Settings → Privacy & Security**, scroll down, click **Open Anyway** next to FiddleCraft, and confirm.
- **AppImage:** make it runnable once (right-click → Properties → "Allow executing as program", or `chmod +x FiddleCraft-*.AppImage`), then double-click it.
- **Flatpak:** `flatpak install --user FiddleCraft-*.flatpak`. You need the Flathub repository set up first.

## Build it yourself

You need [Node.js](https://nodejs.org/) 20 or newer.

```sh
npm install          # first time only
npm run build        # builds the 3D workspace into dist/

cd desktop
npm install          # first time only
npm run appimage     # just the Linux AppImage, quickest
npm run dist:linux   # AppImage, deb, rpm and Flatpak (needs rpm and flatpak-builder installed)
npm run dist:win     # Windows installer and portable app (best run on Windows)
npm run dist:mac     # macOS disk images (must be run on a Mac)
```

The packages end up in `desktop/release/`.

GitHub builds every version automatically on Linux, Windows and macOS (see `.github/workflows/build.yml`). To publish a release, push a version tag such as `v0.2.0`. The packages are then attached to a new release on the Releases page.

## How it's made

- [three.js](https://threejs.org/) draws the 3D view.
- [three-bvh-csg](https://github.com/gkjohnson/three-bvh-csg) combines solids and holes.
- [opentype.js](https://opentype.js.org/) turns text into shapes.
- [Electron](https://www.electronjs.org/) wraps it as a desktop app.
- [Vite](https://vite.dev/) builds it.
- Fonts: IBM Plex Sans and IBM Plex Mono, Pacifico and Zilla Slab, all under the SIL Open Font License (see `public/fonts/OFL-LICENSE.txt`).

## Licence

FiddleCraft is released under the [MIT License](LICENSE).
