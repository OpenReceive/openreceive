import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const REACT_SRC_DIR = path.join(process.cwd(), "packages/js/react/src");
// The react package source is split across logical modules; read them all so
// structure assertions stay location-agnostic across future refactors.
function readReactSource() {
  return readdirSync(REACT_SRC_DIR)
    .filter((file) => file.endsWith(".ts"))
    .sort()
    .map((file) => readFileSync(path.join(REACT_SRC_DIR, file), "utf8"))
    .join("\n");
}
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  OPENRECEIVE_COPY_FEEDBACK_MS,
  OPENRECEIVE_DEFAULT_POLL_INTERVAL_MS,
  OPENRECEIVE_PROVIDER_PREVIEW_LIMIT,
  applyCheckoutThemeAttributes,
  applyOpenReceiveThemeAttributes,
  createOpenReceivePaymentWizardModel,
  createOpenReceivePaymentWizardSelection,
  createOpenReceivePaymentWizardState,
  createOpenReceiveStoredThemeModel,
  createOpenReceiveThemeModel,
  createOpenReceiveWizardRouteAssetDisplays,
  createOpenReceiveWizardRouteDisplays,
  formatOpenReceiveCountdown,
  formatOpenReceiveDepositAmount,
  getOpenReceiveAltcoinAssets,
  getOpenReceivePaymentMethodIcon,
  getOpenReceivePaymentStatusText,
  getCheckoutProviderIcon,
  getCheckoutProviderOpenLabel,
  getCheckoutProviderTutorials,
  getCheckoutProviderUsBadge,
  getOpenReceiveRouteIcon,
  getOpenReceiveRouteNetworkLabel,
  getOpenReceiveNetworkIcon,
  getOpenReceiveSwapOptionIcon,
  getOpenReceiveWizardEmptyMessage,
  createOpenReceiveSwapDisplayModel,
  createOpenReceiveTransactionDetails,
  createOpenReceiveBlockExplorerUrl,
  createOpenReceiveLightningInvoiceDecodeUrl,
  createOpenReceiveDetailExternalLink,
  getOpenReceiveExplorerNetwork,
  getOpenReceiveSwapConfirmationWaitHint,
  openReceiveCheckoutLabels,
  openReceivePaymentMethods,
  buildOpenReceiveMethodGridEntries,
  readOpenReceiveStoredCountryCode,
  readOpenReceiveThemePreference,
  resolveOpenReceiveTheme,
  syncOpenReceiveStoredThemeControls,
  toggleOpenReceiveStoredThemeControls,
  toggleOpenReceiveStoredThemePreference,
  updateOpenReceivePaymentWizardSelection,
  writeOpenReceiveStoredCountryCode,
  writeOpenReceiveThemePreference
} from "@openreceive/browser/internal";
import {
  getProvider,
} from "@openreceive/provider-data";
import {
  CopyInvoiceButton,
  InvoiceSummary,
  Checkout,
  PaymentWizard,
  PaymentState,
  CheckoutProvider,
  ThemeScope,
  ThemeToggle,
  TransactionDetails,
  OpenWalletButton,
  createCheckoutViewModel,
  renderSwapDepositPanel,
  useCheckoutContext
} from "@openreceive/react";

function invoice(overrides = {}) {
  const invoice = {
    invoice_id: overrides.invoice_id ?? "or_inv_test",
    invoice: overrides.invoice ?? "lnbc-test",
    payment_hash: overrides.payment_hash ?? "a".repeat(64),
    amount_msats: overrides.amount_msats ?? 200000,
    ...(Object.hasOwn(overrides, "fiat_quote")
      ? { fiat_quote: overrides.fiat_quote }
      : {
        fiat_quote: {
          fiat: {
            currency: "USD",
            value: "0.05"
          }
        }
      }),
    transaction_state: overrides.transaction_state ?? "pending",
    workflow_state: overrides.workflow_state ?? "invoice_created",
    ...(overrides.expires_at === undefined ? {} : { expires_at: overrides.expires_at }),
    ...(overrides.settled_at === undefined ? {} : { settled_at: overrides.settled_at })
  };
  return {
    checkout_id: overrides.checkout_id ?? `or_chk_${invoice.invoice_id}`,
    order_id: overrides.order_id ?? `order_${invoice.invoice_id}`,
    status: overrides.status ?? "open",
    amount_msats: overrides.amount_msats ?? invoice.amount_msats,
    ...(overrides.fiat === undefined ? {} : { fiat: overrides.fiat }),
    active: invoice,
    invoices: [invoice],
    ...(overrides.paid_at === undefined ? {} : { paid_at: overrides.paid_at })
  };
}

test("React checkout view model exposes display-safe actions", () => {
  const model = createCheckoutViewModel({
    checkout: invoice()
  });

  assert.equal(model.lightning_uri, "lightning:lnbc-test");
  assert.equal(model.amountLabel, "200 sats");
  assert.equal(model.fiatLabel, "$0.05");
  assert.equal(model.paymentHashLabel, "aaaaaaaa...aaaaaaaa");
  assert.equal(model.status, "pending");
});

test("React checkout view model falls back to selected checkout amount labels", () => {
  const satsModel = createCheckoutViewModel({
    checkout: invoice({
      amount_msats: 500000,
      fiat: {
        currency: "SATS",
        value: "500"
      },
      fiat_quote: null
    })
  });
  const btcModel = createCheckoutViewModel({
    checkout: invoice({
      amount_msats: 500000,
      fiat: {
        currency: "BTC",
        value: "0.00000500"
      },
      fiat_quote: null
    })
  });

  assert.equal(satsModel.amountLabel, "500 sats");
  assert.equal(satsModel.fiatLabel, "500 sats");
  assert.equal(btcModel.amountLabel, "500 sats");
  assert.equal(btcModel.fiatLabel, "0.00000500 BTC");
});

