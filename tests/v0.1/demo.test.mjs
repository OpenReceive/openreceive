import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { createHelloFruitServer } from "../../examples/hello-fruit/server/node-express-react/src/server/create-server.ts";
import { createHelloFruitStaticServer } from "../../examples/hello-fruit/server/static-html-small-api/src/server/create-server.ts";

const productPath = path.join(
  process.cwd(),
  "examples/hello-fruit/shared/product.json"
);

test("Hello Fruit shared product keeps demo invoices low-value", () => {
  const product = JSON.parse(readFileSync(productPath, "utf8"));

  assert.equal(product.schema_version, "0.1.0");
  assert.equal(product.fiat.currency, "USD");
  assert.equal(product.fiat.value, "0.10");
  assert.equal(product.amount_msats, 200000);
  assert.ok(product.amount_msats <= 1000000);
  assert.equal(product.invoice_expiry_seconds, 600);
});

test("Hello Fruit demos fail closed without OPENRECEIVE_NWC", async () => {
  await withEnv({ OPENRECEIVE_NWC: undefined }, async () => {
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
        amount_msats: 200000,
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
  });
});

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
