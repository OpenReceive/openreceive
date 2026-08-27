import { createTheme, type MantineColorsTuple } from "@mantine/core";

/**
 * OpenReceive green, as a Mantine ten-step tuple.
 *
 * THE BRIDGE between this and shop.css is by hand: `--or-accent` in the
 * stylesheet is `orGreen[7]` here, and nothing links them automatically.
 * Change one and you must change the other, or the CSS borders stop matching
 * the buttons.
 */
const orGreen: MantineColorsTuple = [
  "#eaf8ef",
  "#d3f0de",
  "#a8e0be",
  "#74cc98",
  "#4db978",
  "#38b46b",
  "#2c9a58",
  "#20824a",
  "#1a6b3e",
  "#145533",
];

/**
 * `cursorType: "pointer"` is why every interactive Mantine element gets a hand
 * cursor with no CSS of ours. `black` matches `--or-ink`.
 *
 * THERE IS NO DARK MODE, and adding one is not in scope: shop.css hard-codes
 * `background: #fff` in several places. A later dark mode turns every one of
 * those literals into a variable FIRST, then adds a
 * `[data-mantine-color-scheme="dark"]` token block. Piecemeal dark styles will
 * look half-converted.
 */
export const shopTheme = createTheme({
  primaryColor: "orGreen",
  colors: { orGreen },
  fontFamily:
    'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  headings: { fontWeight: "800" },
  defaultRadius: "md",
  black: "#17231f",
  white: "#ffffff",
  cursorType: "pointer",
});