test("React checkout rejects NWC strings before rendering", () => {
  assert.throws(
    () =>
      createCheckoutViewModel({
        checkout: invoice({
          invoice: `nostr+walletconnect://${"a".repeat(64)}?secret=${"b".repeat(64)}`
        })
      }),
    /must not be an NWC/
  );
});

test("React checkout displays the Lightning invoice after a swap payment settles", () => {
  // A checkout paid via swap has no active invoice and its newest invoice is the settled
  // swap shadow, which carries no bolt11. The display must fall back to the payable
  // Lightning invoice instead of crashing. Regression for the post-swap checkout crash.
  const lightning = {
    invoice_id: "or_inv_display_swap",
    rail: "lightning",
    invoice: "lnbc-display-swap",
    payment_hash: "d".repeat(64),
    amount_msats: 19450000,
    transaction_state: "pending",
    workflow_state: "verifying",
    fiat_quote: null
  };
  const settledShadow = {
    invoice_id: "or_inv_shadow_swap",
    rail: "swap",
    invoice: null,
    payment_hash: "e".repeat(64),
    amount_msats: 19450000,
    transaction_state: "settled",
    workflow_state: "settlement_action_completed",
    settled_at: 1783518782,
    fiat_quote: null
  };
  const paidSwapCheckout = {
    checkout_id: "or_chk_paid_swap",
    order_id: "order-paid-swap",
    status: "paid",
    paid_at: 1783518782,
    amount_msats: 19450000,
    invoices: [settledShadow, lightning]
  };

  const model = createCheckoutViewModel({ checkout: paidSwapCheckout });
  assert.equal(model.invoice_id, "or_inv_display_swap");
  assert.equal(model.invoice, "lnbc-display-swap");
  assert.equal(model.status, "settled");

  const html = renderToStaticMarkup(
    React.createElement(Checkout, { checkout: paidSwapCheckout })
  );
  assert.match(html, /data-openreceive-checkout/);
});

