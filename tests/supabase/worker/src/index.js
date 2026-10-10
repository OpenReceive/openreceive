// OpenReceive's Supabase repository inside a Cloudflare Worker, the runtime
// Lovable's apps deploy to. tests/supabase/workers.test.mjs runs it under
// `wrangler dev` against PostgREST behind a stand-in for Supabase's gateway.
//
// Each request builds its own repository, as a Worker builds its stack per
// request; the storage check that passed on an earlier request is reused
// from module scope. POST / runs one order's whole life: two attempts, the
// reconcile gate, a settlement that calls openreceive_on_paid, and a
// duplicate one that must not.
import { createSupabasePayments } from "@openreceive/http";

function attempt(reference, paymentHash, now, swap) {
  return {
    reference,
    paymentHash,
    clientIp: "203.0.113.7",
    checkout: {
      reference,
      paymentHash,
      bolt11: `lnbc-${paymentHash.slice(0, 8)}`,
      amountMsats: 2_100_000,
      createdAt: now,
      expiresAt: now + 600,
      fiatQuote: null,
    },
    ...(swap
      ? {
          swapData: {
            version: 1,
            providerOrder: {
              provider: "test",
              provider_order_id: `order-${paymentHash.slice(0, 8)}`,
              provider_token: "server-only",
              pay_in_asset: "USDT_TRON",
              deposit_address: "T-address",
              deposit_amount: "1",
              expires_at: now + 600,
              state: "awaiting_deposit",
            },
          },
        }
      : {}),
  };
}

export default {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("ok\n");
    const { reference, lightning, swap, now } = await request.json();
    const payments = createSupabasePayments({
      url: env.SUPABASE_URL,
      key: env.SUPABASE_KEY,
      clock: () => now,
    });
    try {
      await payments.commitAttempt(attempt(reference, lightning, now, false));
      await payments.commitAttempt(attempt(reference, swap, now, true));
      const claim = await payments.claimReconcileGate({ now, intervalSeconds: 3 });
      const released =
        claim !== null &&
        (await payments.checkpointReconcileGate({
          claim,
          scheduler: claim.scheduler,
          now,
          release: true,
        }));
      const first = await payments.recordSettlement({ paymentHash: lightning, paidAt: now + 1 });
      const second = await payments.recordSettlement({ paymentHash: swap, paidAt: now + 2 });
      const rows = await payments.listForReference(reference);
      return Response.json({
        claimed: claim !== null,
        released,
        first,
        second,
        fromIp: await payments.countAttemptsFromIp("203.0.113.7", now),
        rows: rows.map((row) => [row.paymentHash, row.status, row.statusReason]),
      });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error), status: error?.status },
        { status: 500 },
      );
    }
  },
};
