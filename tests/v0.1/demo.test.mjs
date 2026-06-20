import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { createHelloFruitServer } from "../../examples/hello-fruit/server/node-express-react/src/server/create-server.ts";
import { createHelloFruitProductionServer } from "../../examples/hello-fruit/server/node-express-react/src/server/production.ts";
import { createHelloFruitStaticServer } from "../../examples/hello-fruit/server/static-html-small-api/src/server/create-server.ts";
import { createHelloFruitStaticProductionServer } from "../../examples/hello-fruit/server/static-html-small-api/src/server/production.ts";
import { quoteFiatToMsats } from "../../packages/js/core/src/index.ts";
import { GET as getNextCapabilities } from "../../examples/hello-fruit/server/nextjs-fullstack/src/app/openreceive/v1/capabilities/route.ts";
import { POST as postNextInvoice } from "../../examples/hello-fruit/server/nextjs-fullstack/src/app/openreceive/v1/invoices/route.ts";
import { GET as getNextOpenReceiveHealth } from "../../examples/hello-fruit/server/nextjs-fullstack/src/app/openreceive/v1/health/route.ts";
import { GET as getNextDemoMetadata } from "../../examples/hello-fruit/server/nextjs-fullstack/src/app/demo-metadata.json/route.ts";
import { GET as getNextDocs } from "../../examples/hello-fruit/server/nextjs-fullstack/src/app/docs/route.ts";
import { GET as getNextHealthz } from "../../examples/hello-fruit/server/nextjs-fullstack/src/app/healthz/route.ts";
import { GET as getNextSource } from "../../examples/hello-fruit/server/nextjs-fullstack/src/app/source/route.ts";
import getNextRobots, { dynamic as nextRobotsDynamic } from "../../examples/hello-fruit/server/nextjs-fullstack/src/app/robots.ts";
import getNextSitemap, { dynamic as nextSitemapDynamic } from "../../examples/hello-fruit/server/nextjs-fullstack/src/app/sitemap.ts";

const productPath = path.join(
  process.cwd(),
  "examples/hello-fruit/shared/product.json"
);
const fruitsPath = path.join(
  process.cwd(),
  "examples/hello-fruit/shared/fruits.json"
);
const canonicalDemoDataPath = path.join(
  process.cwd(),
  "spec/data/demo/fruits.json"
);
const demoServerDirs = [
  "examples/hello-fruit/server/node-express-react",
  "examples/hello-fruit/server/static-html-small-api",
  "examples/hello-fruit/server/nextjs-fullstack"
];

test("Hello Fruit shared product keeps demo invoices low-value", () => {
  const product = JSON.parse(readFileSync(productPath, "utf8"));
  const fruits = JSON.parse(readFileSync(fruitsPath, "utf8"));

  assert.equal(product.schema_version, "0.1.0");
  assert.equal(product.name, "OpenReceive Demo: Buy A Fruit Sticker");
  assert.equal(product.description, "get a fruit sticker");
  assert.equal(product.invoice_expiry_seconds, 600);

  assert.deepEqual(
    fruits.fruits.map((fruit) => [fruit.id, fruit.fiat.currency, fruit.fiat.value]),
    [
      ["apple", "USD", "0.05"],
      ["banana", "USD", "0.10"],
      ["orange", "USD", "0.15"],
      ["pear", "USD", "0.20"]
    ]
  );
  assert.deepEqual(
    fruits.fruits.map((fruit) => quoteFiatToMsats({ fiat: fruit.fiat }).amount_msats),
    [100000, 200000, 300000, 400000]
  );
  for (const fruit of fruits.fruits) {
    assert.ok(quoteFiatToMsats({ fiat: fruit.fiat }).amount_msats <= 1000000);
  }
});

