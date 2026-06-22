import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { createHelloFruitServer } from "./src/server/create-server.ts";

export default defineConfig({
  server: {
    fs: {
      allow: ["../../../.."]
    }
  },
  plugins: [
    react(),
    {
      name: "openreceive-hello-fruit-api",
      async configureServer(server) {
        server.middlewares.use(await createHelloFruitServer());
      }
    }
  ]
});
