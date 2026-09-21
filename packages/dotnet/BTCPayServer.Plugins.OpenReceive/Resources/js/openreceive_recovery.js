/* Invoice bearer recovery: server-discovered attempt IDs, no provider credentials. */
window.OpenReceiveRecovery = {
  start(api) {
    const views = new Map();
    const error = document.getElementById("error");
    const more = document.getElementById("more");
    let next = null;
    let stopped = false;
    let timer;
    function render(swap) {
      let view = views.get(swap.swap_id);
      if (!view) {
        const card = document.createElement("article");
        const title = document.createElement("h2");
        const identity = document.createElement("small");
        const status = document.createElement("p");
        const input = document.createElement("input");
        const button = document.createElement("button");
        const feedback = document.createElement("p");
        input.placeholder = "Refund address you control";
        input.setAttribute("aria-label", "Refund address");
        button.textContent = "Confirm refund address";
        feedback.setAttribute("role", "status");
        card.append(title, identity, status, input, button, feedback);
        document.getElementById("attempts").append(card);
        view = { card, title, identity, status, input, button, feedback, swap, busy: false };
        views.set(swap.swap_id, view);
        button.onclick = async () => {
          if (view.busy || !input.value.trim()) return;
          if (
            !window.confirm(
              "Refund to " +
                input.value.trim() +
                " on " +
                view.swap.network_label +
                "? The accepted address cannot be changed.",
            )
          )
            return;
          view.busy = true;
          button.disabled = true;
          try {
            const response = await fetch(`${api}/${encodeURIComponent(swap.swap_id)}/refund`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ refundAddress: input.value.trim() }),
            });
            const body = await response.json();
            if (!response.ok)
              throw new Error(body.message || "Refund could not be requested. Retry shortly.");
            if (!stopped) {
              render(body);
              feedback.textContent = "Refund address accepted.";
            }
          } catch (e) {
            if (!stopped) feedback.textContent = e.message;
          } finally {
            view.busy = false;
            button.disabled = false;
          }
        };
      }
      view.swap = swap;
      view.title.textContent = `${swap.asset_label} · ${swap.network_label}`;
      view.identity.textContent = `Attempt ${swap.swap_id}${swap.retired ? " · Replaced instructions" : ""}`;
      view.status.textContent =
        swap.label +
        ". " +
        (swap.state === "awaiting_deposit"
          ? "Checking this payment attempt. Use the checkout for current payment instructions."
          : swap.detail) +
        (swap.wallet_settled ? " Lightning payment recorded." : "") +
        (swap.refund_address ? ` Refund address: ${swap.refund_address}` : "") +
        (swap.refund_tx_id ? ` Refund transaction: ${swap.refund_tx_id}` : "");
      view.input.hidden = view.button.hidden =
        swap.state !== "refund_required" || !!swap.refund_address;
    }
    async function list(after) {
      const response = await fetch(api + (after ? `?after=${encodeURIComponent(after)}` : ""));
      const page = await response.json();
      if (!response.ok) throw new Error(page.message || "Recovery is temporarily unavailable.");
      if (stopped) return;
      page.attempts.forEach(render);
      next = page.next_cursor;
      more.hidden = !next;
      if (!views.size) error.textContent = "No swap payment attempts for this invoice.";
    }
    async function refresh() {
      try {
        for (const [id, view] of views) {
          if (stopped) return;
          if (view.swap.terminal) continue;
          const response = await fetch(`${api}/${encodeURIComponent(id)}`);
          if (response.ok && !stopped) render(await response.json());
        }
      } catch {
        /* The next bounded refresh retries; refund input stays intact. */
      }
      if (!stopped) timer = setTimeout(refresh, 5000);
    }
    more.onclick = () =>
      list(next).catch((e) => {
        error.textContent = e.message;
      });
    list(null)
      .then(refresh)
      .catch((e) => {
        error.textContent = e.message;
      });
    window.addEventListener(
      "pagehide",
      () => {
        stopped = true;
        clearTimeout(timer);
      },
      { once: true },
    );
  },
};
