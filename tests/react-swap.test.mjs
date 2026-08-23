import assert from "node:assert/strict";
import test from "node:test";

// Browser checkout now auto-attaches a console logger at INFO; these unit tests
// do not assert that output, so keep the runner quiet unless explicitly overridden.
process.env.LOG_LEVEL ??= "error";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createSwapDisplayModel,
  createTransactionDetails,
  createBlockExplorerUrl,
  createLightningInvoiceDecodeUrl,
  createDetailExternalLink,
  getExplorerNetwork,
  checkoutLabels,
} from "@openreceive/browser/headless";
// Test-only: an engine seam no renderer imports, read from its source module.
import { getSwapConfirmationWaitHint } from "../packages/js/browser/src/internal/checkout-swap-view.ts";
import { TransactionDetails, renderSwapDepositPanel } from "@openreceive/react";

test("swap confirming copy includes network-specific wait guidance", () => {
  assert.equal(getSwapConfirmationWaitHint("USDT_TRON"), "Confirmation usually takes 1–3 minutes.");
  assert.equal(
    getSwapConfirmationWaitHint("SOL_SOL"),
    "Confirmation usually takes under a minute.",
  );
  assert.equal(getSwapConfirmationWaitHint("ETH_ETH"), "Confirmation often takes 5–15 minutes.");

  const tron = createSwapDisplayModel({
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

  const eth = createSwapDisplayModel({
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

test("swap deposit warning stresses exact asset and network", () => {
  const deposit = createSwapDisplayModel({
    invoice_id: "or_inv_warn",
    rail: "swap",
    transaction_state: "pending",
    swap: {
      provider: "fixedfloat",
      pay_in_asset: "USDT_SOL",
      deposit_address: "SoLAddress",
      deposit_amount: "15.01",
      provider_state: "awaiting_deposit",
      provider_expires_at: Math.floor(Date.now() / 1000) + 600,
    },
  });
  assert.equal(deposit?.networkWarningTitle, "Wrong currency or network = lost funds");
  assert.equal(deposit?.networkWarningEmphasis, "15.01 USDT on the Solana network");
  assert.match(deposit?.networkWarning ?? "", /funds will be lost/);
  assert.match(deposit?.networkWarning ?? "", /Lightning invoice/);

  const html = renderToStaticMarkup(
    renderSwapDepositPanel({
      invoice: {
        invoice_id: "or_inv_warn_ui",
        rail: "swap",
        swap: {
          provider: "fixedfloat",
          pay_in_asset: "USDT_SOL",
          deposit_address: "SoLAddress",
          deposit_amount: "15.01",
          provider_state: "awaiting_deposit",
          provider_expires_at: Math.floor(Date.now() / 1000) + 600,
        },
      },
      onBack: () => undefined,
      onRefund: async () => undefined,
    }),
  );
  assert.match(html, /Wrong currency or network = lost funds/);
  assert.match(html, /15\.01 USDT on the Solana network/);
  assert.match(html, /role="alert"/);
  assert.match(html, /alert-error/);
});

test("browser builds block explorer and Lightning decode links for transaction details", () => {
  assert.equal(getExplorerNetwork("USDT_ETH"), "ETH");
  assert.equal(getExplorerNetwork("SOL_SOL"), "SOL");
  assert.equal(getExplorerNetwork("USDT_TRON"), "TRON");
  assert.equal(getExplorerNetwork("lightning"), undefined);

  assert.equal(
    createBlockExplorerUrl({
      payInAsset: "ETH_ETH",
      kind: "tx",
      value: "0xabc",
    }),
    "https://etherscan.io/tx/0xabc",
  );
  assert.equal(
    createBlockExplorerUrl({
      payInAsset: "USDC_ETH",
      kind: "address",
      value: "0xdef",
    }),
    "https://etherscan.io/address/0xdef",
  );
  assert.equal(
    createBlockExplorerUrl({
      payInAsset: "SOL_SOL",
      kind: "tx",
      value: "sig123",
    }),
    "https://solscan.io/tx/sig123",
  );
  assert.equal(
    createBlockExplorerUrl({
      payInAsset: "USDT_SOL",
      kind: "address",
      value: "SoLAddr",
    }),
    "https://solscan.io/account/SoLAddr",
  );
  assert.equal(
    createBlockExplorerUrl({
      payInAsset: "USDT_TRON",
      kind: "tx",
      value: "trx123",
    }),
    "https://tronscan.org/#/transaction/trx123",
  );
  assert.equal(
    createBlockExplorerUrl({
      payInAsset: "USDT_TRON",
      kind: "address",
      value: "TAddr",
    }),
    "https://tronscan.org/#/address/TAddr",
  );

  const invoice =
    "lnbc330n1p498rfepp5xdd2gx39pz59rh0uaqgnvnxgkcfl337vq3x7up478krszyllmlzqdqqcqzysxqyz5vqrzjqv3dpepm8kfdxrk3sl6wzqdf49s9c0h9ljtjrek6c08r6aejlwcnur0dwyqqvaqqqyqqqqlgqqqq86qqjqsp5l6z5cvzu7xdv0tjgu6890lxytmx6ecfua9x4pfvh567try3zynjq9qxpqysgqesq6nsr2snzzsrz9vvpnypf5q00w3c72ul02jex9qcpxkw3u63rq2ystseqkh26plwvaz6mwp2qawadp453m5veur4vytcqfhfqnsmsp957mtd";
  // No decoder is configured by default: the bolt11 must never reach a third party
  // unless the host opts in with a decode base URL.
  assert.equal(createLightningInvoiceDecodeUrl(invoice), undefined);
  const decodeLinkUrl = "https://rizful.com/decode_invoice";
  assert.equal(
    createLightningInvoiceDecodeUrl(invoice, decodeLinkUrl),
    `${decodeLinkUrl}?invoice=${encodeURIComponent(invoice)}`,
  );
  assert.equal(
    createLightningInvoiceDecodeUrl(`lightning:${invoice}`, decodeLinkUrl),
    `${decodeLinkUrl}?invoice=${encodeURIComponent(invoice)}`,
  );

  const addressLink = createDetailExternalLink({
    label: "Refund address",
    value: "0x019a427c0080c402e6B311B2D2A3538BEE4fc743",
    payInAsset: "ETH_ETH",
  });
  assert.equal(addressLink?.hrefLabel, checkoutLabels.viewOnExplorer);
  assert.equal(
    addressLink?.href,
    "https://etherscan.io/address/0x019a427c0080c402e6B311B2D2A3538BEE4fc743",
  );

  assert.equal(createDetailExternalLink({ label: "Lightning invoice", value: invoice }), undefined);
  const decodeLink = createDetailExternalLink({
    label: "Lightning invoice",
    value: invoice,
    decodeLinkUrl,
  });
  assert.equal(decodeLink?.hrefLabel, checkoutLabels.decodeInvoice);
  assert.match(decodeLink?.href ?? "", /rizful\.com\/decode_invoice\?invoice=/);

  const rows = createTransactionDetails({
    invoice,
    rail: "swap",
    decodeLinkUrl,
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
  assert.equal(byLabel["Lightning invoice"]?.hrefLabel, checkoutLabels.decodeInvoice);
  assert.equal(byLabel["Lightning payout"]?.href, undefined);
  assert.equal(byLabel["Provider order"]?.href, undefined);
  assert.equal(byLabel["Provider state"]?.value, "refunded");

  // Settled orders stop polling the swap provider, so the stored provider_state is a
  // pre-settlement snapshot. The row must say so instead of presenting it as live.
  const settledRows = createTransactionDetails({
    rail: "swap",
    transaction_state: "settled",
    settled_at: 1_700_000_000,
    swap: {
      provider: "fixedfloat",
      pay_in_asset: "USDT_SOL",
      deposit_address: "soladdr",
      deposit_amount: "10.55",
      provider_state: "awaiting_deposit",
      provider_expires_at: 1,
    },
  });
  const settledByLabel = Object.fromEntries(settledRows.map((row) => [row.label, row]));
  assert.equal(settledByLabel["Last provider state"]?.value, "awaiting_deposit");
  assert.equal(settledByLabel["Provider state"], undefined);

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
  assert.doesNotMatch(depositHtml, /etherscan\.io\/address\/0xdepositaddr/);
  assert.doesNotMatch(depositHtml, />Explorer</);
  assert.match(depositHtml, /readOnly/);
  assert.match(depositHtml, /aria-label="Address"/);
  assert.match(depositHtml, /aria-label="Amount"/);
  assert.match(depositHtml, /viewBox="0 0 16 16"/);

  const detailsHtml = renderToStaticMarkup(
    React.createElement(TransactionDetails, {
      state: {
        reference: "ord_tx",
        checkout_id: "chk_tx",
        invoice_id: "inv_tx",
        invoice: "lnbc-tx-detail",
        rail: "lightning",
        payment_hash: "ab".repeat(32),
        amount_msats: 1000,
        transaction_state: "settled",
        workflow_state: "paid",
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
  assert.match(detailsHtml, /aria-label="Copy"/);
  assert.match(detailsHtml, /btn-ghost/);
  assert.doesNotMatch(detailsHtml, />Copy</);
});

test("react refund screen warns to bookmark the checkout URL", () => {
  const html = renderToStaticMarkup(
    renderSwapDepositPanel({
      invoice: {
        invoice_id: "or_inv_refund",
        rail: "swap",
        transaction_state: "pending",
        swap: {
          attempt_id: "or_swp_refund",
          provider: "fixedfloat",
          provider_order_id: "ABC123",
          pay_in_asset: "USDT_SOL",
          deposit_address: "SoLDeposit",
          deposit_amount: "15.01",
          deposit_received_amount: "10.00",
          provider_state: "refund_required",
          refund_reason: "underpaid",
          provider_expires_at: Math.floor(Date.now() / 1000) + 600,
          deposit_tx_id:
            "3VPLchnKgC42q69meEZWnnGCYA1Lz8xXQzFeKy6tEQtsDgckwBWpxGjVrCvQH8ieHcJjjNUKRB6gL2VJJhCwLGmw",
        },
      },
      onBack: () => undefined,
      onRefund: async () => undefined,
    }),
  );
  assert.match(html, /Refund needed/);
  assert.match(html, /Payment details/);
  assert.ok(html.includes(checkoutLabels.refundReturnWarning));
  assert.ok(html.indexOf("Payment details") < html.indexOf(checkoutLabels.refundReturnWarning));
  assert.match(html, /Review refund address/);
});
