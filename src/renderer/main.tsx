import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./theme.css";
import "./styles.css";
import "./styles-panels.css";
import "./styles-draw.css";
import "./styles-trade.css";
import "./styles-rtl.css";
import "./styles-redesign.css";
import "./styles-redesign-fixes.css";
import { LanguageProvider } from "./i18n-context.js";

const el = document.getElementById("root");
if (!el) throw new Error("#root missing");
createRoot(el).render(
  <React.StrictMode>
    <LanguageProvider>
      <App />
    </LanguageProvider>
  </React.StrictMode>,
);
