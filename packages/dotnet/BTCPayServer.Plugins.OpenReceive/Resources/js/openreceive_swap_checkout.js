/* OpenReceive swap checkout — one Vue 2 component per pay-in asset, mounted by
 * BTCPay's checkout when its pill is selected (pmId "OpenReceiveSwap_<asset>" ↔
 * component "OpenReceiveSwap_<asset>Checkout"). BTCPay stops refreshing invoice
 * status while a plugin method is selected, so this component polls the swap
 * every 5 s and refreshes the invoice through BTCPay's own status endpoint, which
 * lets BTCPay's app flip to its paid screen by itself. */
window.OpenReceiveSwapCheckout = (() => {
  const REFUND_REASONS = {
    underpaid: "the amount received was below the quoted amount",
    overpaid: "the amount received was above the quoted amount",
    late_deposit: "the deposit arrived after the payment window closed",
    underpaid_and_late: "the deposit was late and below the quoted amount",
    overpaid_and_late: "the deposit was late and above the quoted amount",
  };

  function pad(n) {
    return n < 10 ? `0${n}` : String(n);
  }

  function definition(asset, config) {
    return {
      template: "#openreceive-swap-checkout-template",
      props: ["model"],
      components: { qrcode: VueQrcode },
      data() {
        return {
          payInAsset: asset,
          swap: null,
          error: null,
          copied: null,
          refundAddress: "",
          refundError: null,
          refunding: false,
          remaining: 0,
          timers: [],
        };
      },
      computed: {
        qrOptions() {
          return typeof qrOptions !== "undefined" ? qrOptions : { margin: 0, type: "svg" };
        },
        assetLabel() {
          const l = config.labels[this.payInAsset];
          return l ? l.asset : this.payInAsset;
        },
        countdown() {
          const s = Math.max(0, this.remaining);
          return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
        },
        refundReasonText() {
          return (this.swap && REFUND_REASONS[this.swap.refund_reason]) || this.swap.refund_reason;
        },
      },
      async created() {
        await this.create();
        this.timers.push(
          setInterval(() => {
            if (this.remaining > 0) this.remaining -= 1;
          }, 1000),
        );
        this.timers.push(setInterval(() => this.tick(), 5000));
      },
      beforeDestroy() {
        this.timers.forEach(clearInterval);
      },
      methods: {
        async create() {
          try {
            const response = await fetch(config.apiBase, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ invoiceId: config.invoiceId, payInAsset: this.payInAsset }),
            });
            const body = await response.json();
            if (!response.ok) {
              this.error = body.message || "Could not prepare a payment address.";
              return;
            }
            this.apply(body);
          } catch {
            this.error = "Could not reach the server. Reload the page to try again.";
          }
        },
        apply(swap) {
          this.swap = swap;
          this.remaining = swap.expires_in_seconds;
        },
        async tick() {
          if (!this.swap) return;
          try {
            const response = await fetch(
              config.apiBase +
                "/" +
                encodeURIComponent(config.invoiceId) +
                "/" +
                encodeURIComponent(this.swap.swap_id),
            );
            if (response.ok) this.apply(await response.json());
          } catch {
            /* next tick */
          }
          await this.refreshInvoice();
        },
        // BTCPay's fetchData() is a no-op for plugin methods: read the invoice's
        // status for its Lightning method ourselves and hand it to the app.
        async refreshInvoice() {
          try {
            const response = await fetch(`${config.statusUrl}&paymentMethodId=BTC-LN`);
            if (!response.ok) return;
            const data = await response.json();
            const root = this.$parent;
            if (root && typeof root.updateData === "function") root.updateData(data);
          } catch {
            /* next tick */
          }
        },
        async requestRefund() {
          this.refundError = null;
          this.refunding = true;
          try {
            const response = await fetch(
              config.apiBase +
                "/" +
                encodeURIComponent(config.invoiceId) +
                "/" +
                encodeURIComponent(this.swap.swap_id) +
                "/refund",
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ refundAddress: this.refundAddress }),
              },
            );
            const body = await response.json();
            if (!response.ok) {
              this.refundError = body.message || "The refund could not be requested.";
              return;
            }
            this.apply(body);
          } catch {
            this.refundError = "Could not reach the server.";
          } finally {
            this.refunding = false;
          }
        },
        async copy(value) {
          // navigator.clipboard needs a secure context; a BTCPay served over plain http on a
          // LAN has none, so fall back to the selection-based copy every browser still supports.
          let copied = false;
          try {
            if (navigator.clipboard) {
              await navigator.clipboard.writeText(value);
              copied = true;
            }
          } catch {
            copied = false;
          }
          if (!copied) {
            const scratch = document.createElement("textarea");
            scratch.value = value;
            scratch.setAttribute("readonly", "");
            scratch.style.position = "fixed";
            scratch.style.opacity = "0";
            document.body.appendChild(scratch);
            scratch.select();
            try {
              copied = document.execCommand("copy");
            } catch {
              copied = false;
            }
            scratch.remove();
          }
          if (!copied) return;
          this.copied = value;
          setTimeout(() => {
            this.copied = null;
          }, 2000);
        },
      },
    };
  }

  return {
    register(Vue, config) {
      // BTCPay's own pills (Bitcoin, Lightning, LNURL) get the ₿ mark so every pill in the row
      // carries its coin. The rule lives in <head>: anything inside BTCPay's Vue root is
      // re-rendered (and a <style> there dropped) when the checkout app mounts.
      if (config.btcIcon && !document.getElementById("openreceive-pill-style")) {
        const style = document.createElement("style");
        style.id = "openreceive-pill-style";
        style.textContent =
          '.btcpay-pills > a.payment-method:not(.openreceive-pill)::before{content:"";display:inline-block;width:16px;height:16px;margin-right:.35rem;vertical-align:-3px;background:url("' +
          config.btcIcon +
          '") center/contain no-repeat}';
        document.head.appendChild(style);
      }
      for (const asset of config.assets) {
        Vue.component(`OpenReceiveSwap_${asset}Checkout`, definition(asset, config));
      }
    },
  };
})();
