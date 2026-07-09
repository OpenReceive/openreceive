import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { createHelloFruitStaticServer } from "./src/server/create-server.ts";

export default defineConfig({
  server: {
    fs: {
      allow: ["../../../.."]
    },
    // SQLite WAL/SHM under .openreceive must not trigger full page reloads mid-checkout.
    watch: {
      ignored: ["**/.openreceive/**"]
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
