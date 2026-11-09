import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The readback shim touches DOM canvas APIs that Node does not provide, so the
 * tests stub just enough of the platform: a canvas class, its 2D context and
 * `document.createElement("canvas")` for the scratch canvas.
 */

interface FakeContext {
  canvas: FakeCanvas;
  clearRect: ReturnType<typeof vi.fn>;
  drawImage: ReturnType<typeof vi.fn>;
  getImageData: ReturnType<typeof vi.fn>;
}

class FakeCanvas {
  width = 300;
  height = 150;
  contextOptions: { willReadFrequently?: boolean } | undefined;
  readonly classList: { contains: (name: string) => boolean };
  context: FakeContext | null = null;

  constructor(readonly classes: string[] = []) {
    this.classList = {
      contains: (name: string) => this.classes.includes(name),
    };
  }

  getContext(
    _type: string,
    options?: { willReadFrequently?: boolean },
  ): FakeContext {
    if (!this.context) {
      this.contextOptions = options;
      this.context = {
        canvas: this,
        clearRect: vi.fn(),
        drawImage: vi.fn(),
        getImageData: vi.fn(() => ({ marker: "scratch" })),
      };
    }

    return this.context;
  }
}

class FakeCanvasContext {
  canvas: FakeCanvas = new FakeCanvas();
}

let nativeReadback: ReturnType<typeof vi.fn>;
let scratchCanvases: FakeCanvas[];

function sourceContext(canvas: FakeCanvas): FakeCanvasContext {
  const context = Object.create(
    FakeCanvasContext.prototype,
  ) as FakeCanvasContext;
  context.canvas = canvas;
  return context;
}

async function loadShimModule() {
  vi.resetModules();
  return await import("../src/utils/canvas-readback");
}

beforeEach(() => {
  nativeReadback = vi.fn(() => ({ marker: "native" }));
  (
    FakeCanvasContext.prototype as unknown as {
      getImageData: typeof nativeReadback;
    }
  ).getImageData = nativeReadback;

  scratchCanvases = [];

  vi.stubGlobal("CanvasRenderingContext2D", FakeCanvasContext);
  vi.stubGlobal("HTMLCanvasElement", FakeCanvas);
  vi.stubGlobal("document", {
    createElement: vi.fn(() => {
      const canvas = new FakeCanvas();
      scratchCanvases.push(canvas);
      return canvas as unknown as HTMLCanvasElement;
    }),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("installCanvasReadbackShim", () => {
  it("is a no-op when the browser canvas APIs are unavailable", async () => {
    vi.stubGlobal("CanvasRenderingContext2D", undefined);
    vi.stubGlobal("HTMLCanvasElement", undefined);
    vi.stubGlobal("document", undefined);

    const { installCanvasReadbackShim } = await loadShimModule();

    expect(installCanvasReadbackShim()).toBe(false);
  });

  it("routes tiny reads on an Excalidraw canvas through a willReadFrequently scratch canvas", async () => {
    const { installCanvasReadbackShim } = await loadShimModule();
    expect(installCanvasReadbackShim()).toBe(true);

    const source = new FakeCanvas(["excalidraw__canvas", "interactive"]);
    source.width = 400;
    source.height = 300;
    const context = sourceContext(source);

    const result = (
      context as unknown as {
        getImageData: (
          sx: number,
          sy: number,
          sw: number,
          sh: number,
        ) => { marker: string };
      }
    ).getImageData(10, 12, 1, 1);

    expect(result).toEqual({ marker: "scratch" });
    expect(nativeReadback).not.toHaveBeenCalled();
    expect(scratchCanvases).toHaveLength(1);

    const scratch = scratchCanvases[0];
    expect(scratch.contextOptions).toEqual({ willReadFrequently: true });
    expect(scratch.context?.drawImage).toHaveBeenCalledWith(
      source,
      10,
      12,
      1,
      1,
      0,
      0,
      1,
      1,
    );
    expect(scratch.context?.getImageData).toHaveBeenCalledWith(
      0,
      0,
      1,
      1,
      undefined,
    );
  });

  it("leaves large reads, out-of-bounds reads and other canvases untouched", async () => {
    const { installCanvasReadbackShim } = await loadShimModule();
    installCanvasReadbackShim();

    const excalidrawCanvas = new FakeCanvas(["excalidraw__canvas"]);
    excalidrawCanvas.width = 400;
    excalidrawCanvas.height = 300;
    const excalidrawContext = sourceContext(excalidrawCanvas) as unknown as {
      getImageData: (...args: number[]) => unknown;
    };

    excalidrawContext.getImageData(0, 0, 100, 100);
    excalidrawContext.getImageData(399, 299, 2, 2);
    excalidrawContext.getImageData(0, 0, 0, 0);

    const otherCanvas = new FakeCanvas(["canvas"]);
    const otherContext = sourceContext(otherCanvas) as unknown as {
      getImageData: (...args: number[]) => unknown;
    };
    otherContext.getImageData(0, 0, 1, 1);

    expect(nativeReadback).toHaveBeenCalledTimes(4);
    expect(scratchCanvases).toHaveLength(0);
  });

  it("reuses one scratch canvas and is idempotent", async () => {
    const { installCanvasReadbackShim } = await loadShimModule();
    expect(installCanvasReadbackShim()).toBe(true);
    expect(installCanvasReadbackShim()).toBe(true);

    const source = new FakeCanvas(["excalidraw__canvas"]);
    source.width = 400;
    source.height = 300;
    const context = sourceContext(source) as unknown as {
      getImageData: (sx: number, sy: number, sw: number, sh: number) => unknown;
    };

    context.getImageData(1, 1, 1, 1);
    context.getImageData(2, 2, 1, 1);
    context.getImageData(3, 3, 2, 2);

    expect(scratchCanvases).toHaveLength(1);
    expect(nativeReadback).not.toHaveBeenCalled();
    expect(scratchCanvases[0].contextOptions).toEqual({
      willReadFrequently: true,
    });
  });
});
