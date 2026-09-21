import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { type APIRequestContext, expect, test } from "@playwright/test";
import {
  createStore,
  fakeLsc,
  fakeLscUri,
  greenfield,
  payFromCustomer,
  stack,
  testkitNwcUri,
} from "./stack.ts";

test.describe.configure({ mode: "serial" });
let store = "";
const hostContainer = "openreceive-btcpay-btcpayserver-1";
test.beforeEach(async ({ request }) => {
  // Real signed/encrypted wallet replies: lower-case mint and host mapping,
  // upper-case settled history/notifications, including cold historical recovery.
  expect((await request.post(`${stack.testkit}/hash-case/upper`)).ok()).toBe(true);
});
test.afterAll(async ({ request }) => {
  expect((await request.post(`${stack.testkit}/hash-case/lower`)).ok()).toBe(true);
});
function docker(...args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", timeout: 120_000 }).trim();
}
function bitcoin(...args: string[]): string {
  return docker(
    "exec",
    "openreceive-btcpay-bitcoind-1",
    "bitcoin-cli",
    "-regtest",
    "-rpcuser=ceiwHEbqWI83",
    "-rpcpassword=DwubwWsoo3",
    "-rpcport=43782",
    ...args,
  );
}
function postgres(sql: string): string {
  return execFileSync(
    "docker",
    [
      "exec",
      "-i",
      "openreceive-btcpay-postgres-1",
      "psql",
      "-U",
      "postgres",
      "-d",
      "btcpayserverregtest",
      "-At",
      "-v",
      "ON_ERROR_STOP=1",
    ],
    { input: sql, encoding: "utf8", timeout: 30_000 },
  ).trim();
}
function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function ready(request: APIRequestContext): Promise<void> {
  await expect
    .poll(
      async () => {
        try {
          return (await request.get(`${stack.btcpay}/api/v1/health`, { timeout: 3000 })).ok();
        } catch {
          return false;
        }
      },
      { timeout: 90_000, intervals: [1000] },
    )
    .toBe(true);
}
type Method = {
  paymentMethodId: string;
  destination: string;
  paid: string;
  payments: { id: string; value: string; status: string }[];
};
function findMethod(rows: Method[], id: string): Method {
  const selected = rows.find((row) => row.paymentMethodId === id);
  if (!selected) throw new Error(`Missing payment method ${id}`);
  return selected;
}
async function methods(request: APIRequestContext, id: string): Promise<Method[]> {
  return greenfield<Method[]>(
    request,
    "GET",
    `/api/v1/stores/${store}/invoices/${id}/payment-methods`,
  );
}

test.beforeAll(async ({ request }) => {
  await ready(request);
  store = await createStore(request);
  await greenfield(request, "PUT", `/api/v1/stores/${store}/openreceive/settings`, {
    nwcUri: await testkitNwcUri(request),
  });
  await greenfield(
    request,
    "POST",
    `/api/v1/stores/${store}/payment-methods/BTC-CHAIN/wallet/generate`,
    { savePrivateKeys: false, scriptPubKeyType: "Segwit" },
  );
});

