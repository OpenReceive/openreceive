import {
  formatOpenReceiveInvalidNwcMessage,
  formatOpenReceiveMissingNwcMessage,
  NwcUriParseError,
  parseNwcUri,
  type OpenReceiveReceiveNwcClient
} from "@openreceive/core";

export function readRequiredHelloFruitNwcConnectionString(
  env: { readonly [key: string]: string | undefined } = process.env
): string {
  const value = env.OPENRECEIVE_NWC?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(formatOpenReceiveMissingNwcMessage({
      subject: "The Hello Fruit demo"
    }));
  }

  try {
    parseNwcUri(value);
  } catch (error) {
    const reason = error instanceof NwcUriParseError
      ? error.description
      : "Invalid NWC URI.";
    throw new Error(formatOpenReceiveInvalidNwcMessage({ reason }));
  }

  return value;
}

export function createHelloFruitTestReceiveClient(
  env: { readonly [key: string]: string | undefined } = process.env
): OpenReceiveReceiveNwcClient | undefined {
  if (env.OPENRECEIVE_TEST_FAKE_NWC !== "1") return undefined;

  return {
    async preflight() {
      return {
        walletPubkey: "f".repeat(64),
        relays: ["wss://relay.example.com"],
        methods: ["make_invoice", "lookup_invoice"],
        notifications: ["payment_received"],
        encryption: "nip44_v2",
        spendCapabilityAdvertised: false,
        receiveCheckoutReady: true,
        warnings: []
      };
    },
    async makeInvoice(request) {
      return {
        invoice: "lnbc-hello-fruit-test",
        payment_hash: "f".repeat(64),
        amount_msats: request.amount_msats,
        created_at: 1000,
        expires_at: 1600
      };
    },
    async lookupInvoice() {
      return {
        invoice: "lnbc-hello-fruit-test",
        payment_hash: "f".repeat(64),
        amount_msats: 200000n,
        transaction_state: "pending"
      };
    }
  };
}
