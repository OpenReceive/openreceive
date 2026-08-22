/**
 * The payment method grid: the Bitcoin tile plus one tile per swap coin, with
 * the per-coin network reveal. This is the demo's ONE deliberate copy of
 * packaged UI, and it exists to prove a claim the other three Hello Fruit demos
 * cannot: that @openreceive/browser/headless drives a checkout from a non-React
 * state library. Every tile here reads MobX Keystone state (CheckoutFlow) and
 * every class string, label, accent and grid ordering comes from /headless — the
 * markup is the only thing that is ours.
 *
 * Deliberately NOT ported (see script/check-wizard-drift.mjs, which fails if any
 * of it creeps back without a reason): the route/provider/tutorial steps of the
 * packaged wizard. Those are pure presentation with no store involvement, they
 * are demonstrated by the node-express and nextjs demos that mount the packaged
 * <Checkout>, and their icons resolve through `new URL(..., import.meta.url)`,
 * which webpack freezes into a build-machine file:// path.
 */
import {
  type CheckoutSnapshot,
  formatOpenReceiveChooseNetworkHeading,
  formatOpenReceiveNetworkSummary,
  type OpenReceiveCheckoutPaymentMethod,
  type OpenReceivePaymentMethod,
  type OpenReceiveSwapMethodGroup,
  openReceiveAssetButtonClasses,
  openReceiveCheckoutLabels,
  openReceiveNetworkButtonClasses,
  openReceiveNetworkCheckClasses,
  openReceiveNetworkMobileRevealClasses,
  openReceiveNetworkSummaryIconClasses,
  openReceivePaymentAccentId,
  openReceiveSwapPickerKey,
  orClasses,
} from "@openreceive/browser/headless";
import { observer } from "mobx-react";
import type React from "react";
import { useContext } from "react";
import { assetIcon, methodIcon, networkIcon } from "../../helpers/icons.ts";
import type { CheckoutFlow } from "../../stores/CheckoutFlow.ts";
import { ShopWorkspaceContext } from "../../stores/ShopWorkspace.ts";
import { FocusedSwapFlow, swapGroupLimitOption, swapOptionLimitMessage } from "./SwapPanel.tsx";

type SwapGroup = OpenReceiveSwapMethodGroup<OpenReceiveCheckoutPaymentMethod>;

const MethodGrid: React.FC = observer(() => {
  const checkout = useContext(ShopWorkspaceContext).checkout;
  if (checkout === null) return null;
  if (checkout.focusedSwapAsset !== null) return <FocusedSwapFlow checkout={checkout} />;

  const entries = checkout.gridEntries;
  const snapshot = checkout.snapshot?.data;
  // A single-network coin starts on click, so only a multi-network coin opens
  // the network reveal.
  const revealedGroup = checkout.selectedSwapGroup;

  return (
    <div className={orClasses.wizard}>
      <header className={orClasses.wizardHeader}>
        <h2 id="payment-method-heading" className={orClasses.wizardHeaderTitle}>
          {openReceiveCheckoutLabels.wizardTitle}
        </h2>
        <p className={orClasses.wizardHeaderSubtitle}>{openReceiveCheckoutLabels.wizardSubtitle}</p>
      </header>
      {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: 1:1 port of the @openreceive/react wizard markup */}
      <div className={orClasses.wizardBody} aria-labelledby="payment-method-heading">
        {/* biome-ignore lint/a11y/useSemanticElements: 1:1 port — a fieldset would change the shared design */}
        <div
          role="group"
          aria-label={openReceiveCheckoutLabels.paymentMethod}
          className={orClasses.methodGrid}
        >
          {entries.map((entry) =>
            entry.kind === "method" ? (
              <MethodTile
                key={entry.method.id}
                checkout={checkout}
                methodId={entry.method.id}
                title={entry.method.title}
              />
            ) : (
              <SwapGroupTile
                key={openReceiveSwapPickerKey(entry.group.label)}
                checkout={checkout}
                group={entry.group}
                snapshot={snapshot}
              />
            ),
          )}
          {checkout.currenciesLoading ? (
            <div role="status" aria-live="polite" className={orClasses.methodCurrenciesLoading}>
              <span className={orClasses.spinner} aria-hidden="true" />
              <span className={orClasses.methodTitle}>
                {openReceiveCheckoutLabels.loadingCurrencies}
              </span>
            </div>
          ) : null}
        </div>
        {revealedGroup === undefined ? null : (
          <div className={orClasses.methodNetworkRevealDesktop}>
            <NetworkSelector checkout={checkout} group={revealedGroup} mobile={false} />
          </div>
        )}
      </div>
    </div>
  );
});