test("Hello Fruit shared data stays aligned with canonical demo data", () => {
  const canonical = JSON.parse(readFileSync(canonicalDemoDataPath, "utf8"));
  const product = JSON.parse(readFileSync(productPath, "utf8"));
  const fruits = JSON.parse(readFileSync(fruitsPath, "utf8"));

  assert.equal(product.schema_version, canonical.schema_version);
  assert.equal(fruits.schema_version, canonical.schema_version);
  assert.equal(product.product_id, canonical.product_id);
  assert.equal(fruits.product_id, canonical.product_id);
  assert.equal(product.name, canonical.name);
  assert.equal(product.description, canonical.description);
  assert.deepEqual(
    fruits.fruits.map(({ id, name, fiat }) => ({ id, name, fiat })),
    canonical.fruits
  );

  for (const fruit of fruits.fruits) {
    assert.equal(fruit.sticker, `stickers/${fruit.id}.svg`);
    assert.equal(
      existsSync(path.join(process.cwd(), "examples/hello-fruit/shared", fruit.sticker)),
      true,
      `${fruit.id}: sticker exists`
    );
  }
});

test("Hello Fruit server demos keep secret-safe local setup docs", () => {
  for (const demoDir of demoServerDirs) {
    const envExamplePath = path.join(process.cwd(), demoDir, ".env.example");
    const readmePath = path.join(process.cwd(), demoDir, "README.md");
    const dockerfilePath = path.join(process.cwd(), demoDir, "Dockerfile");
    const composePath = path.join(process.cwd(), demoDir, "compose.yml");
    const composeOverridePath = path.join(process.cwd(), demoDir, "compose.override.yml.example");

    assert.equal(existsSync(envExamplePath), true, `${demoDir}: .env.example`);
    assert.equal(existsSync(readmePath), true, `${demoDir}: README.md`);
    assert.equal(existsSync(dockerfilePath), true, `${demoDir}: Dockerfile`);
    assert.equal(existsSync(composePath), true, `${demoDir}: compose.yml`);
    assert.equal(existsSync(composeOverridePath), true, `${demoDir}: compose.override.yml.example`);

    const envExample = readFileSync(envExamplePath, "utf8");
    const readme = readFileSync(readmePath, "utf8");
    const dockerfile = readFileSync(dockerfilePath, "utf8");
    const compose = readFileSync(composePath, "utf8");
    const composeOverride = readFileSync(composeOverridePath, "utf8");

    assert.match(envExample, /^OPENRECEIVE_NWC=$/m, `${demoDir}: placeholder NWC`);
    assert.doesNotMatch(envExample, /nostr\+walletconnect:\/\//);
    assert.match(readme, /The browser never receives `OPENRECEIVE_NWC`\./);
    assert.match(readme, /\/demo-metadata\.json/);
    assert.match(readme, /compose\.override\.yml\.example up --build/);
    assert.match(dockerfile, /CMD \["npm", "start"\]/);
    assert.match(compose, /env_file:/);
    assert.match(compose, /path:\s+\.\.\/\.\.\/\.\.\/\.\.\/\.env/);
    assert.match(compose, /expose:/);
    assert.doesNotMatch(compose, /ports:/);
    assert.match(composeOverride, /ports:/);
    assert.doesNotMatch(dockerfile, /OPENRECEIVE_NWC=/);
    assert.doesNotMatch(compose, /nostr\+walletconnect:\/\//);
    assert.doesNotMatch(composeOverride, /nostr\+walletconnect:\/\//);
  }
});

test("Hello Fruit production servers expose non-secret metadata without a wallet", async () => {
  await withEnv({ OPENRECEIVE_NWC: undefined }, async () => {
    for (const demo of [
      {
        name: "node-express-react-production",
        metadataId: "node-express-react",
        createApp: createHelloFruitProductionServer
      },
      {
        name: "static-html-small-api-production",
        metadataId: "static-html-small-api",
        createApp: createHelloFruitStaticProductionServer
      }
    ]) {
      const app = demo.createApp();
      const metadata = await getJson(app, "/demo-metadata.json");
      assert.equal(metadata.status, 200, `${demo.name}: metadata status`);
      assert.equal(metadata.body.demo.id, demo.metadataId);
      assert.equal(metadata.body.mode, "unconfigured");

      const health = await getJson(app, "/openreceive/v1/health");
      assert.equal(health.status, 200, `${demo.name}: health status`);
      assert.equal(health.body.wallet_configured, false);
    }

    const nextMetadata = await responseJson(getNextDemoMetadata());
    assert.equal(nextMetadata.status, 200, "nextjs-fullstack: metadata status");
    assert.equal(nextMetadata.body.demo.id, "nextjs-fullstack");
    assert.equal(nextMetadata.body.mode, "unconfigured");

    const nextHealth = await responseJson(
      getNextOpenReceiveHealth(new Request("http://nextjs.test/openreceive/v1/health"))
    );
    assert.equal(nextHealth.status, 200, "nextjs-fullstack: health status");
    assert.equal(nextHealth.body.wallet_configured, false);
  });
});

test("Hello Fruit metadata exposes only allowlisted build fields", async () => {
  const nwc =
    `nostr+walletconnect://${"a".repeat(64)}` +
    `?relay=${encodeURIComponent("wss://relay.example.com")}` +
    `&secret=${"b".repeat(64)}`;

  await withEnv({
    OPENRECEIVE_NWC: nwc,
    OPENRECEIVE_DEMO_MODE: "production",
    OPENRECEIVE_GIT_SHA: "0123456789abcdef",
    OPENRECEIVE_IMAGE_DIGEST: `sha256:${"c".repeat(64)}`,
    OPENRECEIVE_DEPLOYED_AT: "2026-06-20T12:34:56Z"
  }, async () => {
    for (const demo of [
      {
        name: "node-express-react",
        createApp: createHelloFruitServer
      },
      {
        name: "static-html-small-api",
        createApp: createHelloFruitStaticServer
      }
    ]) {
      const metadata = await getJson(demo.createApp(), "/demo-metadata.json");
      assert.equal(metadata.status, 200, `${demo.name}: metadata status`);
      assert.equal(metadata.body.mode, "production");
      assert.equal(metadata.body.build.git_sha, "0123456789abcdef");
      assert.equal(metadata.body.build.image_digest, `sha256:${"c".repeat(64)}`);
      assert.equal(metadata.body.build.deployed_at, "2026-06-20T12:34:56Z");
      assert.equal(JSON.stringify(metadata.body).includes("OPENRECEIVE_NWC"), false);
      assert.equal(JSON.stringify(metadata.body).includes("nostr+walletconnect://"), false);
      assert.equal(JSON.stringify(metadata.body).includes("secret="), false);
    }

    const nextMetadata = await responseJson(getNextDemoMetadata());
    assert.equal(nextMetadata.status, 200, "nextjs-fullstack: metadata status");
    assert.equal(nextMetadata.body.mode, "production");
    assert.equal(nextMetadata.body.build.git_sha, "0123456789abcdef");
    assert.equal(nextMetadata.body.build.image_digest, `sha256:${"c".repeat(64)}`);
    assert.equal(nextMetadata.body.build.deployed_at, "2026-06-20T12:34:56Z");
    assert.equal(JSON.stringify(nextMetadata.body).includes("OPENRECEIVE_NWC"), false);
    assert.equal(JSON.stringify(nextMetadata.body).includes("nostr+walletconnect://"), false);
    assert.equal(JSON.stringify(nextMetadata.body).includes("secret="), false);
  });
});

test("Hello Fruit hosted demo routes expose health, source, docs, robots, and sitemap", async () => {
  await withEnv({
    OPENRECEIVE_NWC: undefined,
    OPENRECEIVE_PUBLIC_URL: "https://demo.example.test",
    OPENRECEIVE_DEMO_NOINDEX: undefined
  }, async () => {
    for (const demo of [
      {
        name: "node-express-react",
        sourcePath: "examples/hello-fruit/server/node-express-react",
        createApp: createHelloFruitServer
      },
      {
        name: "static-html-small-api",
        sourcePath: "examples/hello-fruit/server/static-html-small-api",
        createApp: createHelloFruitStaticServer
      }
    ]) {
      const app = demo.createApp();
      const healthz = await getJson(app, "/healthz");
      assert.equal(healthz.status, 200, `${demo.name}: healthz status`);
      assert.deepEqual(healthz.body, {
        ok: true,
        demo: demo.name,
        wallet_configured: false
      });

      const source = await dispatch(app, {
        method: "GET",
        url: "/source",
        headers: {}
      });
      assert.equal(source.status, 302, `${demo.name}: source status`);
      assert.equal(
        source.headers.get("location"),
        `https://github.com/openreceive/openreceive/tree/main/${demo.sourcePath}`
      );

      const docs = await dispatch(app, {
        method: "GET",
        url: "/docs",
        headers: {}
      });
      assert.equal(docs.status, 302, `${demo.name}: docs status`);
      assert.equal(
        docs.headers.get("location"),
        "https://github.com/openreceive/openreceive/blob/main/docs/01-quickstart-node.md"
      );

      const robots = await dispatch(app, {
        method: "GET",
        url: "/robots.txt",
        headers: {}
      });
      assert.equal(robots.status, 200, `${demo.name}: robots status`);
      assert.match(robots.text, /Allow: \//);
      assert.match(robots.text, /Sitemap: https:\/\/demo\.example\.test\/sitemap\.xml/);

      const sitemap = await dispatch(app, {
        method: "GET",
        url: "/sitemap.xml",
        headers: {}
      });
      assert.equal(sitemap.status, 200, `${demo.name}: sitemap status`);
      assert.match(sitemap.text, /<loc>https:\/\/demo\.example\.test\/<\/loc>/);

      for (const response of [healthz.body, source.text, docs.text, robots.text, sitemap.text]) {
        assert.equal(JSON.stringify(response).includes("OPENRECEIVE_NWC"), false);
        assert.equal(JSON.stringify(response).includes("nostr+walletconnect://"), false);
      }
    }

    const nextHealthz = await responseJson(getNextHealthz());
    assert.equal(nextHealthz.status, 200, "nextjs-fullstack: healthz status");
    assert.deepEqual(nextHealthz.body, {
      ok: true,
      demo: "nextjs-fullstack",
      wallet_configured: false
    });

    const nextSource = getNextSource();
    assert.equal(nextSource.status, 302, "nextjs-fullstack: source status");
    assert.equal(
      nextSource.headers.get("location"),
      "https://github.com/openreceive/openreceive/tree/main/examples/hello-fruit/server/nextjs-fullstack"
    );

    const nextDocs = getNextDocs();
    assert.equal(nextDocs.status, 302, "nextjs-fullstack: docs status");
    assert.equal(
      nextDocs.headers.get("location"),
      "https://github.com/openreceive/openreceive/blob/main/docs/05-frontend-checkout.md"
    );

    assert.equal(nextRobotsDynamic, "force-dynamic");
    const nextRobots = getNextRobots();
    assert.deepEqual(nextRobots.rules, {
      userAgent: "*",
      allow: "/"
    });
    assert.equal(nextRobots.sitemap, "https://demo.example.test/sitemap.xml");

    assert.equal(nextSitemapDynamic, "force-dynamic");
    const nextSitemap = getNextSitemap();
    assert.equal(nextSitemap[0]?.url, "https://demo.example.test");
    assert.equal(JSON.stringify(nextRobots).includes("OPENRECEIVE_NWC"), false);
    assert.equal(JSON.stringify(nextSitemap).includes("nostr+walletconnect://"), false);
  });
});

test("Hello Fruit demos fail closed without OPENRECEIVE_NWC", async () => {
  await withEnv({
    OPENRECEIVE_NWC: undefined,
    OPENRECEIVE_DEMO_MODE: "production",
    OPENRECEIVE_GIT_SHA: "nostr+walletconnect://not-a-sha",
    OPENRECEIVE_IMAGE_DIGEST: `secret=${"b".repeat(64)}`,
    OPENRECEIVE_DEPLOYED_AT: `secret=${"b".repeat(64)}`
  }, async () => {
    for (const demo of [
      {
        name: "node-express-react",
        createApp: createHelloFruitServer
      },
      {
        name: "static-html-small-api",
        createApp: createHelloFruitStaticServer
      }
    ]) {
      const app = demo.createApp();
      const metadata = await getJson(app, "/demo-metadata.json");
      assert.equal(metadata.status, 200, `${demo.name}: metadata status`);
      assert.equal(metadata.body.demo.id, demo.name);
      assert.equal(metadata.body.demo.product, "hello-fruit");
      assert.equal(metadata.body.mode, "unconfigured");
      assert.equal(metadata.body.build.git_sha, null);
      assert.equal(metadata.body.build.image_digest, null);
      assert.equal(metadata.body.build.deployed_at, null);
      assert.equal(metadata.body.packages["@openreceive/core"], "0.1.0");
      assert.equal(metadata.body.packages["@openreceive/express"], "0.1.0");
      assert.equal(metadata.body.packages["@openreceive/node"], "0.1.0");
      assert.equal(
        JSON.stringify(metadata.body).includes("OPENRECEIVE_NWC"),
        false
      );
      assert.equal(
        JSON.stringify(metadata.body).includes("nostr+walletconnect://"),
        false
      );
      if (demo.name === "node-express-react") {
        assert.equal(metadata.body.packages["@openreceive/browser"], "0.1.0");
        assert.equal(metadata.body.packages["@openreceive/react"], "0.1.0");
      } else {
        assert.equal(metadata.body.packages["@openreceive/elements"], "0.1.0");
      }

      const health = await getJson(app, "/openreceive/v1/health");
      assert.equal(health.status, 200, `${demo.name}: health status`);
      assert.deepEqual(health.body, {
        ok: true,
        wallet_configured: false
      });

      const capabilities = await getJson(app, "/openreceive/v1/capabilities");
      assert.equal(capabilities.status, 200, `${demo.name}: capabilities status`);
      assert.equal(capabilities.body.wallet_configured, false);
      assert.deepEqual(capabilities.body.methods, ["make_invoice", "lookup_invoice"]);
      assert.equal(JSON.stringify(capabilities.body).includes("OPENRECEIVE_NWC"), false);
      assert.equal(JSON.stringify(capabilities.body).includes("nostr+walletconnect://"), false);

      const invoice = await postJson(app, "/openreceive/v1/invoices", {
        fiat: {
          currency: "USD",
          value: "0.10"
        },
        description: `Fruit sticker from ${demo.name} smoke test`,
        expiry: 600,
        metadata: {
          product_id: "fruit-sticker-pack",
          fruit: "banana"
        }
      });
      assert.equal(invoice.status, 503, `${demo.name}: invoice status`);
      assert.deepEqual(invoice.body, {
        code: "WALLET_UNAVAILABLE",
        message: "Set OPENRECEIVE_NWC before creating live invoices."
      });
    }

    const nextMetadata = await responseJson(getNextDemoMetadata());
    assert.equal(nextMetadata.status, 200, "nextjs-fullstack: metadata status");
    assert.equal(nextMetadata.body.demo.id, "nextjs-fullstack");
    assert.equal(nextMetadata.body.demo.product, "hello-fruit");
    assert.equal(nextMetadata.body.mode, "unconfigured");
    assert.equal(nextMetadata.body.build.git_sha, null);
    assert.equal(nextMetadata.body.build.image_digest, null);
    assert.equal(nextMetadata.body.build.deployed_at, null);
    assert.equal(nextMetadata.body.packages["@openreceive/browser"], "0.1.0");
    assert.equal(nextMetadata.body.packages["@openreceive/react"], "0.1.0");
    assert.equal(JSON.stringify(nextMetadata.body).includes("OPENRECEIVE_NWC"), false);
    assert.equal(JSON.stringify(nextMetadata.body).includes("nostr+walletconnect://"), false);

    const nextHealth = await responseJson(
      getNextOpenReceiveHealth(new Request("http://nextjs.test/openreceive/v1/health"))
    );
    assert.deepEqual(nextHealth.body, {
      ok: true,
      wallet_configured: false
    });

    const nextCapabilities = await responseJson(
      getNextCapabilities(new Request("http://nextjs.test/openreceive/v1/capabilities"))
    );
    assert.equal(nextCapabilities.body.wallet_configured, false);
    assert.deepEqual(nextCapabilities.body.methods, ["make_invoice", "lookup_invoice"]);
    assert.equal(JSON.stringify(nextCapabilities.body).includes("OPENRECEIVE_NWC"), false);
    assert.equal(JSON.stringify(nextCapabilities.body).includes("nostr+walletconnect://"), false);

    const nextInvoice = await responseJson(
      postNextInvoice(new Request("http://nextjs.test/openreceive/v1/invoices", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "next-demo-smoke"
        },
        body: JSON.stringify({
          fiat: {
            currency: "USD",
            value: "0.10"
          },
          description: "Fruit sticker from nextjs-fullstack smoke test",
          expiry: 600,
          metadata: {
            product_id: "fruit-sticker-pack",
            fruit: "banana"
          }
        })
      }))
    );
    assert.equal(nextInvoice.status, 503, "nextjs-fullstack: invoice status");
    assert.deepEqual(nextInvoice.body, {
      code: "WALLET_UNAVAILABLE",
      message: "Set OPENRECEIVE_NWC before creating live invoices."
    });
  });
});

async function responseJson(responseOrPromise) {
  const response = await responseOrPromise;
  return {
    status: response.status,
    body: await response.json()
  };
}

async function getJson(app, url) {
  return await dispatchJson(app, "GET", url);
}

async function postJson(app, url, body) {
  return await dispatchJson(app, "POST", url, body);
}

async function dispatchJson(app, method, url, body) {
  const response = await dispatch(app, {
    method,
    url,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(body === undefined ? {} : { "idempotency-key": "demo-smoke" })
    },
    body
  });

  return {
    status: response.status,
    body: JSON.parse(response.text)
  };
}

async function dispatch(app, options) {
  return await new Promise((resolve, reject) => {
    const payload =
      options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body));
    const req = new Readable({
      read() {
        if (payload !== undefined) this.push(payload);
        this.push(null);
      }
    });
    req.method = options.method;
    req.url = options.url;
    req.headers = {
      ...options.headers,
      ...(payload === undefined ? {} : { "content-length": String(payload.length) })
    };
    req.connection = { encrypted: false };
    req.socket = {
      encrypted: false,
      destroy() {}
    };
    req.on("error", reject);

    const chunks = [];
    const headers = new Map();
    const res = {
      statusCode: 200,
      headersSent: false,
      locals: {},
      app,
      req,
      setHeader(name, value) {
        headers.set(name.toLowerCase(), value);
      },
      getHeader(name) {
        return headers.get(name.toLowerCase());
      },
      removeHeader(name) {
        headers.delete(name.toLowerCase());
      },
      writeHead(statusCode, _reason, headerValues) {
        this.statusCode = statusCode;
        if (headerValues !== undefined) {
          for (const [name, value] of Object.entries(headerValues)) {
            this.setHeader(name, value);
          }
        }
        this.headersSent = true;
        return this;
      },
      write(chunk) {
        if (chunk !== undefined) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        }
        return true;
      },
      end(chunk) {
        if (chunk !== undefined) this.write(chunk);
        this.headersSent = true;
        resolve({
          status: this.statusCode,
          text: Buffer.concat(chunks).toString("utf8"),
          headers
        });
      },
      on() {
        return this;
      },
      once() {
        return this;
      },
      emit() {
        return false;
      }
    };

    app.handle(req, res, reject);
  });
}

async function withEnv(env, callback) {
  const previous = new Map();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    await callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
