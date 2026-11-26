import config from "#openreceive/config";
import options from "#openreceive/options";
import { defineEventHandler } from "h3";
import { createOpenReceiveEventHandler } from "./stack.ts";

// Mounted by the module at `<prefix>/**`, for every method. `#openreceive/config`
// is the app's server/openreceive.ts, aliased for Nitro only, so the hooks and
// the database handle never reach the browser bundle.
const handle = createOpenReceiveEventHandler(config, { prefix: options.prefix });

export default defineEventHandler((event) => handle(event));
