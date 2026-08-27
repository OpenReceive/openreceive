// The single catalog of dockerized demos. Both the launcher
// (tools/run-demo.mjs) and the container validator
// (tools/validate/check-demo-containers.mjs) read this list, so a demo added
// or renamed here is launchable and validated in the same change.

export const OPENRECEIVE_DEMOS = [
  {
    kind: "node",
    keys: ["node", "node-express", "express"],
    dir: "examples/hello-fruit/server/node-express",
    packageName: "@openreceive/example-node-express",
    service: "hello-fruit-node-express",
    port: "3000",
    label: "Express + React/Vue/Svelte/Angular",
  },
  {
    kind: "node",
    keys: ["static", "static-html-small-api", "html"],
    dir: "examples/hello-fruit/server/static-html-small-api",
    packageName: "@openreceive/example-static-html-small-api",
    service: "hello-fruit-static-html-small-api",
    port: "3001",
    label: "Static HTML + small API",
  },
  {
    kind: "node",
    keys: ["nextjs", "next", "nextjs-fullstack"],
    dir: "examples/hello-fruit/server/nextjs-fullstack",
    packageName: "@openreceive/example-nextjs-fullstack",
    service: "hello-fruit-nextjs-fullstack",
    port: "3002",
    label: "Next.js fullstack",
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
