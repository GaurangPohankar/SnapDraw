/**
 * Video editor tab entry point.
 *
 * Import order matters: the foundation styles must load before the Excalidraw
 * and editor styles. The self-hosted font base URL is set by the classic
 * `/excalidraw-asset-path.js` script in `video.html`, which by spec runs before
 * this module (and therefore before Excalidraw initialises).
 */
import "../styles/global.css";
import "@excalidraw/excalidraw/index.css";
import "../editor/editor.css";
import "./video.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { installCanvasReadbackShim } from "../utils/canvas-readback";
import { VideoEditor } from "./VideoEditor";

// Excalidraw's eyedropper reads pixels from its main canvas; route those tiny
// reads through a `willReadFrequently` scratch canvas so Chrome doesn't log its
// Canvas2D advisory every time the eyedropper moves.
installCanvasReadbackShim();

const rootElement = document.getElementById("root");

if (rootElement) {
  createRoot(rootElement).render(
    <StrictMode>
      <VideoEditor />
    </StrictMode>,
  );
}