test("React checkout default UI server-renders display-safe invoice data", () => {
  const html = renderToStaticMarkup(
    React.createElement(Checkout, {
      checkout: invoice({
        payment_hash: "b".repeat(64),
        amount_msats: 1000,
        fiat_quote: undefined
      })
    })
  );

  assert.match(html, /data-openreceive-checkout/);
  assert.match(html, /data-openreceive-theme="light"/);
  assert.match(html, /1 sat/);
  assert.match(html, /text-base-content\/60 text-sm leading-snug/);
  assert.match(html, /Bitcoin Lightning invoice/);
  assert.match(html, /Waiting for payment/);
  // Pending status is conveyed by WaitingState; avoid a redundant "pending" badge.
  assert.doesNotMatch(html, /data-openreceive-state="pending"/);
  assert.doesNotMatch(html, /bbbbbbbb\.\.\.bbbbbbbb/);
  assert.doesNotMatch(html, /textarea/);
  // BOLT11 may appear only in the Decode href — never as visible invoice text.
  assert.doesNotMatch(
    html.replace(/https:\/\/rizful\.com\/decode_invoice\?invoice=[^"'\s>]*/g, ""),
    /lnbc-test/,
  );
  assert.match(html, /Copy invoice/);
  assert.match(html, />Decode</);
  assert.match(html, /rizful\.com\/decode_invoice\?invoice=lnbc-test/);
  assert.doesNotMatch(html, /Open Wallet/);
  assert.doesNotMatch(html, /nostr\+walletconnect/);
});

test("React checkout default UI includes countdown, waiting state, and payment wizard", () => {
  const now = Math.floor(Date.now() / 1000);
  const html = renderToStaticMarkup(
    React.createElement(Checkout, {
      checkout: invoice({
        invoice_id: "or_inv_test",
        payment_hash: "b".repeat(64),
        amount_msats: 1000,
        fiat_quote: undefined,
        expires_at: now + 600
      })
    })
  );

  assert.match(html, /Waiting for payment/);
  assert.match(html, /Invoice expires in/);
  assert.match(html, /Pay this invoice/);
  assert.match(html, /Bitcoin/);
  assert.match(html, /Loading currencies/);
  assert.doesNotMatch(html, />Crypto</);
  assert.doesNotMatch(html, /Credit Card/);
  assert.doesNotMatch(html, /Bank Transfer/);
  assert.doesNotMatch(html, /textarea/);
  assert.doesNotMatch(
    html.replace(/https:\/\/rizful\.com\/decode_invoice\?invoice=[^"'\s>]*/g, ""),
    /lnbc-test/,
  );
  assert.doesNotMatch(html, /or_inv_test/);
});

test("React checkout hides payable surfaces after invoice expiry", () => {
  const html = renderToStaticMarkup(
    React.createElement(Checkout, {
      checkout: invoice({
        invoice_id: "or_inv_expired",
        invoice: "lnbc-expired",
        payment_hash: "c".repeat(64),
        amount_msats: 1000,
        fiat_quote: undefined,
        expires_at: Math.floor(Date.now() / 1000) - 1
      })
    })
  );

  assert.match(html, /Invoice expired/);
  assert.match(html, /Start over/);
  assert.doesNotMatch(html, /Invoice expires in/);
  assert.doesNotMatch(html, /data-openreceive-qr/);
  assert.doesNotMatch(html, /textarea/);
  assert.doesNotMatch(html, /Pay this invoice/);
  assert.doesNotMatch(html, /Copy invoice/);
});

test("React payment wizard server-renders the package-owned first choices", () => {
  const html = renderToStaticMarkup(
    React.createElement(PaymentWizard, {
      invoice: "lnbc-test"
    })
  );

  assert.match(html, /Pay this invoice/);
  assert.match(html, /Bitcoin/);
  assert.match(html, /Loading currencies/);
  assert.doesNotMatch(html, />Crypto</);
  assert.doesNotMatch(html, /Credit Card/);
  assert.doesNotMatch(html, /Bank Transfer/);
});

test("method grid never includes the standalone Crypto button", () => {
  const empty = buildOpenReceiveMethodGridEntries(openReceivePaymentMethods, []);
  assert.deepEqual(
    empty.map((entry) => (entry.kind === "method" ? entry.method.id : entry.group.label)),
    ["bitcoin"],
  );

  const withUsdt = buildOpenReceiveMethodGridEntries(openReceivePaymentMethods, [
    {
      label: "USDT",
      pay_in_asset: "USDT_TRON",
      network_label: "Tron",
      provider: "fixedfloat",
      available: true,
    },
  ]);
  assert.deepEqual(
    withUsdt.map((entry) => (entry.kind === "method" ? entry.method.id : entry.group.label)),
    ["bitcoin", "USDT"],
  );
  assert.equal(
    withUsdt.some((entry) => entry.kind === "method" && entry.method.id === "crypto"),
    false,
  );
});

test("swap confirming copy includes network-specific wait guidance", () => {
  assert.equal(
    getOpenReceiveSwapConfirmationWaitHint("USDT_TRON"),
    "Confirmation usually takes 1–3 minutes.",
  );
  assert.equal(
    getOpenReceiveSwapConfirmationWaitHint("SOL_SOL"),
    "Confirmation usually takes under a minute.",
  );
  assert.equal(
    getOpenReceiveSwapConfirmationWaitHint("ETH_ETH"),
    "Confirmation often takes 5–15 minutes.",
  );

  const tron = createOpenReceiveSwapDisplayModel({
    invoice_id: "or_inv_swap",
    rail: "swap",
    transaction_state: "pending",
    swap: {
      attempt_id: "or_swp_1",
      provider: "fixedfloat",
      provider_order_id: "FSMRBN",
      pay_in_asset: "USDT_TRON",
      deposit_address: "TTestAddress",
      deposit_amount: "12.00",
      provider_state: "confirming",
      provider_expires_at: Math.floor(Date.now() / 1000) + 600,
      deposit_tx_id: "0xabc",
    },
  });
  assert.equal(tron?.state, "progress");
  assert.equal(tron?.providerStateLabel, "Confirming payment");
  assert.match(tron?.providerStateDetail ?? "", /Tron/);
  assert.match(tron?.providerStateDetail ?? "", /1–3 minutes/);

  const eth = createOpenReceiveSwapDisplayModel({
    invoice_id: "or_inv_swap_eth",
    rail: "swap",
    transaction_state: "pending",
    swap: {
      attempt_id: "or_swp_2",
      provider: "fixedfloat",
      pay_in_asset: "ETH_ETH",
      deposit_address: "0xabc",
      deposit_amount: "0.01",
      provider_state: "confirming",
      provider_expires_at: Math.floor(Date.now() / 1000) + 600,
    },
  });
  assert.match(eth?.providerStateDetail ?? "", /Ethereum/);
  assert.match(eth?.providerStateDetail ?? "", /5–15 minutes/);
});

test("browser builds block explorer and Lightning decode links for transaction details", () => {
  assert.equal(getOpenReceiveExplorerNetwork("USDT_ETH"), "ETH");
  assert.equal(getOpenReceiveExplorerNetwork("SOL_SOL"), "SOL");
  assert.equal(getOpenReceiveExplorerNetwork("USDT_TRON"), "TRON");
  assert.equal(getOpenReceiveExplorerNetwork("lightning"), undefined);

  assert.equal(
    createOpenReceiveBlockExplorerUrl({
      payInAsset: "ETH_ETH",
      kind: "tx",
      value: "0xabc",
    }),
    "https://etherscan.io/tx/0xabc",
  );
  assert.equal(
    createOpenReceiveBlockExplorerUrl({
      payInAsset: "USDC_ETH",
      kind: "address",
      value: "0xdef",
    }),
    "https://etherscan.io/address/0xdef",
  );
  assert.equal(
    createOpenReceiveBlockExplorerUrl({
      payInAsset: "SOL_SOL",
      kind: "tx",
      value: "sig123",
    }),
    "https://solscan.io/tx/sig123",
  );
  assert.equal(
    createOpenReceiveBlockExplorerUrl({
      payInAsset: "USDT_SOL",
      kind: "address",
      value: "SoLAddr",
    }),
    "https://solscan.io/account/SoLAddr",
  );
  assert.equal(
    createOpenReceiveBlockExplorerUrl({
      payInAsset: "USDT_TRON",
      kind: "tx",
      value: "trx123",
    }),
    "https://tronscan.org/#/transaction/trx123",
  );
  assert.equal(
    createOpenReceiveBlockExplorerUrl({
      payInAsset: "USDT_TRON",
      kind: "address",
      value: "TAddr",
    }),
    "https://tronscan.org/#/address/TAddr",
  );

  const invoice =
    "lnbc330n1p498rfepp5xdd2gx39pz59rh0uaqgnvnxgkcfl337vq3x7up478krszyllmlzqdqqcqzysxqyz5vqrzjqv3dpepm8kfdxrk3sl6wzqdf49s9c0h9ljtjrek6c08r6aejlwcnur0dwyqqvaqqqyqqqqlgqqqq86qqjqsp5l6z5cvzu7xdv0tjgu6890lxytmx6ecfua9x4pfvh567try3zynjq9qxpqysgqesq6nsr2snzzsrz9vvpnypf5q00w3c72ul02jex9qcpxkw3u63rq2ystseqkh26plwvaz6mwp2qawadp453m5veur4vytcqfhfqnsmsp957mtd";
  assert.equal(
    createOpenReceiveLightningInvoiceDecodeUrl(invoice),
    `https://rizful.com/decode_invoice?invoice=${encodeURIComponent(invoice)}`,
  );
  assert.equal(
    createOpenReceiveLightningInvoiceDecodeUrl(`lightning:${invoice}`),
    `https://rizful.com/decode_invoice?invoice=${encodeURIComponent(invoice)}`,
  );

  const addressLink = createOpenReceiveDetailExternalLink({
    label: "Refund address",
    value: "0x019a427c0080c402e6B311B2D2A3538BEE4fc743",
    payInAsset: "ETH_ETH",
  });
  assert.equal(addressLink?.hrefLabel, openReceiveCheckoutLabels.viewOnExplorer);
  assert.equal(
    addressLink?.href,
    "https://etherscan.io/address/0x019a427c0080c402e6B311B2D2A3538BEE4fc743",
  );

  const decodeLink = createOpenReceiveDetailExternalLink({
    label: "Lightning invoice",
    value: invoice,
  });
  assert.equal(decodeLink?.hrefLabel, openReceiveCheckoutLabels.decodeInvoice);
  assert.match(decodeLink?.href ?? "", /rizful\.com\/decode_invoice\?invoice=/);

  const rows = createOpenReceiveTransactionDetails({
    invoice,
    rail: "swap",
    swap: {
      provider: "fixedfloat",
      pay_in_asset: "ETH_ETH",
      deposit_address: "0xdeposit",
      deposit_amount: "0.01",
      provider_state: "refunded",
      provider_expires_at: 1,
      deposit_tx_id: "0xdeposittx",
      refund_address: "0xrefund",
      refund_tx_id: "0xrefundtx",
      payout_tx_id: "ln-payout-ref",
      provider_order_id: "SVFBQ6",
    },
  });
  const byLabel = Object.fromEntries(rows.map((row) => [row.label, row]));
  assert.equal(byLabel["Deposit address"]?.href, "https://etherscan.io/address/0xdeposit");
  assert.equal(byLabel["Deposit transaction"]?.href, "https://etherscan.io/tx/0xdeposittx");
  assert.equal(byLabel["Refund address"]?.href, "https://etherscan.io/address/0xrefund");
  assert.equal(byLabel["Refund transaction"]?.href, "https://etherscan.io/tx/0xrefundtx");
  assert.equal(byLabel["Lightning invoice"]?.hrefLabel, openReceiveCheckoutLabels.decodeInvoice);
  assert.equal(byLabel["Lightning payout"]?.href, undefined);
  assert.equal(byLabel["Provider order"]?.href, undefined);

  const depositHtml = renderToStaticMarkup(
    renderSwapDepositPanel({
      invoice: {
        invoice_id: "or_inv_explorer",
        rail: "swap",
        swap: {
          provider: "fixedfloat",
          pay_in_asset: "ETH_ETH",
          deposit_address: "0xdepositaddr",
          deposit_amount: "0.01",
          provider_state: "awaiting_deposit",
          provider_expires_at: Math.floor(Date.now() / 1000) + 600,
        },
      },
      onBack: () => undefined,
      onRefund: async () => undefined,
    }),
  );
  assert.match(depositHtml, /etherscan\.io\/address\/0xdepositaddr/);
  assert.match(depositHtml, />Explorer</);

  const detailsHtml = renderToStaticMarkup(
    React.createElement(TransactionDetails, {
      state: {
        order_id: "ord_tx",
        checkout_id: "chk_tx",
        invoice_id: "inv_tx",
        invoice: "lnbc-tx-detail",
        rail: "lightning",
        payment_hash: "ab".repeat(32),
        amount_msats: 1000,
        transaction_state: "settled",
        workflow_state: "settled",
        phase: "settled",
        settled: true,
        terminal: true,
        paid: true,
        lightning_uri: "lightning:lnbc-tx-detail",
      },
    }),
  );
  assert.match(detailsHtml, /Transaction details/);
  assert.match(detailsHtml, /lnbc-tx-detail/);
  assert.match(detailsHtml, />Copy</);
});

test("React theme toggle renders a package-owned light/dark switch", () => {
  const html = renderToStaticMarkup(
    React.createElement(ThemeToggle, {
      theme: "dark",
      resolvedTheme: "dark"
    })
  );

  assert.match(html, /data-openreceive-theme-toggle/);
  assert.match(html, /dark mode/);
  assert.doesNotMatch(html, /or-theme-toggle-icon-dark/);
});

test("React theme scope applies package-owned theme attributes and toggle", () => {
  const storage = {
    getItem: () => "dark",
    setItem: () => undefined,
    removeItem: () => undefined,
    clear: () => undefined,
    key: () => null,
    length: 0
  };
  const html = renderToStaticMarkup(
    React.createElement(
      ThemeScope,
      {
        as: "main",
        className: "app-shell",
        storage,
        themeToggle: true,
        topbarClassName: "topbar",
        themeToggleClassName: "theme-button"
      },
      React.createElement("section", { className: "checkout" }, "Checkout")
    )
  );

  assert.match(html, /<main class="app-shell" data-theme="dark" data-openreceive-theme="dark"/);
  assert.match(html, /class="topbar"/);
  assert.match(html, /class="[^"]*theme-button/);
  assert.match(html, /data-openreceive-theme-toggle/);
  assert.match(html, /dark mode/);
  assert.match(html, /<section class="checkout">Checkout<\/section>/);
});

test("Browser checkout helpers own wizard state, storage, and theme behavior", () => {
  const store = new Map();
  const storage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear(),
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    }
  };

  assert.equal(formatOpenReceiveCountdown(65), "1:05");
  assert.equal(formatOpenReceiveDepositAmount("12.25900000"), "12.259");
  assert.equal(formatOpenReceiveDepositAmount("5.000"), "5");
  assert.equal(formatOpenReceiveDepositAmount("1.05"), "1.05");
  assert.equal(formatOpenReceiveDepositAmount("0.0008"), "0.0008");
  assert.equal(formatOpenReceiveDepositAmount("100"), "100");
  assert.equal(OPENRECEIVE_DEFAULT_POLL_INTERVAL_MS, 3000);
  assert.equal(OPENRECEIVE_COPY_FEEDBACK_MS, 1800);
  assert.equal(OPENRECEIVE_PROVIDER_PREVIEW_LIMIT, 4);
  assert.equal(openReceiveCheckoutLabels.copyInvoice, "Copy invoice");
  assert.equal(
    openReceiveCheckoutLabels.bitcoinLightningInvoice,
    "Bitcoin Lightning invoice",
  );
  assert.equal(getOpenReceivePaymentStatusText("settled").title, "Payment received");
  assert.equal(getOpenReceiveWizardEmptyMessage("bitcoin"), "Choose Bitcoin Lightning.");
  assert.equal(getCheckoutProviderOpenLabel("Boltz"), "How To Pay");
  assert.equal(getCheckoutProviderUsBadge(true), null);
  assert.equal(getCheckoutProviderUsBadge(null), null);
  const strike = getProvider("strike");
  assert.ok(strike);
  assert.match(getCheckoutProviderIcon(strike), /assets\/provider-icons\/strike\.png/);
  assert.deepEqual(
    getCheckoutProviderTutorials(strike).map((tutorial) => tutorial.caption),
    [
      "Tap Send",
      "Choose Bitcoin wallet",
      "Tap Paste",
      "Confirm the payment"
    ]
  );
  const coinbase = getProvider("coinbase");
  const kraken = getProvider("kraken");
  assert.ok(coinbase);
  assert.ok(kraken);
  assert.match(getCheckoutProviderTutorials(coinbase)[0].image, /assets\/pay_tutorials\/coinbase-1\.webp/);
  assert.match(getCheckoutProviderTutorials(kraken)[3].image, /assets\/pay_tutorials\/kraken-4\.webp/);
  assert.equal(getOpenReceiveRouteNetworkLabel("btc-lightning"), "Lightning Network");
  assert.equal(getOpenReceiveRouteNetworkLabel("usdt-tron"), "usdt-tron");
  assert.match(getOpenReceivePaymentMethodIcon("bitcoin"), /assets\/icons\/btc\.svg/);
  assert.match(getOpenReceiveRouteIcon({ symbol: "btc", route: "btc-lightning" }), /assets\/icons\/lightning\.svg/);
  assert.match(getOpenReceiveRouteIcon({ symbol: "usdt", route: "usdt-tron" }), /assets\/icons\/usdt\.svg/);
  assert.match(
    getOpenReceiveSwapOptionIcon({ label: "USDT", network_label: "Tron" }),
    /assets\/icons\/usdt\.svg/,
  );
  assert.match(
    getOpenReceiveSwapOptionIcon({ label: "USDC", network_label: "Solana" }),
    /assets\/icons\/usdc\.svg/,
  );
  assert.match(getOpenReceiveNetworkIcon("Tron"), /assets\/icons\/trx\.svg/);
  assert.match(getOpenReceiveNetworkIcon("Solana"), /assets\/icons\/sol\.svg/);
  assert.match(getOpenReceiveNetworkIcon("Ethereum"), /assets\/icons\/eth\.svg/);
  assert.equal(resolveOpenReceiveTheme("system", { systemDark: true }), "dark");
  assert.deepEqual(createOpenReceiveThemeModel("system", { systemDark: true }), {
    theme: "system",
    resolvedTheme: "dark",
    nextTheme: "light",
    toggleLabel: "dark mode",
    attributes: {
      "data-theme": "dark",
      "data-openreceive-theme": "dark"
    },
    checkoutElementAttributes: {
      theme: "dark"
    }
  });
  assert.equal(readOpenReceiveThemePreference({ storage, defaultTheme: "dark" }), "dark");
  assert.equal(readOpenReceiveThemePreference({ storage }), "system");
  writeOpenReceiveThemePreference("dark", { storage });
  assert.equal(readOpenReceiveThemePreference({ storage }), "dark");
  const storedThemeModel = createOpenReceiveStoredThemeModel({ storage });
  assert.deepEqual(storedThemeModel, {
    theme: "dark",
    resolvedTheme: "dark",
    nextTheme: "light",
    toggleLabel: "dark mode",
    attributes: {
      "data-theme": "dark",
      "data-openreceive-theme": "dark"
    },
    checkoutElementAttributes: {
      theme: "dark"
    }
  });
  const themeAttrs = {};
  const checkoutAttrs = {};
  applyOpenReceiveThemeAttributes({
    setAttribute: (name, value) => {
      themeAttrs[name] = value;
    }
  }, storedThemeModel);
  applyCheckoutThemeAttributes({
    setAttribute: (name, value) => {
      checkoutAttrs[name] = value;
    }
  }, storedThemeModel);
  assert.deepEqual(themeAttrs, {
    "data-theme": "dark",
    "data-openreceive-theme": "dark"
  });
  assert.deepEqual(checkoutAttrs, {
    theme: "dark"
  });
  assert.equal(toggleOpenReceiveStoredThemePreference({ storage }).resolvedTheme, "light");
  assert.equal(readOpenReceiveThemePreference({ storage }), "light");
  const controlAttrs = {};
  const checkoutControlAttrs = {};
  const toggleControl = { textContent: "" };
  const controlTheme = syncOpenReceiveStoredThemeControls({
    root: {
      setAttribute: (name, value) => {
        controlAttrs[name] = value;
      }
    },
    checkout: {
      setAttribute: (name, value) => {
        checkoutControlAttrs[name] = value;
      }
    },
    toggle: toggleControl
  }, { storage });
  assert.equal(controlTheme.resolvedTheme, "light");
  assert.equal(controlAttrs["data-openreceive-theme"], "light");
  assert.equal(checkoutControlAttrs.theme, "light");
  assert.equal(toggleControl.textContent, "light mode");
  const toggledControlTheme = toggleOpenReceiveStoredThemeControls({
    toggle: toggleControl
  }, { storage });
  assert.equal(toggledControlTheme.resolvedTheme, "dark");
  assert.equal(toggleControl.textContent, "dark mode");
  writeOpenReceiveStoredCountryCode("us", { storage });
  assert.equal(readOpenReceiveStoredCountryCode({ storage }), "US");

  const initialSelection = createOpenReceivePaymentWizardSelection({
    storedCountryCode: "US"
  });
  assert.deepEqual({
    method: initialSelection.selectedMethod,
    country: initialSelection.selectedCountryCode,
    region: initialSelection.selectedRegion,
    picker: initialSelection.countryPickerOpen
  }, {
    method: null,
    country: "US",
    region: "north-america",
    picker: false
  });

  const methodSelection = updateOpenReceivePaymentWizardSelection(initialSelection, {
    type: "select_method",
    method: "bitcoin"
  });
  assert.equal(methodSelection.selectedMethod, "bitcoin");
  assert.equal(methodSelection.selectedBitcoinRoute, "btc-lightning");
  assert.equal(methodSelection.countryPickerOpen, false);

  const changedMethodSelection = updateOpenReceivePaymentWizardSelection(methodSelection, {
    type: "change_method"
  });
  assert.equal(changedMethodSelection.selectedMethod, null);
  assert.equal(changedMethodSelection.selectedCountryCode, methodSelection.selectedCountryCode);
  assert.equal(changedMethodSelection.countryPickerOpen, false);

  const bitcoinSelection = updateOpenReceivePaymentWizardSelection(changedMethodSelection, {
    type: "select_method",
    method: "bitcoin"
  });
  assert.equal(bitcoinSelection.selectedBitcoinRoute, "btc-lightning");
  const routeModel = createOpenReceivePaymentWizardModel(bitcoinSelection);
  assert.equal(routeModel.selectedRoute, "btc-lightning");
  assert.ok(routeModel.routeAssets.length > 0);
  assert.equal(routeModel.wizard.railCountries.length, 0);
  const routeAssetDisplays = createOpenReceiveWizardRouteAssetDisplays(routeModel.routeAssets, {
    selectedRoute: routeModel.selectedRoute
  });
  const lightningRouteAsset = routeAssetDisplays.find((asset) => asset.id === "btc-lightning");
  assert.equal(lightningRouteAsset?.selected, true);
  assert.equal(lightningRouteAsset?.subtitle, "Lightning Network");
  assert.match(lightningRouteAsset?.icon ?? "", /assets\/icons\/lightning\.svg/);

  const bitcoinState = createOpenReceivePaymentWizardState({
    selectedMethod: "bitcoin",
    selectedBitcoinRoute: "btc-lightning"
  });
  assert.equal(bitcoinState.selectedRail, null);
  assert.equal(bitcoinState.selectedRouteId, "btc-lightning");
  assert.ok(bitcoinState.routes.length > 0);
  const bitcoinRouteDisplays = createOpenReceiveWizardRouteDisplays(bitcoinState.routes);
  assert.equal(bitcoinRouteDisplays[0].providers.length, bitcoinState.routes[0].providers.length);
  assert.equal(
    createOpenReceiveWizardRouteDisplays(bitcoinState.routes, {
      providerPreviewLimit: OPENRECEIVE_PROVIDER_PREVIEW_LIMIT
    })[0].providers.length <= OPENRECEIVE_PROVIDER_PREVIEW_LIMIT,
    true
  );
  assert.equal(bitcoinRouteDisplays[0].providers[0].copyLabel, openReceiveCheckoutLabels.copyInvoice);
  assert.equal(bitcoinRouteDisplays[0].providers[0].copiedLabel, openReceiveCheckoutLabels.copied);
  assert.equal(bitcoinRouteDisplays[0].providers[0].openLabel, "How To Pay");
  assert.equal(bitcoinRouteDisplays[0].providers[0].kind, "browser wallet");
  assert.equal(
    bitcoinRouteDisplays[0].providers.find((provider) => provider.id === "zeus")?.kind,
    "mobile wallet"
  );
  const strikeProvider = bitcoinRouteDisplays[0].providers.find((provider) => provider.id === "strike");
  assert.ok(strikeProvider);
  assert.match(strikeProvider.url, /^https:\/\/docs\.strike\.me/);
  assert.match(strikeProvider.icon, /assets\/provider-icons\/strike\.png/);
  assert.equal(strikeProvider.tutorials.length, 4);
  assert.match(strikeProvider.tutorials[0].image, /assets\/pay_tutorials\/strike-1\.webp/);

  const firstCrypto = getOpenReceiveAltcoinAssets().find((asset) => asset.route !== undefined);
  assert.ok(firstCrypto?.route);
  const cryptoState = createOpenReceivePaymentWizardState({
    selectedMethod: "crypto",
    selectedCryptoRoute: firstCrypto.route
  });
  assert.equal(cryptoState.selectedRail, null);
  assert.equal(cryptoState.selectedRouteId, firstCrypto.route);
  assert.ok(cryptoState.routes.length > 0);
});

test("React payment state primitive renders current state", () => {
  const html = renderToStaticMarkup(
    React.createElement(PaymentState, {
      state: "settled"
    })
  );

  assert.match(html, /data-openreceive-state="settled"/);
  assert.match(html, />settled</);
});

test("React checkout supports design-system component and class slots", () => {
  function CustomQr(props) {
    return React.createElement(
      "figure",
      {
        className: props.className,
        "data-slot-qr": props.invoice
      },
      "QR"
    );
  }

  function CustomPaymentState(props) {
    return React.createElement(
      "strong",
      {
        className: props.className,
        "data-slot-state": props.state
      },
      props.state
    );
  }

  function CustomSummary(props) {
    return React.createElement(
      "aside",
      {
        className: props.className,
        "data-slot-summary": ""
      },
      props.amountLabel,
	      React.createElement(props.PaymentStateComponent, {
	        state: props.status,
	        className: props.classNames.paymentState
	      })
	    );
  }

  function CustomButton(props) {
    return React.createElement(
      "button",
      {
        className: props.className,
        type: props.type,
        "data-slot-button": ""
      },
      props.children
    );
  }

  const html = renderToStaticMarkup(
    React.createElement(Checkout, {
      checkout: invoice({
        invoice: "lnbc-slot-test",
        payment_hash: "c".repeat(64),
        amount_msats: 200000,
        fiat_quote: undefined,
        // Summary meta (and PaymentState slot) only render for terminal statuses.
        transaction_state: "settled",
        workflow_state: "settlement_action_completed",
        settled_at: 1_700_000_000
      }),
      components: {
        Button: CustomButton,
        QRCode: CustomQr,
        InvoiceSummary: CustomSummary,
        PaymentState: CustomPaymentState
      },
      classNames: {
        root: "app-root",
        qr: "app-qr",
        summary: "app-summary",
        paymentState: "app-state",
        copyButton: "app-copy",
        openWalletButton: "app-open"
      }
    })
  );

  assert.match(html, /app-root/);
  assert.match(html, /data-slot-qr="lnbc-slot-test"/);
  assert.match(html, /app-qr/);
  assert.match(html, /data-slot-summary=""/);
  assert.match(html, /app-summary/);
  assert.match(html, /data-slot-state="settled"/);
  assert.match(html, /app-state/);
  assert.match(html, /data-slot-button=""/);
  assert.match(html, /app-copy/);
  assert.match(html, />Copy invoice</);
  assert.doesNotMatch(html, /class="app-open"/);
  assert.doesNotMatch(html, />Open Wallet</);
  assert.doesNotMatch(html, /nostr\+walletconnect/);
});

test("React checkout render prop can replace default visible markup", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      Checkout,
      {
        checkout: invoice({
          invoice_id: "or_inv_render_prop",
          invoice: "lnbc-render-prop",
          amount_msats: 1000,
          fiat_quote: undefined,
          workflow_state: "verifying",
          expires_at: 9999999999
        })
      },
      (checkout) =>
        React.createElement(
          "p",
          {
            "data-custom-checkout": checkout.amountLabel,
            "data-status": checkout.status,
            "data-countdown": checkout.countdownLabel
          },
          checkout.lightning_uri,
          " ",
          checkout.countdownLabel
        )
    )
  );

  assert.match(html, /data-openreceive-checkout/);
  assert.match(html, /data-custom-checkout="1 sat"/);
  assert.match(html, /data-status="pending"/);
  assert.match(html, /data-countdown=/);
  assert.match(html, />lightning:lnbc-render-prop /);
  assert.doesNotMatch(html, /aria-label="Lightning invoice"/);
});

