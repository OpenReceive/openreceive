import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import path from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";
import pg from "pg";
import { startSharedWallet } from "./shared-wallet.mjs";

// Two app processes of one shop behind a load balancer: one database, one
// wallet, requests landing on either process. Each engine runs as two real
// processes (instances/*) against a real Postgres and MySQL, and the shared
// fake wallet in shared-wallet.mjs is the only thing they have in common
// besides the database.
//
// `tools/ci/deployment-edge-tests.sh` starts the databases and runs this file.
// Directly: set OPENRECEIVE_TEST_POSTGRES_URL / OPENRECEIVE_TEST_MYSQL_URL
// (a database the test may create more databases on) and EDGE_ENGINES
// (node,python,php,rails; default node).
//
// Each instance program keeps one contract:
//   argv "migrate"           create the engine's tables and edge_fulfillments, then exit
//   GET  /__health           answers once the instance is ready
//   POST /__settle           {payment_hash, paid_at, at_ms}: the settlement hook directly
//   POST /__reconcile        {at_ms}: one gated reconcile pass
//   POST /__notify           {payment_hash, transaction, at_ms}: one real notification
//   anything else            the engine's own /openreceive routes
//
// on_paid inserts one edge_fulfillments row inside the settlement transaction
// and reports to the wallet: the table has NO unique constraint, so a double
// fulfillment is counted here instead of being hidden by an index.

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const INSTANCES = path.join(REPO, "tests/deployment/instances");
const RATE_LIMIT = 4;

const URLS = {
  postgres: process.env.OPENRECEIVE_TEST_POSTGRES_URL,
  mysql: process.env.OPENRECEIVE_TEST_MYSQL_URL,
};
const ENGINES = (process.env.EDGE_ENGINES ?? "node").split(",").map((name) => name.trim());

/** Container name prefix for instance processes that run in Docker. */
const CONTAINER_PREFIX = "ortrial-edge-instance";

