#!/usr/bin/env node

// The umbrella owns this command so `npm install openreceive` provides it under
// package managers that never hoist a transitive dependency's bin (pnpm, Yarn
// PnP). @openreceive/node implements the CLI; this executes its real bin file
// (env loading included) instead of carrying a copy of it.
await import(new URL("../bin/openreceive.mjs", import.meta.resolve("@openreceive/node/cli")));