test("React provider shares checkout state with a consumer hook", () => {
  function CheckoutConsumer() {
    const checkout = useCheckoutContext();
    return React.createElement(
      "strong",
      { "data-provider-amount": checkout.amountLabel },
      checkout.lightning_uri
    );
  }

  const html = renderToStaticMarkup(
    React.createElement(
      CheckoutProvider,
      {
        checkout: invoice({
          invoice: "lnbc-provider-context",
          amount_msats: 1000,
          fiat_quote: undefined
        })
      },
      React.createElement(CheckoutConsumer)
    )
  );

  assert.match(html, /data-provider-amount="1 sat"/);
  assert.match(html, />lightning:lnbc-provider-context</);
});

test("React provider render prop receives the controller-backed checkout model", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      CheckoutProvider,
      {
        checkout: invoice({
          invoice_id: "or_inv_provider_render",
          invoice: "lnbc-provider-render",
          amount_msats: 2000,
          fiat_quote: undefined
        })
      },
      (checkout) =>
        React.createElement(
          "span",
          {
            "data-provider-render": checkout.amountLabel,
            "data-provider-status": checkout.status,
            "data-provider-reload": typeof checkout.reloadState,
            "data-provider-retry": typeof checkout.retry,
            "data-provider-cancel": typeof checkout.cancel
          },
          checkout.lightning_uri
        )
    )
  );

  assert.match(html, /data-provider-render="2 sats"/);
  assert.match(html, /data-provider-status="pending"/);
  assert.match(html, /data-provider-reload="function"/);
  assert.match(html, /data-provider-retry="function"/);
  assert.match(html, /data-provider-cancel="function"/);
  assert.match(html, />lightning:lnbc-provider-render</);
});

