import {
  addComponent,
  addServerHandler,
  addTemplate,
  createResolver,
  defineNuxtModule,
  findPath,
  useLogger,
} from "@nuxt/kit";

// @openreceive/nuxt — registers what the Nuxt recipe had the developer write
// by hand: the catch-all server route over @openreceive/http, and the
// checkout component from @openreceive/vue with its stylesheet. The app keeps
// its own hooks and database handle in server/openreceive.ts (see
// @openreceive/nuxt/server). No payment logic lives here.
//
// tools/validate/check-public-api.mjs pins this surface.

export interface ModuleOptions {
  /**
   * Where the payment routes are mounted. The checkout component uses the
   * same prefix. Default `/openreceive`.
   */
  prefix: string;
  /**
   * The file with the app's hooks, relative to the project root, without its
   * extension. Default `server/openreceive` (`.ts`, `.mjs` or `.js`).
   */
  config: string;
  /** Add `@openreceive/vue/styles.css` to every page. Default `true`. */
  css: boolean;
}

const DOCS = "https://openreceive.org/integrations/nuxt";

function normalizePrefix(prefix: string): string {
  const trimmed = `/${prefix}`.replace(/\/+/g, "/").replace(/\/$/, "");
  if (trimmed === "" || !/^\/[A-Za-z0-9._~/-]+$/.test(trimmed)) {
    throw new Error(
      `@openreceive/nuxt: openreceive.prefix must be a URL path like "/openreceive" (got ${JSON.stringify(prefix)}).`,
    );
  }
  return trimmed;
}

export default defineNuxtModule<ModuleOptions>({
  meta: {
    name: "@openreceive/nuxt",
    configKey: "openreceive",
    compatibility: { nuxt: "^4.0.0" },
    docs: DOCS,
  },
  defaults: {
    prefix: "/openreceive",
    config: "server/openreceive",
    css: true,
  },
  async setup(options, nuxt) {
    const logger = useLogger("@openreceive/nuxt");
    const resolver = createResolver(import.meta.url);
    const prefix = normalizePrefix(options.prefix);

    // Build-time options for both the route and the component, one file.
    const optionsTemplate = addTemplate({
      filename: "openreceive/options.mjs",
      write: true,
      getContents: () => `export default ${JSON.stringify({ prefix })};\n`,
    });
    nuxt.options.alias["#openreceive/options"] = optionsTemplate.dst;

    // The runtime files import those aliases, so Vite and Nitro must compile
    // them rather than load them as prebuilt dependencies (Nuxt hands
    // build.transpile to Nitro's inline list too).
    const runtimeDir = resolver.resolve("./runtime");
    nuxt.options.build.transpile.push(runtimeDir);

    if (options.css) nuxt.options.css.push("@openreceive/vue/styles.css");

    addComponent({
      name: "OpenReceiveCheckout",
      export: "default",
      filePath: resolver.resolve("./runtime/checkout"),
    });

    const configPath = await findPath(options.config, {
      cwd: nuxt.options.rootDir,
      extensions: [".ts", ".mts", ".mjs", ".js"],
    });
    if (configPath === null) {
      logger.warn(
        `No ${options.config}.ts yet, so the payment routes under ${prefix} are not mounted. ` +
          `Create it with your authorize, amountFor and onPaid hooks: ${DOCS}`,
      );
      return;
    }

    // Server only: the hooks and the database handle stay out of the browser.
    // (Nitro's own config type comes with nitropack, which this package does
    // not depend on; `alias` is a plain map there.)
    nuxt.hook("nitro:config", (nitro) => {
      const config = nitro as { alias?: Record<string, string> };
      config.alias = { ...config.alias, "#openreceive/config": configPath };
    });

    addServerHandler({
      route: `${prefix}/**`,
      handler: resolver.resolve("./runtime/handler"),
    });
  },
});

declare module "@nuxt/schema" {
  interface NuxtConfig {
    openreceive?: Partial<ModuleOptions>;
  }
  interface NuxtOptions {
    openreceive?: ModuleOptions;
  }
}
