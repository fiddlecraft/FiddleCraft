# FiddleCraft

A free, open-source 3D design app for everyone. Drag shapes onto the workplane, stretch them, stack them, cut holes with them and group them together. Then export for 3D printing. FiddleCraft runs fully offline on your own computer, with no account and no internet connection.

## Features

- **Hundreds of ready-made shapes** in categories: basic shapes, text and numbers, letters, symbols, connectors, electronics, vehicles, nature, characters, buildings, maths solids and more. Each category starts with its hole shapes.
- **Solids and holes:** turn any shape into a hole, group it with others, and it cuts itself out.
- **Simple handles:** black squares resize, the cone lifts, and arrows turn. Everything follows the snap grid: 0.1 mm to 5 mm, inches, or Brick (8 mm studs, 3.2 mm plates).
- **Align, mirror, ruler, workplanes, hide and lock**, plus undo and redo.
- **Text** in several fonts, **scribble** drawing, and **SVG drawings** turned into 3D shapes.
- **Export** to STL, OBJ and GLB for 3D printing, or SVG for laser cutters.
- **Workspace settings:** background, shadows, grid, low power mode for older computers, camera speed, and millimetres or inches.
- Designs save themselves as you work. **Save** and **Open** use `.fiddlecraft` files.

## Download and run (Linux)

1. Download `FiddleCraft-<version>-x86_64.AppImage` from the Releases page.
2. Make it runnable once: right-click it, open Properties, and turn on "Allow executing as program". Or run `chmod +x FiddleCraft-*.AppImage`.
3. Double-click it.

Windows, macOS and Flatpak versions are planned.

## Build it yourself

You need [Node.js](https://nodejs.org/) 20 or newer.

```sh
npm install          # first time only
npm run build        # builds the 3D workspace into dist/

cd desktop
npm install          # first time only
npm run appimage     # makes desktop/release/FiddleCraft-<version>-x86_64.AppImage
```

## How it's made

- [three.js](https://threejs.org/) draws the 3D view.
- [three-bvh-csg](https://github.com/gkjohnson/three-bvh-csg) combines solids and holes.
- [opentype.js](https://opentype.js.org/) turns text into shapes.
- [Electron](https://www.electronjs.org/) wraps it as a desktop app.
- [Vite](https://vite.dev/) builds it.
- Fonts: IBM Plex Sans and IBM Plex Mono, Pacifico and Zilla Slab, all under the SIL Open Font License (see `public/fonts/OFL-LICENSE.txt`).

## Licence

FiddleCraft is released under the [MIT License](LICENSE).
