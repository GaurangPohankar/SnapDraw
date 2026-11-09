import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * SnapDraw build layout (Manifest V3):
 *
 *   dist/manifest.json
 *   dist/icons/*.png                   (copied from public/)
 *   dist/excalidraw-asset-path.js      (classic script: local-only font base)
 *   dist/fonts/*                       (self-hosted Excalidraw fonts)
 *   dist/src/popup/popup.html          (action popup)
 *   dist/src/editor/editor.html        (editor tab)
 *   dist/background/service-worker.js  (ES module service worker)
 *   dist/assets/*                      (hashed JS / CSS chunks)
 */
export default defineConfig(({ mode }) => {
  const isDevelopment = mode === "development";

  return {
    plugins: [react()],
    base: "/",
    publicDir: "public",
    define: {
      // Excalidraw checks this at runtime; without it Vite builds fall back to a
      // bundled-but-unused React copy and can throw at startup.
      "process.env.IS_PREACT": JSON.stringify("false"),
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
      target: "chrome116",
      sourcemap: isDevelopment,
      minify: !isDevelopment,
      cssCodeSplit: true,
      chunkSizeWarningLimit: 8000,
      rollupOptions: {
        input: {
          popup: "src/popup/popup.html",
          editor: "src/editor/editor.html",
          video: "src/video/video.html",
          offscreen: "src/offscreen/offscreen.html",
          recorder: "src/recorder/recorder.html",
          background: "src/background/service-worker.ts",
        },
        output: {
          entryFileNames: (chunk) =>
            chunk.name === "background"
              ? "background/service-worker.js"
              : "assets/[name]-[hash].js",
          chunkFileNames: "assets/[name]-[hash].js",
          assetFileNames: "assets/[name]-[hash][extname]",
        },
      },
    },
    server: {
      port: 5173,
      strictPort: true,
    },
  };
});

