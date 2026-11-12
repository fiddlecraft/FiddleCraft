// Copies the built website (../dist) into web/ so the desktop app carries it inside,
// and copies the app icon into build/ for the AppImage.
const fs = require("node:fs");
const path = require("node:path");

const here = __dirname;
const dist = path.join(here, "..", "dist");
const web = path.join(here, "web");
if (!fs.existsSync(path.join(dist, "index.html"))) {
  console.error("Build the website first: run `npm run build` in the app folder.");
  process.exit(1);
}
fs.rmSync(web, { recursive: true, force: true });
fs.cpSync(dist, web, { recursive: true });
fs.mkdirSync(path.join(here, "build"), { recursive: true });
fs.copyFileSync(path.join(here, "..", "public", "icons", "icon-512.png"), path.join(here, "build", "icon.png"));
console.log("Copied the website into", web);
