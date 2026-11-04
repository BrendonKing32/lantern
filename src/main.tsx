import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { startSync } from "./sync";
import { initTheme } from "./theme";
import "./styles.css";

initTheme();
startSync();

// The service worker keeps the app itself on this device so it opens offline.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
