import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../styles/global.css";
import "./popup.css";
import { Popup } from "./Popup";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("SnapDraw popup could not find its #root element.");
}

createRoot(rootElement).render(
  <StrictMode>
    <Popup />
  </StrictMode>,
);
