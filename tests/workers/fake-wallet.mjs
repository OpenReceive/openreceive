import { randomBytes } from "node:crypto";
import { NWCWalletService, NWCWalletServiceKeyPair } from "@getalby/sdk/nwc";
import { getPublicKey } from "nostr-tools";

// A receive-only NWC wallet on a real relay, so the Worker under test reaches
// it the way it reaches any wallet: a WebSocket, NIP-47 requests, encrypted
// replies. Invoices are made up; settle() marks one paid.

const METHODS = ["get_info", "make_invoice", "lookup_invoice", "list_transactions"];

export async function startFakeWallet(relayUrl, { advertisedRelayUrl = relayUrl } = {}) {
  const walletSecret = randomBytes(32).toString("hex");
  const clientSecret = randomBytes(32);
  const keypair = new NWCWalletServiceKeyPair(walletSecret, getPublicKey(clientSecret));
  const invoices = new Map();
  const ok = (result) => ({ result, error: undefined });

  const service = new NWCWalletService({ relayUrls: [relayUrl] });
  await service.publishWalletServiceInfoEvent(walletSecret, METHODS, []);
  const unsubscribe = await service.subscribe(keypair, {
    getInfo: async () =>
      ok({
        alias: "workers-test",
        color: "#000000",
        pubkey: keypair.walletPubkey,
        network: "regtest",
        block_height: 1,
        block_hash: "00".repeat(32),
        methods: METHODS,
        notifications: [],
      }),
    makeInvoice: async (request) => {
      const createdAt = Math.floor(Date.now() / 1000);
      const transaction = {
        type: "incoming",
        state: "pending",
        invoice: `lnbcrt${request.amount}workers${invoices.size}`,
        description: request.description ?? "",
        description_hash: "",
        preimage: "",
        payment_hash: randomBytes(32).toString("hex"),
        amount: request.amount,
        fees_paid: 0,
        created_at: createdAt,
        expires_at: createdAt + (request.expiry ?? 3600),
        settled_at: null,
      };
      invoices.set(transaction.payment_hash, transaction);
      return ok(transaction);
    },
    lookupInvoice: async ({ payment_hash: paymentHash }) => {
      const found = invoices.get(paymentHash);
      return found
        ? ok(found)
        : { result: undefined, error: { code: "NOT_FOUND", message: "unknown invoice" } };
    },
    listTransactions: async (request) => {
      if (request.type === "outgoing") return ok({ transactions: [] });
      const rows = [...invoices.values()]
        .filter((row) => request.unpaid === true || row.state === "settled")
        .filter((row) => row.created_at >= (request.from ?? 0))
        .filter((row) => row.created_at <= (request.until ?? Number.MAX_SAFE_INTEGER))
        .sort((left, right) => right.created_at - left.created_at);
      const offset = request.offset ?? 0;
      return ok({ transactions: rows.slice(offset, offset + (request.limit ?? rows.length)) });
    },
  });

  // The wallet may reach the relay by a different address than its clients.
  const relay = encodeURIComponent(advertisedRelayUrl);
  return {
    nwcUri: `nostr+walletconnect://${keypair.walletPubkey}?relay=${relay}&secret=${clientSecret.toString("hex")}`,
    settle(paymentHash) {
      const invoice = invoices.get(paymentHash);
      if (invoice === undefined) throw new Error(`fake wallet has no invoice ${paymentHash}`);
      invoice.state = "settled";
      invoice.settled_at = Math.floor(Date.now() / 1000);
      invoice.preimage = "11".repeat(32);
    },
    close() {
      unsubscribe();
      service.close();
    },
  };
}
