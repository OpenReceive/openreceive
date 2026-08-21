import { Controller } from "@hotwired/stimulus";

// Payer-facing copy for the terminal statuses in spec/openapi/openreceive-http.v1.yaml.
const TERMINAL_STATUS_MESSAGES = {
  expired: "This invoice expired.",
  failed: "This payment attempt failed.",
  not_found: "This payment attempt is no longer available.",
};

// Minimal checkout: create host order → /openreceive/checkouts → poll payments/check.
export default class extends Controller {
  static targets = ["createButton", "payPanel", "orderStatus", "invoice", "pollStatus", "error"];

  connect() {
    this.orderId = null;
    this.paymentHash = null;
    this.pollTimer = null;
  }

  disconnect() {
    this.stopPolling();
  }

  async createOrder(event) {
    event.preventDefault();
    this.clearError();
    this.createButtonTarget.disabled = true;
    try {
      const order = await this.postJson("/orders", {});
      this.orderId = order.order_id;
      this.orderStatusTarget.textContent = `Order ${this.orderId} · ${order.summary.total_amount.currency} ${order.summary.total_amount.value}`;

      const created = await this.postJson("/openreceive/checkouts", { order_id: this.orderId });
      const checkout = created.checkout;
      this.paymentHash = checkout.payment_hash;
      this.invoiceTarget.value = checkout.bolt11;
      this.payPanelTarget.classList.remove("hidden");
      this.startPolling();
    } catch (error) {
      this.showError(error);
      this.createButtonTarget.disabled = false;
    }
  }

  startPolling() {
    this.stopPolling();
    this.pollTimer = window.setInterval(() => {
      void this.checkPayment();
    }, 2000);
  }

  stopPolling() {
    if (this.pollTimer != null) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async checkPayment() {
    if (!this.orderId || !this.paymentHash) return;
    try {
      const result = await this.postJson("/openreceive/payments/check", {
        order_id: this.orderId,
        payment_hash: this.paymentHash,
      });
      // `pending` is the only status that can still change; everything else is
      // terminal, so keeping the interval alive would poll the wallet forever.
      if (result.status === "pending") {
        this.pollStatusTarget.textContent = "Waiting for payment…";
        return;
      }
      this.stopPolling();
      if (result.status === "settled") {
        this.pollStatusTarget.textContent = "Paid. Order fulfilled.";
        this.pollStatusTarget.classList.add("text-success");
        return;
      }
      this.pollStatusTarget.textContent = `${TERMINAL_STATUS_MESSAGES[result.status] ?? `Status: ${result.status}.`} Create a new order to try again.`;
      this.createButtonTarget.disabled = false;
    } catch (error) {
      this.showError(error);
    }
  }

  async postJson(url, body) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-CSRF-Token": this.csrfToken(),
      },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.message || `HTTP ${response.status}`);
    }
    return data;
  }

  csrfToken() {
    return document.querySelector("meta[name='csrf-token']")?.getAttribute("content") || "";
  }

  showError(error) {
    this.errorTarget.textContent = error instanceof Error ? error.message : String(error);
    this.errorTarget.classList.remove("hidden");
  }

  clearError() {
    this.errorTarget.textContent = "";
    this.errorTarget.classList.add("hidden");
  }
}
