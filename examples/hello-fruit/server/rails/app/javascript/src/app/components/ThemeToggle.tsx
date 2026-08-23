import { createThemeToggleElement } from "@openreceive/elements";
import { observer } from "mobx-react";
import type React from "react";
import { useEffect, useRef } from "react";

/**
 * Port of the vanilla renderThemeToggle(): mounts the OpenReceive
 * theme-toggle custom element into the topbar via a ref.
 */
const ThemeToggle: React.FC = observer(() => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    container.replaceChildren(
      createThemeToggleElement({
        document,
        rootSelector: ".page",
        checkoutSelector: ".demo-checkout",
        defaultTheme: "light",
      }),
    );
    return () => {
      container.replaceChildren();
    };
  }, []);

  return <div ref={containerRef} />;
});

export default ThemeToggle;