test("React checkout context fails clearly outside the provider", () => {
  function CheckoutConsumer() {
    useCheckoutContext();
    return React.createElement("span", null, "never");
  }

  assert.throws(
    () => renderToStaticMarkup(React.createElement(CheckoutConsumer)),
    /CheckoutProvider/
  );
});

test("React <Checkout orderId> enters create mode and renders the creating placeholder", () => {
  // react-dom/server does not run effects, so the on-mount create POST is not observable from
  // an SSR render; the create -> POST { order_id } -> poll /openreceive/orders/<id>-with-token
  // lifecycle the component runs is verified end-to-end via createOpenReceiveCheckoutSession in
  // tests/v0.1/order-token.test.mjs. Here we assert the component enters create mode and shows
  // its minimal placeholder while pending.
  const html = renderToStaticMarkup(
    React.createElement(Checkout, { orderId: "ord-1", prefix: "/openreceive" })
  );
  assert.match(html, /openreceive-checkout-creating/);
  assert.match(html, /Creating checkout/);
  assert.doesNotMatch(html, />Copy invoice</);

  // A create with the default prefix (no prefix prop) also enters create mode.
  const defaultPrefixHtml = renderToStaticMarkup(
    React.createElement(Checkout, { orderId: "ord-2" })
  );
  assert.match(defaultPrefixHtml, /openreceive-checkout-creating/);
});

