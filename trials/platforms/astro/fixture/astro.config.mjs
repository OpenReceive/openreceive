// @ts-check
import node from "@astrojs/node";
import { defineConfig, envField } from "astro/config";

// https://astro.build/config
export default defineConfig({
  // Pages are static unless they export `prerender = false`.
  adapter: node({ mode: "standalone" }),
  env: {
    schema: {
      DATABASE_URL: envField.string({ context: "server", access: "secret" }),
    },
  },
});
