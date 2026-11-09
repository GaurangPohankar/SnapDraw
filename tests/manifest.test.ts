/**
 * Static invariants for the shipped extension manifest.
 *
 * These checks mirror what Chrome (and the project's build validator) require:
 * Manifest V3, minimal permissions, local-only CSP, declared entry points and
 * real PNG icons. They read the source tree, not `dist/`.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

interface ManifestCommand {
  suggested_key?: { default?: string; mac?: string };
  description?: string;
}

interface ManifestJson {
  manifest_version: number;
  name: string;
  version: string;
  action: {
    default_title?: string;
    default_popup?: string;
    default_icon?: Record<string, string>;
  };
  icons: Record<string, string>;
  background: { service_worker: string; type?: string };
  commands: Record<string, ManifestCommand>;
  permissions: string[];
  host_permissions?: string[];
  content_scripts?: unknown[];
  content_security_policy: { extension_pages: string };
}

const manifest = JSON.parse(
  readFileSync(join(ROOT, "public", "manifest.json"), "utf8"),
) as ManifestJson;

function repoFile(relativePath: string): string {
  return join(ROOT, relativePath);
}

function publicFile(relativePath: string): string {
  return join(ROOT, "public", relativePath);
}

function hasPngMagicBytes(filePath: string): boolean {
  const header = readFileSync(filePath).subarray(0, 4);
  return (
    header[0] === 0x89 &&
    header[1] === 0x50 && // "P"
    header[2] === 0x4e && // "N"
    header[3] === 0x47 // "G"
  );
}

describe("public/manifest.json", () => {
  it("is a Manifest V3 manifest for SnapDraw with a semver version", () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.name).toBe("SnapDraw");
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.background.type).toBe("module");
  });

  it("references the popup and editor pages that exist in the source tree", () => {
    expect(manifest.action.default_popup).toBe("src/popup/popup.html");
    expect(existsSync(repoFile("src/popup/popup.html"))).toBe(true);
    // The editor page is a Vite build input (not a manifest entry) and is
    // emitted to dist/src/editor/editor.html.
    expect(existsSync(repoFile("src/editor/editor.html"))).toBe(true);
  });

  it("declares the service worker emitted by the build", () => {
    expect(manifest.background.service_worker).toBe(
      "background/service-worker.js",
    );
    expect(existsSync(repoFile("src/background/service-worker.ts"))).toBe(true);
  });

  it("requests exactly the minimal capture/recording permissions", () => {
    expect(manifest.permissions).toEqual([
      "activeTab",
      "clipboardWrite",
      "offscreen",
      "tabCapture",
    ]);
    expect([...manifest.permissions].sort()).toEqual(manifest.permissions);
  });

  it("requests no host permissions and injects no content scripts", () => {
    expect(
      Object.prototype.hasOwnProperty.call(manifest, "host_permissions"),
    ).toBe(false);
    expect(
      Object.prototype.hasOwnProperty.call(manifest, "content_scripts"),
    ).toBe(false);
  });

  it("declares the capture-screenshot command with a suggested key", () => {
    const command = manifest.commands["capture-screenshot"];

    expect(command).toBeDefined();
    expect(command.description?.trim().length ?? 0).toBeGreaterThan(0);
    expect(command.suggested_key).toEqual({
      default: "Ctrl+Shift+S",
      mac: "Command+Shift+S",
    });
  });

  it("keeps the extension pages local-only in the CSP", () => {
    const csp = manifest.content_security_policy.extension_pages;

    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toMatch(/https?:\/\//);
  });

  it("references icon files that exist and are real PNGs", () => {
    const iconPaths = new Set([
      ...Object.values(manifest.icons),
      ...Object.values(manifest.action.default_icon ?? {}),
    ]);

    expect(iconPaths.size).toBeGreaterThan(0);
    expect(Object.keys(manifest.icons).sort()).toEqual(["128", "16", "48"]);
    expect(manifest.action.default_icon).toEqual(manifest.icons);

    for (const iconPath of iconPaths) {
      expect(iconPath).toMatch(/^icons\/icon(16|48|128)\.png$/);
      const filePath = publicFile(iconPath);
      expect(existsSync(filePath)).toBe(true);
      expect(statSync(filePath).size).toBeGreaterThan(0);
      expect(hasPngMagicBytes(filePath)).toBe(true);
    }
  });
});