export default MethodGrid;

/**
 * The Bitcoin tile. There is no route/provider step here: selecting it mints (or
 * reuses) the bolt11 and the Lightning pane above the grid becomes the payment
 * target, which is what `rail === "lightning"` means.
 */
const MethodTile: React.FC<{
  checkout: CheckoutFlow;
  methodId: OpenReceivePaymentMethod;
  title: string;
}> = observer(({ checkout, methodId, title }) => {
  const busy = checkout.startingAsset !== null;
  const selected = checkout.lightningSelected;
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={openReceiveAssetButtonClasses({
        accent: openReceivePaymentAccentId(methodId),
        selected,
        disabled: busy,
      })}
      disabled={busy}
      aria-disabled={busy ? "true" : undefined}
      onClick={
        busy
          ? undefined
          : () => {
              checkout.selectLightning();
              // Idempotent: the store reuses a bolt11 with time left on it.
              void checkout.ensureLightning();
            }
      }
    >
      <span aria-hidden="true" className={orClasses.methodIconWrap}>
        <img alt="" className={orClasses.methodIcon} src={methodIcon(methodId)} />
      </span>
      <span className={orClasses.methodTitleWrap}>
        <span className={orClasses.methodTitle}>{title}</span>
      </span>
    </button>
  );
});

