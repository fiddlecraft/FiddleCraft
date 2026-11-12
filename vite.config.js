import { defineConfig } from "vite";

// FiddleCraft desktop: a single page, the 3D workspace.
export default defineConfig({
  build: {
    outDir: "dist",
    chunkSizeWarningLimit: 900,
  },
});