test("React <Checkout checkout> snapshot mode is unchanged (backward compatible)", () => {
  const html = renderToStaticMarkup(
    React.createElement(Checkout, { checkout: invoice(), orderUrl: "/order" })
  );
  assert.match(html, /data-openreceive-checkout/);
  assert.match(html, />Copy invoice</);
  assert.doesNotMatch(html, /openreceive-checkout-creating/);
});

test("React primitive aliases point to the stable components", () => {
  assert.equal(InvoiceSummary, InvoiceSummary);
  assert.equal(CopyInvoiceButton, CopyInvoiceButton);
  assert.equal(OpenWalletButton, OpenWalletButton);
  assert.equal(PaymentState, PaymentState);
});

test("React package centralizes transient copy feedback timing", () => {
  const source = readReactSource();

  assert.match(source, /function useOpenReceiveTransientValue/);
  assert.match(source, /createOpenReceiveTransientFeedbackController/);
  assert.doesNotMatch(source, /globalThis\.setTimeout/);
  assert.equal(source.match(/OPENRECEIVE_COPY_FEEDBACK_MS/g)?.length, 2);
  assert.doesNotMatch(source, /setCopied\(false\)/);
  assert.doesNotMatch(source, /setCopiedProviderId\(null\)/);
});

test("React package exposes shared browser-owned checkout styles", () => {
  const manifest = JSON.parse(readFileSync(
    path.join(process.cwd(), "packages/js/react/package.json"),
    "utf8"
  ));
  const browserStyles = readFileSync(
    path.join(process.cwd(), "packages/js/browser/src/styles.css"),
    "utf8"
  );
  const reactStyles = readFileSync(
    path.join(process.cwd(), "packages/js/react/src/styles.css"),
    "utf8"
  );

  assert.equal(manifest.exports["./styles.css"], "./dist/styles.css");
  assert.match(browserStyles, /\.btn|@layer/);
  assert.match(reactStyles, /@openreceive\/browser\/styles\.css/);
});

