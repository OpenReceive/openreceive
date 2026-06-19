import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { createHelloFruitServer } from "./src/server/create-server.js";

export default defineConfig({
  server: {
    fs: {
      allow: ["../.."]
    }
  },
  plugins: [
    react(),
    {
      name: "openreceive-hello-fruit-api",
      configureServer(server) {
        server.middlewares.use(createHelloFruitServer());
      }
    }
  ]
});
