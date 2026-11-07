/** Removes build output (never touches sources). */
import { rm, stat } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

const targets = [path.join(root, "dist")];

for (const target of targets) {
  if (!(await exists(target))) {
    console.log(`[clean] ${path.relative(root, target)} does not exist – nothing to do.`);
    continue;
  }
  await rm(target, { recursive: true, force: true });
  console.log(`[clean] removed ${path.relative(root, target)}`);
}
