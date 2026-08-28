// The single catalog of dockerized demos. Four stacks, one shop.
// Both the launcher
// (tools/run-demo.mjs) and the container validator
// (tools/validate/check-demo-containers.mjs) read this list, so a demo added
// or renamed here is launchable and validated in the same change.

export const OPENRECEIVE_DEMOS = [
  {
    kind: "node",
    keys: ["node", "node-express", "express", "buttons-express"],
    dir: "examples/buttons/server/node-express",
    packageName: "@openreceive/example-buttons-node-express",
    service: "buttons-node-express",
    port: "3000",
    label: "Buy a Button — Express + React/Vue/Svelte/Angular",
  },
  {
    kind: "node",
    keys: ["static", "static-html-small-api", "html", "buttons-static"],
    dir: "examples/buttons/server/static-html-small-api",
    packageName: "@openreceive/example-buttons-static-html",
    service: "buttons-static-html-small-api",
    port: "3001",
    label: "Buy a Button — static HTML + small API",
  },
  {
    kind: "node",
    keys: ["nextjs", "next", "nextjs-fullstack", "buttons-nextjs"],
    dir: "examples/buttons/server/nextjs-fullstack",
    packageName: "@openreceive/example-buttons-nextjs-fullstack",
    service: "buttons-nextjs-fullstack",
    port: "3002",
    label: "Buy a Button — Next.js fullstack",
  },
  {
    kind: "rails",
    keys: ["buttons", "rails", "rails-fullstack"],
    dir: "examples/buttons/server/rails",
    // The shop UI, stores, wire types and seed catalog. Read by every stack;
    // the Dockerfile has to carry it into both build stages.
    sharedDir: "examples/buttons/shared",
    // The Shakapacker entry, the lib/ namespace, and the artwork directory the
    // Propshaft load path points at.
    packName: "buttons",
    libNamespace: "button_shop",
    imagesDir: "examples/buttons/images",
    packageName: "@openreceive/example-buttons-rails",
    service: "buttons-rails",
    notificationsService: "notifications",
    dbService: "db",
    port: "3003",
    label: "Buy a Button — Rails + Postgres",
  },
];