for (const method of ["BTC-LN", "BTC-LNURL"]) {
  for (const scenario of [
    { pastExpiry: false, payAfterRestart: false, suffix: "" },
    { pastExpiry: true, payAfterRestart: false, suffix: " beyond expiry" },
    { pastExpiry: false, payAfterRestart: true, suffix: " before payment" },
  ]) {
    const { pastExpiry, payAfterRestart } = scenario;
    test(`historical ${method} survives partial remint and restart${scenario.suffix}`, async ({
      request,
    }) => {
      test.setTimeout(210_000);
      const invoice = await greenfield<{ id: string; expirationTime: number }>(
        request,
        "POST",
        `/api/v1/stores/${store}/invoices`,
        {
          amount: "0.001",
          currency: "BTC",
          checkout: {
            paymentMethods: ["BTC-LN", "BTC-LNURL", "BTC-CHAIN"],
            expirationMinutes: pastExpiry ? 1 : 10,
            lazyPaymentMethods: false,
          },
        },
      );
      const initial = await methods(request, invoice.id);
      let original = findMethod(initial, "BTC-LN").destination;
      if (method === "BTC-LNURL") {
        const details = await request.get(`${stack.btcpay}/BTC/lnurl/pay/i/${invoice.id}`);
        expect(details.ok()).toBe(true);
        const amount = (await details.json()).minSendable;
        const minted = await request.get(
          `${stack.btcpay}/BTC/lnurl/pay/i/${invoice.id}?amount=${amount}`,
        );
        expect(minted.ok()).toBe(true);
        original = (await minted.json()).pr;
      }
      expect(original).toMatch(/^lnbcrt/);
      const address = findMethod(initial, "BTC-CHAIN").destination;
      bitcoin("-rpcwallet=regtest", "sendtoaddress", address, "0.0001");
      await expect
        .poll(async () => findMethod(await methods(request, invoice.id), "BTC-LN").destination, {
          timeout: 45_000,
        })
        .not.toBe(findMethod(initial, "BTC-LN").destination);
      if (method === "BTC-LNURL") {
        const details = await request.get(`${stack.btcpay}/BTC/lnurl/pay/i/${invoice.id}`);
        const amount = (await details.json()).minSendable;
        const replacement = await request.get(
          `${stack.btcpay}/BTC/lnurl/pay/i/${invoice.id}?amount=${amount}`,
        );
        expect(replacement.ok()).toBe(true);
        expect((await replacement.json()).pr).not.toBe(original);
      }
      let recoveryBeforeRestart = 0;
      docker("stop", hostContainer);
      try {
        if (payAfterRestart) {
          recoveryBeforeRestart = Number(
            postgres(
              `SELECT next_recovery_at FROM "BTCPayServer.Plugins.OpenReceive".openreceive_invoices WHERE bolt11 = ${sqlLiteral(original)};`,
            ),
          );
        } else {
          await payFromCustomer(original);
        }
        if (pastExpiry) {
          await expect
            .poll(() => Date.now() / 1000, { timeout: 80_000, intervals: [1000] })
            .toBeGreaterThan(invoice.expirationTime + 1);
        }
      } finally {
        docker("start", hostContainer);
      }
      await ready(request);
      if (payAfterRestart) {
        // The fresh process must revisit the original, still-unpaid mint even
        // though the checkout now offers a replacement. Pay only after that pass.
        await expect
          .poll(
            () =>
              Number(
                postgres(
                  `SELECT next_recovery_at FROM "BTCPayServer.Plugins.OpenReceive".openreceive_invoices WHERE bolt11 = ${sqlLiteral(original)};`,
                ),
              ),
            { timeout: 45_000 },
          )
          .toBeGreaterThan(recoveryBeforeRestart);
        expect(
          postgres(
            `SELECT recovery_closed_at IS NULL FROM "BTCPayServer.Plugins.OpenReceive".openreceive_invoices WHERE bolt11 = ${sqlLiteral(original)};`,
          ),
        ).toBe("t");
        expect(findMethod(await methods(request, invoice.id), method).payments).toHaveLength(0);
        await payFromCustomer(original);
      }
      await expect
        .poll(
          async () =>
            (await methods(request, invoice.id)).find((m) => m.paymentMethodId === method)?.payments
              .length ?? 0,
          { timeout: 60_000 },
        )
        .toBe(1);
      const recorded = findMethod(await methods(request, invoice.id), method);
      expect(recorded.payments).toHaveLength(1);
      expect(recorded.payments[0]?.status).toBe("Settled");
      const host = await greenfield<{ paidAmount: string; additionalStatus: string }>(
        request,
        "GET",
        `/api/v1/stores/${store}/invoices/${invoice.id}`,
      );
      expect(Number(host.paidAmount)).toBeGreaterThanOrEqual(0.001);
      if (pastExpiry)
        await expect
          .poll(
            async () =>
              (
                await greenfield<{ additionalStatus: string }>(
                  request,
                  "GET",
                  `/api/v1/stores/${store}/invoices/${invoice.id}`,
                )
              ).additionalStatus,
          )
          .toBe("PaidLate");
      // A second process restart replays discovery/update, never another host payment.
      docker("restart", hostContainer);
      await ready(request);
      expect(findMethod(await methods(request, invoice.id), method).payments).toHaveLength(1);
    });
  }
}

