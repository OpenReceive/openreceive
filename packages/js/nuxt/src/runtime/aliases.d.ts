// The two aliases the module sets. `#openreceive/config` is the app's
// server/openreceive.ts (Nitro only); `#openreceive/options` is a file the
// module writes into .nuxt/ with the build-time options.
declare module "#openreceive/config" {
  import type { OpenReceiveNuxtConfig } from "../server.ts";
  const config: OpenReceiveNuxtConfig;
  export default config;
}

declare module "#openreceive/options" {
  const options: { readonly prefix: string };
  export default options;
}
