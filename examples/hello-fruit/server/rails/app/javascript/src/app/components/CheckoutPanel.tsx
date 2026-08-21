import {
  createOpenReceiveLightningInvoiceDecodeUrl,
  OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES,
  openReceiveCheckoutLabels,
  orClasses,
} from "@openreceive/browser/headless";
import {
  CopyInvoiceButton,
  InvoiceSummary,
  PaymentData,
  QRCode,
  SatsDetail,
  WaitingState,
} from "@openreceive/react";
import { observer } from "mobx-react";
import type React from "react";
import { useContext } from "react";
import { ShopWorkspaceContext } from "../stores/ShopWorkspace.ts";
import MethodGrid from "./checkout/MethodGrid.tsx";

const rootDataAttribute = { [OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES.root]: "" };

/**
 * The checkout pane: Lightning QR + status on the left, payment info on the
 * right, method wizard below. A straight port of the widget's CheckoutView
 * markup, but every piece of state comes from the CheckoutFlow store.
 */
const CheckoutPanel: React.FC = observer(() => {
  const workspace = useContext(ShopWorkspaceContext);
  const checkout = workspace.checkout;
  if (checkout === null) return null;

  if (checkout.phase === "idle" || checkout.phase === "preparing") {
    return (
      <section
        className={`demo-checkout ${orClasses.creating} openreceive-checkout-creating`}
        {...rootDataAttribute}
      >
        <span className={orClasses.spinner} aria-hidden="true" />
        <p>Creating checkout…</p>
      </section>
    );
  }

  if (checkout.phase === "error") {
    return (
      <section
        className={`demo-checkout ${orClasses.creating} openreceive-checkout-error`}
        {...rootDataAttribute}
      >
        <p role="alert">Could not start checkout.</p>
        {checkout.prepareErrorMessage === null ? null : <p>{checkout.prepareErrorMessage}</p>}
        <button type="button" className={orClasses.btn} onClick={() => void checkout.prepare()}>
          Try again
        </button>
      </section>
    );
  }

  const state = checkout.state;
  if (state === undefined) return null;
  const statusModel = checkout.statusModel;
  const settled = checkout.settled;
  const expired = checkout.expired;
  const swapFocused = checkout.swapFocused;
  // Hide the Lightning pane when a swap deposit panel is focused or no bolt11
  // has been minted yet. Never blank the widget on expired/settled.
  const showLightning = state.invoice !== "" && !swapFocused && !expired;
  const hideLightning = !showLightning && !expired && !settled;
  const showSummaryMeta = settled || expired;
  const fiatCurrency = state.fiat_quote?.fiat?.currency;
  const decodeInvoiceHref = createOpenReceiveLightningInvoiceDecodeUrl(state.invoice);

  return (
    <section className={`demo-checkout ${orClasses.root}`} {...rootDataAttribute}>
      {checkout.mintingLightning ? (
        <div className={orClasses.creating}>
          <span className={orClasses.spinner} aria-hidden="true" />
          <p>{openReceiveCheckoutLabels.preparingPayment}</p>
        </div>
      ) : null}
      {hideLightning ? null : (
        <div
          className={expired || settled ? orClasses.paymentLayoutExpired : orClasses.paymentLayout}
        >
          {expired || settled || !showLightning ? null : (
            <div className={orClasses.lightningPane}>
              <QRCode invoice={state.invoice} className={orClasses.qr} />
              <SatsDetail
                amountLabel={checkout.amountLabel}
                fiatLabel={checkout.fiatLabel}
                fiatCurrency={fiatCurrency}
              />
            </div>
          )}
          <div className={orClasses.paymentInfo}>
            {expired || settled ? null : (
              <p className={orClasses.invoiceTitle}>
                {openReceiveCheckoutLabels.bitcoinLightningInvoice}
              </p>
            )}
            <WaitingState status={statusModel} settled={settled} />
            {statusModel.countdownLabel === undefined ? null : (
              <div className={orClasses.countdown}>
                {statusModel.countdownPrefix}{" "}
                <strong className={orClasses.countdownStrong}>{statusModel.countdownLabel}</strong>
              </div>
            )}
            {showSummaryMeta ? <InvoiceSummary status={checkout.status} /> : null}
            {settled ? (
              <PaymentData source={state} />
            ) : expired ? (
              <div
                className={orClasses.actions}
                {...{ [OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES.actions]: "" }}
              >
                <button
                  type="button"
                  className={orClasses.btn}
                  onClick={() => workspace.startOver()}
                >
                  {openReceiveCheckoutLabels.startOver}
                </button>
              </div>
            ) : (
              <div
                className={orClasses.actions}
                {...{ [OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES.actions]: "" }}
              >
                <CopyInvoiceButton
                  invoice={state.invoice}
                  copyInvoice={() => checkout.copyInvoice()}
                />
                {decodeInvoiceHref === undefined ? null : (
                  <a
                    className={orClasses.btn}
                    href={decodeInvoiceHref}
                    rel="noreferrer"
                    target="_blank"
                  >
                    {openReceiveCheckoutLabels.decodeInvoice}
                  </a>
                )}
              </div>
            )}
          </div>
        </div>
      )}
      {!settled && (!expired || swapFocused) ? <MethodGrid /> : null}
    </section>
  );
});

export default CheckoutPanel;
