import { defineConfig } from "vite";
import { createHelloFruitStaticServer } from "./src/server/create-server.ts";

export default defineConfig({
  server: {
    fs: {
      allow: ["../../../.."]
    }
  },
  plugins: [
    {
      name: "openreceive-hello-fruit-static-api",
      configureServer(server) {
        server.middlewares.use(createHelloFruitStaticServer());
      }
    }
  ]
});
