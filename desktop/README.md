# FiddleCraft desktop app

The desktop app is the FiddleCraft 3D workspace in its own window, working fully offline.

## Run it

1. Find `release/FiddleCraft-0.3.2-x86_64.AppImage`.
2. Make it runnable once: right-click → Properties → "Allow executing as program", or `chmod +x FiddleCraft-0.3.2-x86_64.AppImage`.
3. Double-click it, or run `./FiddleCraft-0.3.2-x86_64.AppImage`.

Designs are kept between sessions automatically. Use **Save** (Ctrl+S) and **Open** (Ctrl+O) for `.fiddlecraft` design files (older `.shapeforge` files open too), and **Export for 3D printing** for STL files.
To open a design file straight from the file manager, run the AppImage with the file: `./FiddleCraft-0.3.2-x86_64.AppImage my-design.fiddlecraft`.

## Build it again

From the `app` folder:

```
npm run build            # builds the 3D workspace into dist/
cd desktop
npm install              # first time only
npm run appimage         # copies dist/ into the app and makes release/*.AppImage
npm run dist:linux       # also deb, rpm and Flatpak; dist:win and dist:mac for the other systems
```

Self-test without showing a window: `SHAPEFORGE_SELFTEST=1 ./release/FiddleCraft-0.3.2-x86_64.AppImage`
