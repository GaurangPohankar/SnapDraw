/**
 * Copies Excalidraw's bundled fonts into `public/fonts` so the extension
 * self-hosts every asset. No CDN request is made at runtime – the editor sets
 * `window.EXCALIDRAW_ASSET_PATH` to the extension origin before Excalidraw
 * boots (see `public/excalidraw-asset-path.js`).
 */
import { cp, mkdir, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const source = path.join(
  root,
  "node_modules",
  "@excalidraw",
  "excalidraw",
  "dist",
  "prod",
  "fonts",
);
const target = path.join(root, "public", "fonts");

async function folderIsPopulated(directory) {
  try {
    const entries = await readdir(directory);
    return entries.length > 0;
  } catch {
    return false;
  }
}

async function main() {
  if (!existsSync(source)) {
    console.error(
      `[copy-fonts] Excalidraw fonts not found at ${source}.\n` +
        "Run `npm install` before building.",
    );
    process.exitCode = 1;
    return;
  }

  if (await folderIsPopulated(target)) {
    console.log("[copy-fonts] public/fonts already populated – skipping.");
    return;
  }

  await mkdir(path.dirname(target), { recursive: true });
  await cp(source, target, { recursive: true });

  const files = await readdir(target, { recursive: true });
  let bytes = 0;
  for (const file of files) {
    try {
      const info = await stat(path.join(target, file));
      if (info.isFile()) {
        bytes += info.size;
      }
    } catch {
      // Ignore transient entries.
    }
  }

  console.log(
    `[copy-fonts] Self-hosted Excalidraw fonts -> public/fonts (${files.length} files, ${(
      bytes / 1024 / 1024
    ).toFixed(1)} MB).`,
  );
}

await main();

