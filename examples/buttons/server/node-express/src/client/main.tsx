// Mantine's own stylesheet first, then ours — the same order every stack uses.
import "@mantine/core/styles.css";
import "../../../../shared/client/shop.css";
// Only the default (React) checkout styles load eagerly so the first paint is
// correct; each other framework's stylesheet loads with its tab. See App.tsx.
import "@openreceive/react/styles.css";

import { createRoot } from "react-dom/client";
import { ShopApp } from "./App.tsx";

const container = document.getElementById("root");
if (container) createRoot(container).render(<ShopApp />);
