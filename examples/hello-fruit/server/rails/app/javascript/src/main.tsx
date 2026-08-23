import { createRoot } from "react-dom/client";
import AppContainer from "./AppContainer.tsx";

const renderFatal = (container: HTMLElement, err: unknown): void => {
  const message = err instanceof Error ? err.message : String(err);
  container.innerHTML = `
    <div style="font-family: system-ui, sans-serif; padding: 2rem; max-width: 640px; margin: 2rem auto; border-radius: 12px; border: 1px solid #ddd;">
      <h2 style="margin: 0 0 1rem; color: #b42318;">Hello Fruit — frontend failed to render</h2>
      <pre style="white-space: pre-wrap; font-size: 13px;">${message
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")}</pre>
    </div>`;
};

const initApp = (): void => {
  const container = document.getElementById("root");
  if (!container) return;
  try {
    createRoot(container).render(<AppContainer />);
  } catch (err) {
    console.error(err);
    renderFatal(container, err);
  }
};

window.addEventListener("error", (event) => {
  const container = document.getElementById("root");
  if (container && !container.hasChildNodes()) renderFatal(container, event.error || event.message);
});

window.addEventListener("unhandledrejection", (event) => {
  console.error("unhandledrejection", event.reason);
});

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initApp);
} else {
  initApp();
}
