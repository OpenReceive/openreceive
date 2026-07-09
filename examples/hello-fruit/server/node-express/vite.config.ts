import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";
import * as vueCompiler from "vue/compiler-sfc";
import { createHelloFruitServer } from "./src/server/create-server.ts";

export default defineConfig({
  build: {
    chunkSizeWarningLimit: 700
  },
  server: {
    fs: {
      allow: ["../../../.."]
    }
  },
  plugins: [
    tailwindcss(),
    vue({ compiler: vueCompiler }),
    svelte(),
    react(),
    {
      name: "openreceive-hello-fruit-api",
      async configureServer(server) {
        server.middlewares.use(await createHelloFruitServer());
      }
    }
  ]
});