/** One coin in the grid: starts a swap directly, or reveals its networks first. */
const SwapGroupTile: React.FC<{
  checkout: CheckoutFlow;
  group: SwapGroup;
  snapshot: CheckoutSnapshot | undefined;
}> = observer(({ checkout, group, snapshot }) => {
  const groupKey = group.label.trim().toUpperCase();
  const pickerKey = openReceiveSwapPickerKey(group.label);
  const selected = checkout.selectedPickerKey === pickerKey;
  const multiNetwork = group.options.length > 1;
  const displayOption =
    group.options.find((option) => option.available !== false) ?? group.options[0];
  if (displayOption === undefined) return null;
  const selectedOption = group.options.find(
    (option) => option.pay_in_asset === checkout.selectedSwapNetworks[groupKey],
  );
  const startingAsset = checkout.startingAsset;
  const gridBusy = startingAsset !== null;
  const starting = group.options.some((option) => option.pay_in_asset === startingAsset);
  const disabled = group.options.every((option) => option.available === false);
  // A fully unavailable coin still says why, using the network with the lowest floor.
  const limitMessage = disabled
    ? swapOptionLimitMessage(swapGroupLimitOption(group.options) ?? displayOption, snapshot)
    : undefined;
  const panelId = `network-panel-${groupKey.toLowerCase()}`;

  return (
    <div className={orClasses.methodTile}>
      <button
        type="button"
        aria-pressed={starting || (multiNetwork && selected)}
        aria-expanded={multiNetwork ? selected : undefined}
        aria-controls={multiNetwork ? panelId : undefined}
        aria-busy={starting ? "true" : undefined}
        disabled={disabled || gridBusy}
        aria-disabled={disabled || gridBusy ? "true" : undefined}
        className={openReceiveAssetButtonClasses({
          accent: openReceivePaymentAccentId(group.label),
          selected: starting || (multiNetwork && selected),
          disabled: disabled || (gridBusy && !starting),
        })}
        onClick={
          disabled || gridBusy
            ? undefined
            : multiNetwork
              ? () => checkout.selectSwapGroup(pickerKey)
              : () => void checkout.startSwap(displayOption.pay_in_asset)
        }
      >
        <span aria-hidden="true" className={orClasses.methodIconWrap}>
          {starting ? (
            <span className={orClasses.spinner} aria-hidden="true" />
          ) : (
            <img alt="" className={orClasses.methodIcon} src={assetIcon(displayOption.label)} />
          )}
        </span>
        <span className={orClasses.methodTitleWrap}>
          <span className={orClasses.methodTitle}>{group.label}</span>
          {!disabled && multiNetwork ? (
            <span className={orClasses.methodDetailMobile}>
              {selected && selectedOption !== undefined
                ? `${selectedOption.network_label} network`
                : openReceiveCheckoutLabels.selectNetwork}
            </span>
          ) : null}
        </span>
      </button>
      {limitMessage === undefined ? null : (
        <span className={orClasses.methodLimitHint}>{limitMessage}</span>
      )}
      {multiNetwork ? (
        <div
          className={`${orClasses.methodNetworkRevealAnim} ${
            selected
              ? orClasses.methodNetworkRevealAnimOpen
              : orClasses.methodNetworkRevealAnimClosed
          }`}
        >
          <div className={orClasses.methodNetworkRevealInner}>
            {selected ? <NetworkSelector checkout={checkout} group={group} mobile /> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
});

/** Network choices for one multi-network coin, plus the Continue that starts the swap. */
const NetworkSelector: React.FC<{
  checkout: CheckoutFlow;
  group: SwapGroup;
  mobile: boolean;
}> = observer(({ checkout, group, mobile }) => {
  const accent = openReceivePaymentAccentId(group.label);
  const groupKey = group.label.trim().toUpperCase();
  const snapshot = checkout.snapshot?.data;
  const selectedOption = group.options.find(
    (option) => option.pay_in_asset === checkout.selectedSwapNetworks[groupKey],
  );
  const headingId = `network-heading-${groupKey.toLowerCase()}`;
  const startingAsset = checkout.startingAsset;
  const starting = selectedOption !== undefined && selectedOption.pay_in_asset === startingAsset;
  const limitMessage =
    selectedOption === undefined ? undefined : swapOptionLimitMessage(selectedOption, snapshot);
  const canContinue =
    selectedOption !== undefined && selectedOption.available !== false && startingAsset === null;

  return (
    // biome-ignore lint/a11y/useSemanticElements: 1:1 port — a fieldset would change the shared design
    <div
      id={`network-panel-${groupKey.toLowerCase()}`}
      role="group"
      aria-labelledby={headingId}
      className={
        mobile ? openReceiveNetworkMobileRevealClasses(accent) : orClasses.methodNetworkReveal
      }
    >
      <div className={orClasses.methodNetworkLayout}>
        <div>
          <h3 id={headingId} className={orClasses.methodNetworkHeading}>
            {formatOpenReceiveChooseNetworkHeading(group.label)}
          </h3>
          <p className={orClasses.methodNetworkHint}>
            {openReceiveCheckoutLabels.selectNetworkToContinue}
          </p>
        </div>
        {/* biome-ignore lint/a11y/useSemanticElements: 1:1 port — a fieldset would change the shared design */}
        <div role="group" aria-labelledby={headingId} className={orClasses.methodNetworkGrid}>
          {group.options.map((option) => {
            const optionDisabled = option.available === false;
            const optionSelected = option.pay_in_asset === selectedOption?.pay_in_asset;
            const optionLimit = swapOptionLimitMessage(option, snapshot);
            return (
              <div key={option.pay_in_asset} className={orClasses.methodTile}>
                <button
                  type="button"
                  aria-pressed={optionSelected}
                  disabled={optionDisabled}
                  aria-disabled={optionDisabled ? "true" : undefined}
                  className={openReceiveNetworkButtonClasses({
                    accent,
                    selected: optionSelected,
                    disabled: optionDisabled,
                  })}
                  onClick={
                    optionDisabled
                      ? undefined
                      : () => checkout.selectNetwork(groupKey, option.pay_in_asset)
                  }
                >
                  <span aria-hidden="true" className="grid size-6 shrink-0 place-items-center">
                    <img
                      alt=""
                      className={orClasses.methodNetworkIcon}
                      src={networkIcon(option.network_label)}
                    />
                  </span>
                  <span className="truncate">{option.network_label}</span>
                  {optionSelected ? (
                    <span aria-hidden="true" className={openReceiveNetworkCheckClasses(accent)}>
                      ✓
                    </span>
                  ) : null}
                </button>
                {optionDisabled && optionLimit !== undefined ? (
                  <span className={orClasses.methodLimitHint}>{optionLimit}</span>
                ) : null}
              </div>
            );
          })}
        </div>
        <button
          type="button"
          className={orClasses.methodConfirmDesktop}
          disabled={!canContinue}
          aria-disabled={canContinue ? undefined : "true"}
          aria-busy={starting ? "true" : undefined}
          onClick={
            canContinue && selectedOption !== undefined
              ? () => void checkout.startSwap(selectedOption.pay_in_asset)
              : undefined
          }
        >
          {starting ? (
            <>
              <span className={orClasses.continueSpinner} aria-hidden="true" />
              {openReceiveCheckoutLabels.preparingPayment}
            </>
          ) : selectedOption?.available === false && limitMessage !== undefined ? (
            limitMessage
          ) : (
            openReceiveCheckoutLabels.continue
          )}
        </button>
      </div>
      {selectedOption === undefined ? null : (
        <p aria-live="polite" className={orClasses.methodNetworkSummary}>
          <span aria-hidden="true" className={openReceiveNetworkSummaryIconClasses(accent)}>
            ✓
          </span>
          {formatOpenReceiveNetworkSummary(group.label, selectedOption.network_label)}
        </p>
      )}
    </div>
  );
});