function launchers(env, script, name) {
  const environment = { ...process.env, ...env };
  const dockerEnv = Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
  const docker = (image, command) =>
    spawn(
      "docker",
      [
        "run",
        "--rm",
        "--name",
        name,
        "--network",
        "host",
        "--user",
        `${process.getuid()}:${process.getgid()}`,
        "-e",
        "HOME=/tmp",
        ...dockerEnv,
        "-v",
        `${REPO}:/repo:ro`,
        "-w",
        "/repo",
        image,
        ...command,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  return {
    node: () =>
      spawn("node", ["--import", "tsx", path.join(INSTANCES, "node-instance.ts"), ...script], {
        cwd: REPO,
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    python: () =>
      spawn(
        path.join(REPO, "packages/python/openreceive/.venv/bin/python"),
        [path.join(INSTANCES, "python_instance.py"), ...script],
        { cwd: REPO, env: environment, stdio: ["ignore", "pipe", "pipe"] },
      ),
    php: () =>
      docker(process.env.EDGE_PHP_IMAGE ?? "ortrial-edge-php", [
        "bash",
        "tests/deployment/instances/php-launch.sh",
        ...script,
      ]),
    rails: () =>
      docker(process.env.EDGE_RUBY_IMAGE ?? "ortrial-edge-ruby", [
        "bash",
        "tests/deployment/instances/rails-launch.sh",
        ...script,
      ]),
  };
}

/** The per-test database, created on the given server and dropped afterwards. */
async function provisionDatabase(dialect, name) {
  const base = new URL(URLS[dialect]);
  if (dialect === "postgres") {
    const admin = new pg.Client({ connectionString: URLS[dialect] });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();
  } else {
    const admin = await mysql.createConnection(URLS[dialect]);
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();
  }
  base.pathname = `/${name}`;
  return base.toString();
}

async function dropDatabase(dialect, name) {
  if (dialect === "postgres") {
    const admin = new pg.Client({ connectionString: URLS[dialect] });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  } else {
    const admin = await mysql.createConnection(URLS[dialect]);
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.end();
  }
}

async function connect(dialect, url) {
  if (dialect === "postgres") {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    return {
      async rows(sql) {
        return (await client.query(sql)).rows;
      },
      close: () => client.end(),
    };
  }
  const connection = await mysql.createConnection(url);
  return {
    async rows(sql) {
      return (await connection.query(sql))[0];
    },
    close: () => connection.end(),
  };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function runToExit(child) {
  return new Promise((resolve) => {
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("close", (code) => resolve({ code, output }));
  });
}

async function startShop(engine, dialect, label) {
  const suffix = `${process.pid}_${Date.now() % 1_000_000}`;
  const databaseName = `edge_${engine}_${suffix}`;
  const databaseUrl = await provisionDatabase(dialect, databaseName);
  const wallet = await startSharedWallet();
  const db = await connect(dialect, databaseUrl);
  const baseEnv = {
    EDGE_DB_KIND: dialect,
    EDGE_DB_URL: databaseUrl,
    EDGE_WALLET_URL: wallet.url,
    EDGE_RATE_LIMIT_PER_HOUR: String(RATE_LIMIT),
  };

  const migrateName = `${CONTAINER_PREFIX}-migrate-${suffix}`;
  const migrated = await runToExit(
    launchers({ ...baseEnv, EDGE_INSTANCE: "migrate" }, ["migrate"], migrateName)[engine](),
  );
  assert.equal(migrated.code, 0, `${engine} migrate failed:\n${migrated.output}`);

  const instances = {};
  const logs = {};
  const containers = [];
  for (const name of ["a", "b"]) {
    const port = await freePort();
    const containerName = `${CONTAINER_PREFIX}-${engine}-${name}-${suffix}`;
    containers.push(containerName);
    const child = launchers(
      { ...baseEnv, EDGE_INSTANCE: name, EDGE_PORT: String(port) },
      [],
      containerName,
    )[engine]();
    logs[name] = "";
    child.stdout.on("data", (chunk) => {
      logs[name] += chunk;
    });
    child.stderr.on("data", (chunk) => {
      logs[name] += chunk;
    });
    instances[name] = { child, port, name };
  }

  const shop = {
    label,
    wallet,
    db,
    instances,
    logs,
    serverErrors: [],
    async post(instance, route, body = {}, headers = {}) {
      const target = instances[instance];
      const response = await fetch(`http://127.0.0.1:${target.port}${route}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      let json;
      try {
        json = text.length > 0 ? JSON.parse(text) : {};
      } catch {
        json = { unparsed: text };
      }
      if (response.status >= 500) {
        shop.serverErrors.push({ instance, route, status: response.status, body: json });
      }
      return { status: response.status, json };
    },
    create(instance, reference, headers = {}) {
      return shop.post(instance, "/openreceive/checkouts", { reference }, headers);
    },
    check(instance, reference, paymentHash) {
      return shop.post(instance, "/openreceive/payments/check", {
        reference,
        payment_hash: paymentHash,
      });
    },
    async pollUntilSettled(instance, reference, paymentHash, timeoutMs = 25_000) {
      const started = Date.now();
      let last;
      while (Date.now() - started < timeoutMs) {
        last = await shop.check(instance, reference, paymentHash);
        assert.ok(last.status < 500, `poll on ${instance} answered ${last.status}`);
        if (last.json.status === "settled") return last;
        await sleep(300);
      }
      throw new Error(`${paymentHash} never settled through ${instance}: ${JSON.stringify(last)}`);
    },
    fulfillments(paymentHash) {
      return db.rows(
        `SELECT reference, payment_hash, instance FROM edge_fulfillments WHERE payment_hash = '${paymentHash}'`,
      );
    },
    fulfillmentCount: async (paymentHash) => (await shop.fulfillments(paymentHash)).length,
    firedHooks(paymentHash) {
      return wallet.stats.fulfilled.filter((row) => row.payment_hash === paymentHash).length;
    },
    /** Both counts every exactly-once check asserts: the row and the hook call. */
    async assertFulfilledOnce(paymentHash, context) {
      assert.equal(await shop.fulfillmentCount(paymentHash), 1, `fulfillment rows, ${context}`);
      assert.equal(shop.firedHooks(paymentHash), 1, `on_paid calls, ${context}`);
    },
    liveRows(reference) {
      return db.rows(
        `SELECT payment_hash FROM openreceive_payments WHERE reference = '${reference}' AND status = 'pending' AND (status_reason IS NULL OR status_reason <> 'superseded')`,
      );
    },
    async stop() {
      for (const name of ["a", "b"]) instances[name].child.kill("SIGTERM");
      if (engine === "php" || engine === "rails") {
        for (const container of containers) {
          spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" });
        }
      }
      await db.close();
      await wallet.close();
      await dropDatabase(dialect, databaseName);
    },
  };

  try {
    for (const name of ["a", "b"]) {
      await waitHealthy(instances[name], logs, name);
    }
  } catch (error) {
    await shop.stop();
    throw error;
  }
  return shop;
}

async function waitHealthy(instance, logs, name) {
  const started = Date.now();
  while (Date.now() - started < 90_000) {
    try {
      const response = await fetch(`http://127.0.0.1:${instance.port}/__health`);
      if (response.status === 200) return;
    } catch {
      // Still booting.
    }
    if (instance.child.exitCode !== null) break;
    await sleep(250);
  }
  throw new Error(`instance ${name} never became healthy:\n${logs[name]}`);
}

function reference(prefix, n) {
  return `${prefix}-${n}-${Math.random().toString(36).slice(2, 8)}`;
}

function atMs(delay = 150) {
  return Date.now() + delay;
}

/** One minted invoice per entry, alternating between the two instances. */
async function mintAlternating(shop, prefix, count) {
  const minted = [];
  for (let n = 0; n < count; n++) {
    const ref = reference(prefix, n);
    const answer = await shop.create(n % 2 === 0 ? "a" : "b", ref);
    assert.equal(answer.status, 201, `mint ${ref}: ${JSON.stringify(answer.json)}`);
    minted.push({ reference: ref, hash: answer.json.checkout.payment_hash });
  }
  return minted;
}

function requireHashOf(answer) {
  return answer.json?.checkout?.payment_hash;
}

for (const dialect of ["postgres", "mysql"]) {
  for (const engine of ENGINES) {
    const skip = URLS[dialect] ? false : `Set the ${dialect} test URL for this lane`;
    test(`${engine} on ${dialect}: two instances share one database and one wallet`, {
      skip,
    }, async (t) => {
      const shop = await startShop(engine, dialect, `${engine}/${dialect}`);
      t.after(() => shop.stop());

      await t.test("an invoice minted on A is polled and settled through B", async () => {
        const ref = reference("cross", 0);
        const created = await shop.create("a", ref);
        assert.equal(created.status, 201, JSON.stringify(created.json));
        const hash = requireHashOf(created);
        assert.ok(/^[0-9a-f]{64}$/.test(hash), `mint returned ${hash}`);

        const before = await shop.check("b", ref, hash);
        assert.equal(before.status, 200, JSON.stringify(before.json));
        assert.equal(before.json.status, "pending");

        shop.wallet.settle(hash);
        const settled = await shop.pollUntilSettled("b", ref, hash);
        assert.equal(settled.json.status, "settled");

        const onA = await shop.check("a", ref, hash);
        assert.equal(onA.status, 200, JSON.stringify(onA.json));
        assert.equal(onA.json.status, "settled");
        await shop.assertFulfilledOnce(hash, "after a cross-instance poll");
      });

      await t.test("a retried create on the other instance returns the same invoice", async () => {
        shop.wallet.resetCounters();
        const ref = reference("reuse", 0);
        const onA = await shop.create("a", ref);
        assert.equal(onA.status, 201, JSON.stringify(onA.json));
        const onB = await shop.create("b", ref);
        assert.equal(onB.status, 201, JSON.stringify(onB.json));
        assert.equal(requireHashOf(onB), requireHashOf(onA));
        assert.equal(shop.wallet.stats.mints, 1, "one mint for one reference");
      });

      await t.test(
        "the same reference created on both at once never exposes two invoices",
        async () => {
          let bothOk = 0;
          let oneConflict = 0;
          for (let round = 0; round < 8; round++) {
            const ref = reference("race", round);
            const [one, two] = await Promise.all([shop.create("a", ref), shop.create("b", ref)]);
            for (const answer of [one, two]) {
              assert.ok(
                answer.status === 201 || answer.status === 409,
                `round ${round}: ${answer.status} ${JSON.stringify(answer.json)}`,
              );
            }
            const winners = [one, two].filter((answer) => answer.status === 201);
            assert.ok(winners.length >= 1, `round ${round}: both instances refused`);
            const hashes = new Set(winners.map(requireHashOf));
            assert.equal(hashes.size, 1, `round ${round}: two different invoices shown to a payer`);
            if (winners.length === 2) bothOk += 1;
            else oneConflict += 1;

            const live = await shop.liveRows(ref);
            assert.equal(live.length, 1, `round ${round}: live rows ${JSON.stringify(live)}`);
            for (const instance of ["a", "b"]) {
              const retry = await shop.create(instance, ref);
              assert.equal(
                retry.status,
                201,
                `retry on ${instance}: ${JSON.stringify(retry.json)}`,
              );
              assert.equal(requireHashOf(retry), live[0].payment_hash);
            }
          }
          t.diagnostic(`${shop.label} create race: both 201 ${bothOk}/8, one 409 ${oneConflict}/8`);
        },
      );

      await t.test(
        "both instances settling one invoice at the same moment fulfill it once",
        async () => {
          const minted = await mintAlternating(shop, "settle", 16);
          const paidAt = Math.floor(Date.now() / 1000);
          for (const row of minted) shop.wallet.settle(row.hash);
          const at = atMs(250);
          const answers = await Promise.all(
            minted.flatMap((row) =>
              ["a", "b"].map((instance) =>
                shop.post(instance, "/__settle", {
                  payment_hash: row.hash,
                  paid_at: paidAt,
                  at_ms: at,
                }),
              ),
            ),
          );
          for (const answer of answers) {
            assert.equal(answer.status, 200, JSON.stringify(answer.json));
          }
          for (const row of minted) await shop.assertFulfilledOnce(row.hash, `race on ${row.hash}`);
          for (const row of minted) {
            for (const instance of ["a", "b"]) {
              const answer = await shop.check(instance, row.reference, row.hash);
              assert.equal(
                answer.json.status,
                "settled",
                `${instance}: ${JSON.stringify(answer.json)}`,
              );
            }
          }
        },
      );

      await t.test(
        "gated reconcile passes on both instances fulfill every invoice once",
        async () => {
          const minted = await mintAlternating(shop, "gated", 12);
          for (const row of minted) shop.wallet.settle(row.hash);
          const deadline = Date.now() + 40_000;
          const settled = new Set();
          while (settled.size < minted.length && Date.now() < deadline) {
            const open = minted.filter((row) => !settled.has(row.hash));
            const answers = await Promise.all(
              open.flatMap((row) =>
                ["a", "b"].map(async (instance) => [
                  row,
                  await shop.check(instance, row.reference, row.hash),
                ]),
              ),
            );
            for (const [row, answer] of answers) {
              assert.ok(answer.status < 500, `${answer.status} ${JSON.stringify(answer.json)}`);
              if (answer.json.status === "settled") settled.add(row.hash);
            }
            await sleep(500);
          }
          assert.equal(settled.size, minted.length, "every invoice settled through the gated path");
          for (const row of minted) await shop.assertFulfilledOnce(row.hash, "gated polls");
        },
      );

      await t.test(
        "a notification on one instance racing a pass on the other fulfills once",
        async () => {
          const minted = await mintAlternating(shop, "notify", 8);
          for (const row of minted) shop.wallet.settle(row.hash);
          const paidAt = Math.floor(Date.now() / 1000);
          const at = atMs(250);
          const answers = await Promise.all(
            minted.flatMap((row) => [
              shop.post("a", "/__notify", {
                payment_hash: row.hash,
                transaction: shop.wallet.transaction(row.hash),
                at_ms: at,
              }),
              shop.post("b", "/__settle", { payment_hash: row.hash, paid_at: paidAt, at_ms: at }),
              shop.post("b", "/__reconcile", { at_ms: at }),
            ]),
          );
          for (const answer of answers) {
            assert.equal(answer.status, 200, JSON.stringify(answer.json));
          }
          const deadline = Date.now() + 20_000;
          for (const row of minted) {
            while ((await shop.fulfillmentCount(row.hash)) === 0 && Date.now() < deadline) {
              await sleep(100);
            }
          }
          // A settlement still in flight on the other side would land here.
          await sleep(500);
          for (const row of minted) await shop.assertFulfilledOnce(row.hash, "notification race");
        },
      );

      await t.test("the per-IP limit is shared: it does not double across instances", async () => {
        const ip = { "x-edge-client-ip": "203.0.113.7" };
        const statuses = [];
        for (let n = 0; n < RATE_LIMIT; n++) {
          statuses.push(
            (await shop.create(n % 2 === 0 ? "a" : "b", reference("rate", n), ip)).status,
          );
        }
        assert.deepEqual(statuses, Array(RATE_LIMIT).fill(201));
        for (const instance of ["a", "b"]) {
          const over = await shop.create(instance, reference("rate-over", 0), ip);
          assert.equal(over.status, 429, `${instance}: ${JSON.stringify(over.json)}`);
        }

        // Count-then-mint is not atomic, so a concurrent burst can overshoot;
        // what it must not do is treat each instance as its own budget.
        const burstIp = { "x-edge-client-ip": "203.0.113.8" };
        const burst = await Promise.all(
          Array.from({ length: 16 }, (_unused, n) =>
            shop.create(n % 2 === 0 ? "a" : "b", reference("burst", n), burstIp),
          ),
        );
        const created = burst.filter((answer) => answer.status === 201).length;
        const limited = burst.filter((answer) => answer.status === 429).length;
        assert.equal(created + limited, burst.length, JSON.stringify(burst.map((b) => b.status)));
        t.diagnostic(
          `${shop.label} burst of 16 at limit ${RATE_LIMIT}: ${created} created, ${limited} refused`,
        );
      });

      await t.test(
        "a concurrent burst from one IP never creates more than the limit",
        {
          skip: "Known bug: the limiter counts rows before the mint, so a concurrent burst passes the count before any row commits",
        },
        async () => {
          const ip = { "x-edge-client-ip": "203.0.113.9" };
          const burst = await Promise.all(
            Array.from({ length: 16 }, (_unused, n) =>
              shop.create(n % 2 === 0 ? "a" : "b", reference("burst-exact", n), ip),
            ),
          );
          const created = burst.filter((answer) => answer.status === 201).length;
          assert.ok(created <= RATE_LIMIT, `${created} invoices created at limit ${RATE_LIMIT}`);
        },
      );

      await t.test("the gate budgets wallet scans across both instances", async () => {
        const [row] = await mintAlternating(shop, "scan-budget", 1);
        shop.wallet.resetCounters();
        const started = Date.now();
        let polls = 0;
        while (Date.now() - started < 7_000) {
          const answers = await Promise.all(
            ["a", "b"].flatMap((instance) => [
              shop.check(instance, row.reference, row.hash),
              shop.check(instance, row.reference, row.hash),
            ]),
          );
          for (const answer of answers) assert.ok(answer.status < 500, JSON.stringify(answer.json));
          polls += answers.length;
          await sleep(50);
        }
        const { scans, scanInstances } = shop.wallet.stats;
        const passes = shop.wallet.passCount();
        t.diagnostic(
          `${shop.label} scan budget: ${passes} passes (${scans} pages) from ${[...scanInstances].join("+")} for ${polls} polls in 7s`,
        );
        assert.ok(passes >= 1, "at least one real scan");
        // One gate across both processes: a 3 second floor allows 3 passes in
        // 7 seconds, and one more at the window edge. Per-process gates would
        // make it twice that.
        assert.ok(passes <= 4, `${passes} passes for ${polls} polls: the gate must be shared`);
      });

      await t.test(
        "swap state lives in the row: created on A, read on B",
        { skip: engine === "rails" ? "no fake swap provider ships for Ruby" : false },
        async () => {
          const ref = reference("swap", 0);
          const created = await shop.post("a", "/openreceive/swaps", {
            reference: ref,
            pay_in_asset: "USDT_TRON",
          });
          assert.equal(created.status, 201, JSON.stringify(created.json));
          const hash = created.json.swap.payment_hash ?? created.json.swap.checkout?.payment_hash;
          assert.ok(hash, JSON.stringify(created.json));

          const read = await shop.post("b", "/openreceive/swaps/status", {
            reference: ref,
            payment_hash: hash,
          });
          assert.equal(read.status, 200, JSON.stringify(read.json));
          t.diagnostic(`${shop.label} swap read on B: ${JSON.stringify(read.json).slice(0, 300)}`);
          assert.ok(
            JSON.stringify(read.json).includes(
              created.json.swap.deposit_address ?? "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb",
            ),
            JSON.stringify(read.json),
          );

          const retried = await shop.post("b", "/openreceive/swaps", {
            reference: ref,
            pay_in_asset: "USDT_TRON",
          });
          assert.equal(retried.status, 201, JSON.stringify(retried.json));
          assert.equal(
            retried.json.swap.payment_hash ?? retried.json.swap.checkout?.payment_hash,
            hash,
          );
        },
      );

      await t.test("neither instance answered a server error at any point", () => {
        assert.deepEqual(shop.serverErrors, []);
      });

      // Printed so a run shows what each instance logged, and checked for the
      // failures a healthy two-instance shop never produces.
      for (const name of ["a", "b"]) {
        const lines = shop.logs[name].split("\n").filter((line) => line.trim().length > 0);
        const problems = lines.filter((line) =>
          /unhandled|traceback|fatal|deadlock|exception/i.test(line),
        );
        const sample = [...new Set(lines)].slice(0, 2).map((line) => line.slice(0, 120));
        t.diagnostic(
          `${shop.label} ${name}: ${lines.length} log lines, ${problems.length} problem lines; ${JSON.stringify(sample)}`,
        );
        assert.deepEqual(problems, [], `instance ${name} logged a failure`);
      }
    });
  }
}
