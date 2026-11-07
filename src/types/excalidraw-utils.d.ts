/**
 * The published `@excalidraw/excalidraw` types re-export their export helpers
 * from `@excalidraw/utils/export`, but that package is not published to npm.
 * This ambient module keeps TypeScript happy while the real implementation is
 * bundled inside `@excalidraw/excalidraw` itself.
 */
declare module "@excalidraw/utils/export" {
  export function exportToBlob(opts: {
    elements: readonly unknown[];
    appState?: unknown;
    files: unknown;
    mimeType?: string;
    quality?: number;
    exportPadding?: number;
    exportScale?: number;
    maxWidthOrHeight?: number;
  }): Promise<Blob>;

  export function exportToCanvas(opts: {
    elements: readonly unknown[];
    appState?: unknown;
    files: unknown;
    exportPadding?: number;
    maxWidthOrHeight?: number;
  }): Promise<HTMLCanvasElement>;

  export function exportToSvg(
    opts: unknown,
  ): Promise<SVGSVGElement>;

  export function exportToClipboard(opts: unknown): Promise<void>;
}
