import "@fontsource-variable/instrument-sans";
import "@fontsource-variable/newsreader";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { initializeAnalytics } from "./analytics.js";
import "./styles.css";

initializeAnalytics();

const root = document.getElementById("root");
if (!root) throw new Error("Radar root element was not found.");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
