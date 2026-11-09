import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test, { after, before } from "node:test";

const port = 34101;
const base = `http://127.0.0.1:${port}`;
let server;

before(async () => {
  server = spawn(process.execPath, ["server.js"], {
    env: { ...process.env, PORT: String(port) },
    stdio: "inherit",
  });
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const up = await fetch(`${base}/health`).then(
      (response) => response.ok,
      () => false,
    );
    if (up) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("the shop did not start");
});

after(() => {
  server.kill();
});

function cookiesOf(response) {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

test("the home page lists the five products", async () => {
  const html = await (await fetch(`${base}/`)).text();
  for (const name of ["Facet", "Bezel", "Hinge", "Latch", "Knob"]) {
    assert.match(html, new RegExp(name));
  }
});

test("a buyer sees their order and a stranger does not", async () => {
  const created = await fetch(`${base}/orders`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "product_id=1",
    redirect: "manual",
  });
  assert.equal(created.status, 303);
  const cookie = cookiesOf(created);
  const location = created.headers.get("location");
  assert.ok(location, "the order form redirects to the order");
  const orderId = location.split("/").pop();

  const mine = await fetch(new URL(location, base), { headers: { cookie } });
  assert.equal(mine.status, 200);
  assert.match(await mine.text(), /Facet/);

  const theirs = await fetch(`${base}/orders/${orderId}`, { redirect: "manual" });
  assert.ok([401, 403, 404].includes(theirs.status), `a stranger got ${theirs.status}`);
});
