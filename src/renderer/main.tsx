import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles.css";
import "./styles-panels.css";
import "./styles-draw.css";

const el = document.getElementById("root");
if (!el) throw new Error("#root missing");
createRoot(el).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
