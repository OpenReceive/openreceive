import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { createHelloFruitStaticServer } from "./src/server/create-server.ts";

export default defineConfig({
  server: {
    fs: {
      allow: ["../../../.."]
    }
  },
  plugins: [
    tailwindcss(),
    {
      name: "openreceive-hello-fruit-static-api",
      async configureServer(server) {
        server.middlewares.use(await createHelloFruitStaticServer());
      }
    }
  ]
});
