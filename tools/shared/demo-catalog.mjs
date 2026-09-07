// The single catalog of dockerized demos. Five stacks, one shop.
// Both the launcher
// (tools/run-demo.mjs) and the container validator
// (tools/validate/check-demo-containers.mjs) read this list, so a demo added
// or renamed here is launchable and validated in the same change.

export const OPENRECEIVE_DEMOS = [
  {
    kind: "wordpress",
    keys: ["wordpress", "woocommerce", "wp"],
    dir: "examples/wordpress",
    service: "wordpress",
    dbService: "db",
    port: "3009",
    label: "Buy a Button — WordPress + WooCommerce",
  },
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
    kind: "node",
    keys: ["fastify", "buttons-fastify"],
    dir: "examples/buttons/server/fastify",
    packageName: "@openreceive/example-buttons-fastify",
    service: "buttons-fastify",
    port: "3004",
    label: "Buy a Button — Fastify + React",
  },
  {
    // The minimal Python host: FastAPI + SQLite, React only — the Fastify
    // twin. Vite is the dev front door (it spawns `uv run uvicorn` and
    // proxies the API paths); the container serves the built dist itself.
    kind: "python",
    keys: ["fastapi", "buttons-fastapi"],
    dir: "examples/buttons/server/fastapi",
    packageName: "@openreceive/example-buttons-fastapi",
    service: "buttons-fastapi",
    port: "3007",
    label: "Buy a Button — FastAPI + React",
  },
  {
    // Django + Postgres: the Rails demo's shape in Python — products, visitors
    // and orders on the ORM, the three hooks in buttonshop/openreceive_host.py,
    // the notifications worker as a second container. Vite is the dev front
    // door (it spawns `manage.py runserver` and proxies the API paths);
    // WhiteNoise serves the built dist in the container.
    kind: "python",
    keys: ["django", "buttons-django"],
    dir: "examples/buttons/server/django",
    sharedDir: "examples/buttons/shared",
    imagesDir: "examples/buttons/images",
    packageName: "@openreceive/example-buttons-django",
    service: "buttons-django",
    notificationsService: "notifications",
    dbService: "db",
    port: "3006",
    label: "Buy a Button — Django + Postgres",
  },
  {
    // Plain PHP: the vanilla shop as static files plus one front controller
    // over the PHP engine (packages/php/openreceive by path repository). Vite
    // is the dev front door (it spawns `php -S` and proxies the API paths);
    // the container runs `php -S` over the built public/ itself.
    kind: "php",
    keys: ["php-plain", "php", "buttons-php"],
    dir: "examples/buttons/server/php-plain",
    packageName: "@openreceive/example-buttons-php-plain",
    service: "buttons-php-plain",
    port: "3008",
    label: "Buy a Button — plain PHP",
  },
  {
    // Laravel 12 over the PHP engine (packages/php/openreceive + packages/php/laravel
    // by path repository), the Rails demo's shape: products, visitors, orders
    // and the three hooks in app/OpenReceive/Host.php. Laravel's own Vite is
    // the dev front door (it spawns `php artisan serve` and proxies the app's
    // paths); Apache serves the built public/build in the container.
    kind: "php",
    keys: ["laravel", "buttons-laravel"],
    dir: "examples/buttons/server/laravel",
    sharedDir: "examples/buttons/shared",
    imagesDir: "examples/buttons/images",
    packageName: "@openreceive/example-buttons-laravel",
    service: "buttons-laravel",
    notificationsService: "notifications",
    dbService: "db",
    port: "3005",
    label: "Buy a Button — Laravel + Postgres",
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