test("React default checkout passes controller actions into default buttons", () => {
  const source = readReactSource();

  assert.match(source, /copyInvoice: checkoutModel\.copyInvoice/);
  assert.doesNotMatch(source, /openWallet: checkoutModel\.openWallet/);
  assert.match(source, /copyInvoice === undefined/);
  assert.match(source, /openWallet === undefined/);
});

test("React checkout can disable default status refresh polling", () => {
  const source = readReactSource();

  assert.match(source, /orderUrl\?: string \| false/);
  assert.match(source, /polling\?: boolean/);
  assert.match(source, /function resolveCheckoutStatusRefreshUrl/);
  assert.match(source, /options\.polling === false \|\| options\.orderUrl === false/);
  assert.match(source, /options\.polling === false \? undefined : options\.refreshStatus/);
  assert.match(source, /\.\.\.\(orderUrl === undefined \? \{\} : \{ orderUrl \}\)/);
  assert.doesNotMatch(source, /orderUrl: options\.orderUrl \?\? DEFAULT_STATUS_URL/);
});

test("React checkout recreates its poll controller only on checkout identity change", () => {
  // The controller pushes every poll result back through onSnapshot ->
  // setLatestSnapshot. If the controller-creation effect keys on that mutable
  // snapshot, each poll result tears the controller down and recreates it, which
  // immediately re-polls in a tight loop. It must key on a stable identity and
  // seed from a ref instead, while still feeding poll results to the display.
  // Inline host logger/onError must also stay out of that dependency list — after
  // settlement, onState often setStates the parent, minting a new onError each
  // render and looping recreate → reloadState → ERR_INSUFFICIENT_RESOURCES.
  const source = readReactSource();

  assert.match(
    source,
    /const checkoutIdentity = `\$\{snapshot\.checkout_id\} \$\{snapshot\.order_id\}`/
  );
  assert.match(source, /snapshotRef\.current = snapshot/);
  assert.match(source, /snapshot: snapshotRef\.current/);
  assert.match(source, /onSnapshot: setLatestSnapshot/);
  assert.match(source, /loggerRef\.current = options\.logger/);
  assert.match(source, /onErrorRef\.current = options\.onError/);
  // The controller-creation effect's dependency list keys on the identity, not
  // the mutable snapshot the controller itself replaces on every poll, and not
  // unstable host callbacks.
  assert.match(source, /\}, \[checkoutIdentity, refreshStatus, orderUrl, options\.pollIntervalMs\]/);
  assert.doesNotMatch(source, /\}, \[\s*snapshot,\s*refreshStatus,\s*orderUrl,/);
  assert.doesNotMatch(
    source,
    /options\.pollIntervalMs,\s*options\.logger,\s*options\.onError/,
  );
});