test("server-discovered refund recovery survives disabled swaps, expiry and browser reload", async ({
  request,
  page,
}) => {
  test.setTimeout(180_000);
  await greenfield(request, "PUT", `/api/v1/stores/${store}/openreceive/settings`, {
    lscPrimary: await fakeLscUri(request),
    swapsEnabled: true,
  });
  await fakeLsc(request, "force-refund-required", { selector: "USDT_TRON", reason: "underpaid" });
  const invoice = await greenfield<{ id: string }>(
    request,
    "POST",
    `/api/v1/stores/${store}/invoices`,
    { amount: "25", currency: "USD", checkout: { paymentMethods: ["BTC-LN"] } },
  );
  const created = await request.post(`${stack.btcpay}/api/plugins/openreceive/swaps`, {
    data: { invoiceId: invoice.id, payInAsset: "USDT_TRON" },
  });
  expect(created.ok()).toBe(true);
  const swap = await created.json();
  await expect
    .poll(
      async () =>
        (
          await (
            await request.get(
              `${stack.btcpay}/api/plugins/openreceive/swaps/${invoice.id}/${swap.swap_id}`,
            )
          ).json()
        ).state,
    )
    .toBe("refund_required");
  await greenfield(request, "PUT", `/api/v1/stores/${store}/openreceive/settings`, {
    swapsEnabled: false,
  });
  const checkoutHtml = await (await request.get(`${stack.btcpay}/i/${invoice.id}`)).text();
  expect(
    checkoutHtml.match(/class="[^"]*openreceive-recovery-link/g)?.length,
  ).toBeGreaterThanOrEqual(2);
  postgres(
    `UPDATE "Invoices" SET "Status"='Expired', "ExceptionStatus"='None' WHERE "Id"=${sqlLiteral(invoice.id)};`,
  );
  await page.goto(`/plugins/openreceive/invoices/${invoice.id}/recovery`);
  await expect(page.getByRole("heading", { name: "USDT · Tron" })).toBeVisible();
  await page.reload();
  const input = page.getByRole("textbox", { name: "Refund address" });
  await expect(input).toBeVisible();
  await input.fill("TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Confirm refund address" }).click();
  await expect(page.getByText("Refund address accepted.")).toBeVisible();
  await expect(input).toBeHidden();
  const response = await request.get(`${stack.btcpay}/api/plugins/openreceive/swaps/${invoice.id}`);
  const body = await response.json();
  expect(body.attempts).toHaveLength(1);
  expect(JSON.stringify(body)).not.toMatch(/provider_token|providerToken/);
  expect(
    (
      await request.get(
        `${stack.btcpay}/api/plugins/openreceive/swaps/foreign-invoice/${swap.swap_id}`,
      )
    ).status(),
  ).toBe(404);
});

test("unbound, ambiguous, legacy and foreign-account mints remain scoped and retryable", async ({
  request,
}) => {
  test.setTimeout(120_000);
  const invoice = await greenfield<{ id: string }>(
    request,
    "POST",
    `/api/v1/stores/${store}/invoices`,
    {
      amount: "0.001",
      currency: "BTC",
      checkout: { paymentMethods: ["BTC-LN", "BTC-LNURL"] },
    },
  );
  const otherStore = await createStore(request);
  const original = findMethod(await methods(request, invoice.id), "BTC-LN").destination;
  const source = postgres(
    `SELECT payment_hash FROM "BTCPayServer.Plugins.OpenReceive".openreceive_invoices WHERE bolt11=${sqlLiteral(original)};`,
  );
  const cases = [
    { hash: randomBytes(32).toString("hex"), reason: "host_mapping_missing", methods: [] },
    {
      hash: randomBytes(32).toString("hex"),
      reason: "host_mapping_missing",
      methods: [],
      legacy: true,
    },
    {
      hash: randomBytes(32).toString("hex"),
      reason: "host_mapping_ambiguous",
      methods: ["BTC-LN", "BTC-LNURL"],
    },
    {
      hash: randomBytes(32).toString("hex"),
      reason: "historical_mapping_conflict",
      methods: ["BTC-LN"],
      foreignStore: true,
    },
    {
      hash: randomBytes(32).toString("hex"),
      reason: "original_wallet_unconfigured",
      methods: ["BTC-LN"],
      foreignAccount: true,
    },
    {
      hash: randomBytes(32).toString("hex"),
      reason: "connection_identity_missing",
      methods: ["BTC-LNURL"],
      legacy: true,
    },
  ];
  const hashes = cases.map((item) => sqlLiteral(item.hash)).join(",");
  docker("stop", hostContainer);
  try {
    for (const item of cases) {
      postgres(`INSERT INTO "BTCPayServer.Plugins.OpenReceive".openreceive_invoices
        (payment_hash,bolt11,amount_msats,created_at,expires_at,connection_id,store_id)
        SELECT '${item.hash}',bolt11,amount_msats,created_at,expires_at,${item.legacy ? "NULL" : item.foreignAccount ? "'different-public-account'" : "connection_id"},${item.foreignStore ? sqlLiteral(otherStore) : "NULL"}
        FROM "BTCPayServer.Plugins.OpenReceive".openreceive_invoices WHERE payment_hash='${source}';`);
      for (const method of item.methods)
        postgres(
          `INSERT INTO "AddressInvoices" ("Address","PaymentMethodId","InvoiceDataId") VALUES ('${item.hash}','${method}',${sqlLiteral(invoice.id)});`,
        );
    }
  } finally {
    docker("start", hostContainer);
  }
  try {
    await ready(request);
    for (const item of cases)
      await expect
        .poll(
          () =>
            postgres(
              `SELECT recovery_reason FROM "BTCPayServer.Plugins.OpenReceive".openreceive_invoices WHERE payment_hash='${item.hash}';`,
            ),
          { timeout: 40_000 },
        )
        .toBe(item.reason);
    expect(postgres(`SELECT count(*) FROM "Payments" WHERE "Id" IN (${hashes});`)).toBe("0");
    expect(
      postgres(
        `SELECT count(*) FROM "BTCPayServer.Plugins.OpenReceive".openreceive_invoices WHERE payment_hash IN (${hashes}) AND recovery_closed_at IS NULL AND next_recovery_at>0;`,
      ),
    ).toBe(String(cases.length));
    // The host can finish linking a previously unbound mint. Its original account
    // remains attached, and a later recovery pass picks up that exact mapping.
    const orphan = cases[0];
    if (!orphan) throw new Error("Missing orphan fixture");
    postgres(`INSERT INTO "AddressInvoices" ("Address","PaymentMethodId","InvoiceDataId") VALUES ('${orphan.hash}','BTC-LN',${sqlLiteral(invoice.id)});
      UPDATE "BTCPayServer.Plugins.OpenReceive".openreceive_invoices SET next_recovery_at=0 WHERE payment_hash='${orphan.hash}';`);
    await expect
      .poll(
        () =>
          postgres(
            `SELECT host_invoice_id FROM "BTCPayServer.Plugins.OpenReceive".openreceive_invoices WHERE payment_hash='${orphan.hash}';`,
          ),
        { timeout: 30_000 },
      )
      .toBe(invoice.id);
    expect(postgres(`SELECT count(*) FROM "Payments" WHERE "Id" IN (${hashes});`)).toBe("0");
  } finally {
    postgres(
      `DELETE FROM "AddressInvoices" WHERE "Address" IN (${hashes}); DELETE FROM "BTCPayServer.Plugins.OpenReceive".openreceive_invoices WHERE payment_hash IN (${hashes});`,
    );
  }
});

