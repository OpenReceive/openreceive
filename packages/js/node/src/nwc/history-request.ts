import type { NWCClient } from "@getalby/sdk/nwc";

/**
 * The SDK's listTransactions timeout does not cancel relay reconnection. Use
 * its public signing, encryption and pool APIs with a request-scoped signal so
 * a bounded reconcile pass cannot leave a wallet walker running after its lease.
 */
export async function historyRequest(
  client: Pick<
    NWCClient,
    "walletPubkey" | "relayUrls" | "encryptionType" | "encrypt" | "decrypt" | "signEvent" | "pool"
  >,
  params: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  signal.throwIfAborted();
  const content = await client.encrypt(
    client.walletPubkey,
    JSON.stringify({ method: "list_transactions", params }),
  );
  signal.throwIfAborted();
  const event = await client.signEvent({
    kind: 23194,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["p", client.walletPubkey],
      ["v", client.encryptionType === "nip44_v2" ? "1.0" : "0.0"],
      ["encryption", client.encryptionType],
    ],
    content,
  });
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let done = false;
    let subscription: { close(): void } | undefined;
    const finish = (error: unknown, result?: unknown) => {
      if (done) return;
      done = true;
      signal.removeEventListener("abort", abort);
      controller.abort();
      subscription?.close();
      if (error === undefined) resolve(result);
      else reject(error);
    };
    const abort = () => finish(signal.reason ?? new Error("Wallet scan cancelled."));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    try {
      subscription = client.pool.subscribe(
        client.relayUrls,
        { kinds: [23195], authors: [client.walletPubkey], "#e": [event.id] },
        {
          abort: controller.signal,
          onevent: async (reply) => {
            if (
              done ||
              reply.pubkey !== client.walletPubkey ||
              !reply.tags.some((tag) => tag[0] === "e" && tag[1] === event.id)
            )
              return;
            try {
              const body = JSON.parse(await client.decrypt(client.walletPubkey, reply.content));
              if (done || signal.aborted) return;
              if (body.error !== undefined && body.error !== null) finish(body.error);
              else finish(undefined, body.result);
            } catch (error) {
              finish(error);
            }
          },
        },
      );
      if (done) {
        subscription.close();
        return;
      }
      // The same signal cancels queued relay connections and publication, not
      // only the promise waiting for a response. No request is reminted here.
      void Promise.any(
        client.pool.publish(client.relayUrls, event, { abort: controller.signal }),
      ).catch((error) => finish(error));
    } catch (error) {
      finish(error);
    }
  });
}
