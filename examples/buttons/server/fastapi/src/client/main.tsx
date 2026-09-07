// Mantine's own stylesheet first, then ours — the same order every stack uses.
import "@mantine/core/styles.css";
import "../../../../shared/shop.css";
import "@openreceive/react/styles.css";

import { createRoot } from "react-dom/client";
import { ShopApp } from "./App.tsx";

const container = document.getElementById("root");
if (container) createRoot(container).render(<ShopApp />);