test("failed host insertion remains retryable and committed rows replay accounting after restart", async ({
  request,
}) => {
  test.setTimeout(180_000);
  const invoice = await greenfield<{ id: string }>(
    request,
    "POST",
    `/api/v1/stores/${store}/invoices`,
    {
      amount: "0.001",
      currency: "BTC",
      checkout: { paymentMethods: ["BTC-LN"] },
    },
  );
  const original = findMethod(await methods(request, invoice.id), "BTC-LN").destination;
  const hash = postgres(
    `SELECT payment_hash FROM "BTCPayServer.Plugins.OpenReceive".openreceive_invoices WHERE bolt11 = ${sqlLiteral(original)};`,
  );
  expect(hash).toMatch(/^[a-f0-9]{64}$/);
  postgres(`CREATE OR REPLACE FUNCTION public.openreceive_test_refuse_payment() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."Id" = '${hash}' THEN RAISE EXCEPTION 'injected test insert failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER openreceive_test_refuse_payment BEFORE INSERT ON "Payments" FOR EACH ROW EXECUTE FUNCTION public.openreceive_test_refuse_payment();`);
  try {
    await payFromCustomer(original);
    await expect
      .poll(
        () =>
          postgres(
            `SELECT host_update_required::text FROM "BTCPayServer.Plugins.OpenReceive".openreceive_invoices WHERE payment_hash='${hash}';`,
          ),
        { timeout: 45_000 },
      )
      .toBe("true");
    expect(postgres(`SELECT count(*) FROM "Payments" WHERE "Id"='${hash}';`)).toBe("0");
  } finally {
    postgres(
      'DROP TRIGGER IF EXISTS openreceive_test_refuse_payment ON "Payments"; DROP FUNCTION IF EXISTS public.openreceive_test_refuse_payment();',
    );
  }
  docker("restart", hostContainer);
  await ready(request);
  await expect
    .poll(async () => findMethod(await methods(request, invoice.id), "BTC-LN").payments.length, {
      timeout: 60_000,
    })
    .toBe(1);
  // Fault fixture for commit-before-accounting: retain the real host payment, leave the
  // host invoice outside its startup pending sweep, and restart with durable update work.
  docker("stop", hostContainer);
  try {
    postgres(`UPDATE "Invoices" SET "Status"='Expired', "ExceptionStatus"='None' WHERE "Id"=${sqlLiteral(invoice.id)};
      UPDATE "BTCPayServer.Plugins.OpenReceive".openreceive_invoices SET host_update_required=true, next_recovery_at=0 WHERE payment_hash='${hash}';`);
  } finally {
    docker("start", hostContainer);
  }
  await ready(request);
  await expect
    .poll(
      async () =>
        (
          await greenfield<{ additionalStatus: string }>(
            request,
            "GET",
            `/api/v1/stores/${store}/invoices/${invoice.id}`,
          )
        ).additionalStatus,
      { timeout: 45_000 },
    )
    .toBe("PaidLate");
  expect(postgres(`SELECT count(*) FROM "Payments" WHERE "Id"='${hash}';`)).toBe("1");
});
