/**
 * Chrome logs a Canvas2D advisory when a GPU-backed canvas is read back with
 * `getImageData()` several times:
 *
 *   "Canvas2D: Multiple readback operations using getImageData are faster
 *    with the willReadFrequently attribute set to true."
 *
 * Excalidraw's colour-picker eyedropper (Alt / the eyedropper button) reads one
 * pixel from its main `.excalidraw__canvas` on every `pointermove`, and the
 * canvas context is created by Excalidraw without `willReadFrequently` — see
 * `packages/excalidraw/components/EyeDropper.tsx` in the upstream repository.
 * The advisory is harmless, but it repeats for as long as the eyedropper is
 * open, which clutters the console during normal colour picking.
 *
 * The eyedropper only ever reads a tiny region (1×1 px). Route those reads
 * through a scratch canvas that *was* created with `willReadFrequently: true`:
 * the pixels are identical, the main interactive canvas keeps GPU acceleration,
 * and Chrome no longer reports the advisory. Larger reads (anything that could
 * belong to a different feature or a future Excalidraw version) fall through to
 * the untouched implementation.
 */

/** Largest read (in device pixels) that is safe to route through the shim. */
const SHIM_MAX_READ_AREA = 64;

/** Class Excalidraw puts on the canvases it renders with (see `App.tsx`). */
const EXCALIDRAW_CANVAS_CLASS = "excalidraw__canvas";

let installed = false;

function createScratchContext(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  scratchContexts: WeakMap<HTMLCanvasElement, CanvasRenderingContext2D>,
): CanvasRenderingContext2D | null {
  let context = scratchContexts.get(canvas);

  if (!context) {
    const scratchCanvas = document.createElement("canvas");
    const created = scratchCanvas.getContext("2d", { willReadFrequently: true });

    if (!created) {
      return null;
    }

    context = created;
    scratchContexts.set(canvas, context);
  }

  const scratchCanvas = context.canvas;

  // Resizing clears the canvas; the caller clears it again before drawing.
  if (scratchCanvas.width < width) {
    scratchCanvas.width = width;
  }

  if (scratchCanvas.height < height) {
    scratchCanvas.height = height;
  }

  return context;
}

/**
 * Installs the readback shim once per page. Safe to call when browser canvas
 * APIs are unavailable (e.g. in unit tests): it becomes a no-op.
 *
 * @returns whether the shim is active on this page.
 */
export function installCanvasReadbackShim(): boolean {
  if (installed) {
    return true;
  }

  if (
    typeof CanvasRenderingContext2D === "undefined" ||
    typeof HTMLCanvasElement === "undefined" ||
    typeof document === "undefined"
  ) {
    return false;
  }

  const originalGetImageData = CanvasRenderingContext2D.prototype.getImageData;
  const scratchContexts = new WeakMap<HTMLCanvasElement, CanvasRenderingContext2D>();

  CanvasRenderingContext2D.prototype.getImageData = function getImageData(
    this: CanvasRenderingContext2D,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    settings?: ImageDataSettings,
  ): ImageData {
    const sourceCanvas = this.canvas;

    if (
      !(sourceCanvas instanceof HTMLCanvasElement) ||
      !sourceCanvas.classList.contains(EXCALIDRAW_CANVAS_CLASS) ||
      sw <= 0 ||
      sh <= 0 ||
      sw * sh > SHIM_MAX_READ_AREA ||
      sx < 0 ||
      sy < 0 ||
      sx + sw > sourceCanvas.width ||
      sy + sh > sourceCanvas.height
    ) {
      return originalGetImageData.call(this, sx, sy, sw, sh, settings);
    }

    try {
      const scratch = createScratchContext(
        sourceCanvas,
        Math.ceil(sw),
        Math.ceil(sh),
        scratchContexts,
      );

      if (!scratch) {
        return originalGetImageData.call(this, sx, sy, sw, sh, settings);
      }

      scratch.clearRect(0, 0, scratch.canvas.width, scratch.canvas.height);
      scratch.drawImage(sourceCanvas, sx, sy, sw, sh, 0, 0, sw, sh);

      return scratch.getImageData(0, 0, sw, sh, settings);
    } catch {
      // Never break the caller: fall back to the native readback.
      return originalGetImageData.call(this, sx, sy, sw, sh, settings);
    }
  };

  installed = true;

  return true;
}
