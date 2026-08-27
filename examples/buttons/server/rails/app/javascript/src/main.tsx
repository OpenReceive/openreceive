import { createRoot } from "react-dom/client";
import { ShopApp } from "./ShopApp.tsx";

const renderFatal = (container: HTMLElement, error: unknown): void => {
  const message = error instanceof Error ? error.message : String(error);
  container.innerHTML = `
    <div style="font-family: system-ui, sans-serif; padding: 2rem; max-width: 640px; margin: 2rem auto; border-radius: 12px; border: 1px solid #ddd;">
      <h2 style="margin: 0 0 1rem; color: #b4322c;">Buy a Button — frontend failed to render</h2>
      <pre style="white-space: pre-wrap; font-size: 13px;">${message
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")}</pre>
    </div>`;
};

const initApp = (): void => {
  const container = document.getElementById("root");
  if (!container) return;
  try {
    createRoot(container).render(<ShopApp />);
  } catch (error) {
    console.error(error);
    renderFatal(container, error);
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
