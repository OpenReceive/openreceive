// Mantine's own stylesheet first, then ours — shop.css overrides nothing of
// Mantine's, but the cascade should read in that order anyway.
//
// There is no PostCSS preset here on purpose: @mantine/core ships prebuilt CSS,
// and shop.css is plain CSS with five custom properties. postcss-preset-mantine
// is only needed to author styles with Mantine's mixins.
import "@mantine/core/styles.css";
import "../../../../../shared/client/shop.css";
import "../src/main.tsx";
