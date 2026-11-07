import "../styles/global.css";
import "./recorder.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RecorderPage } from "./RecorderPage";

const rootElement = document.getElementById("root");

if (rootElement) {
  createRoot(rootElement).render(
    <StrictMode>
      <RecorderPage />
    </StrictMode>,
  );
}
