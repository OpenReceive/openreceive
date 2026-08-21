import { copyInvoice as copyInvoiceHelper } from "@openreceive/browser";
import {
  type CheckoutSnapshot,
  createCheckoutProviderCopyEvent,
  createOpenReceiveLightningInvoiceDecodeUrl,
  createOpenReceivePaymentWizardModel,
  createOpenReceiveWizardRouteDisplays,
  formatOpenReceiveChooseNetworkHeading,
  formatOpenReceiveNetworkSummary,
  getOpenReceiveRouteNetworkLabel,
  type OpenReceiveCheckoutPaymentMethod,
  type OpenReceivePaymentMethod,
  type OpenReceivePaymentWizardModel,
  type OpenReceiveSwapMethodGroup,
  type OpenReceiveWizardProviderDisplay,
  openReceiveAssetButtonClasses,
  openReceiveCheckoutLabels,
  openReceiveNetworkButtonClasses,
  openReceiveNetworkCheckClasses,
  openReceiveNetworkMobileRevealClasses,
  openReceiveNetworkSummaryIconClasses,
  openReceivePaymentAccentId,
  openReceiveSwapAssetMatchesRoute,
  openReceiveSwapPickerKey,
  orClasses,
} from "@openreceive/browser/headless";
import { observer } from "mobx-react";
import type React from "react";
import { useContext, useEffect, useRef } from "react";
import {
  assetIcon,
  methodIcon,
  networkIcon,
  packagedRuntimeAssetUrl,
  routeIcon,
} from "../../helpers/icons.ts";
import type { CheckoutFlow } from "../../stores/CheckoutFlow.ts";
import { ShopWorkspaceContext } from "../../stores/ShopWorkspace.ts";
import {
  SwapActions,
  SwapDepositPanel,
  SwapPreparing,
  SwapStartError,
  SwapUnavailable,
  swapGroupLimitOption,
  swapOptionLimitMessage,
} from "./SwapPanel.tsx";

type SwapGroup = OpenReceiveSwapMethodGroup<OpenReceiveCheckoutPaymentMethod>;

const joinClassNames = (...names: (string | undefined)[]): string =>
  names.filter(Boolean).join(" ");

/** Route provider displays with icon/tutorial URLs rewritten onto the pack output. */
const buildRouteDisplays = (
  routes: Parameters<typeof createOpenReceiveWizardRouteDisplays>[0],
): ReturnType<typeof createOpenReceiveWizardRouteDisplays> =>
  createOpenReceiveWizardRouteDisplays(routes).map((route) => ({
    ...route,
    providers: route.providers.map((provider) => ({
      ...provider,
      icon: packagedRuntimeAssetUrl(provider.icon, "provider-icons"),
      tutorials: provider.tutorials.map((tutorial) => ({
        ...tutorial,
        image: packagedRuntimeAssetUrl(tutorial.image, "pay_tutorials"),
      })),
    })),
  }));

/**
 * Payment method wizard: compact Bitcoin/USDT/USDC grid with per-coin network
 * reveal, focused swap deposit flow, and the Bitcoin wallet/provider flow.
 * Same markup and classes as the widget's PaymentWizard; all selection state
 * lives in CheckoutFlow instead of component-local useState.
 */
const MethodWizard: React.FC = observer(() => {
  const workspace = useContext(ShopWorkspaceContext);
  const checkout = workspace.checkout;
  if (checkout === null) return null;

  if (checkout.focusedSwapAsset !== null) {
    return <FocusedSwapFlow checkout={checkout} />;
  }

  return (
    <div className={orClasses.wizard}>
      {checkout.selectedMethod === null ? <CompactMethodSelector checkout={checkout} /> : null}
      {checkout.selectedMethod === null ? null : <MethodRouteFlow checkout={checkout} />}
      <TutorialModalHost checkout={checkout} />
    </div>
  );
});

export default MethodWizard;

const FocusedSwapFlow: React.FC<{ checkout: CheckoutFlow }> = observer(({ checkout }) => {
  const focusedAsset = checkout.focusedSwapAsset;
  if (focusedAsset === null) return null;
  const option = checkout.focusedSwapOption;
  const quote = checkout.focusedSwapQuote;
  const activeSwap = checkout.activeSwapForFocusedAsset;
  const label = option?.label ?? "this coin";

  return (
    <div className={orClasses.wizard}>
      <div className={orClasses.wizardBody}>
        <div className={orClasses.breadcrumbs}>
          <ul>
            <li>
              <button
                className="link link-hover"
                onClick={() => checkout.clearSwapFocus()}
                type="button"
              >
                {openReceiveCheckoutLabels.switchPaymentMethod}
              </button>
            </li>
            <li>
              <span className={orClasses.breadcrumbCurrent}>
                {option === undefined ? label : `${option.label} · ${option.network_label}`}
              </span>
            </li>
          </ul>
        </div>
        <div className={orClasses.wizardResults}>
          {checkout.swapStartError !== null && activeSwap === undefined ? (
            <SwapStartError
              message={checkout.swapStartError}
              onRetry={() => void checkout.startSwap(focusedAsset)}
            />
          ) : activeSwap !== undefined ? (
            <SwapDepositPanel
              invoice={activeSwap}
              checkout={checkout.snapshot?.data}
              now={checkout.nowSeconds}
              onRefund={(attemptId, refundAddress, refundNonce, confirm) =>
                void checkout.refundSwap(attemptId, refundAddress, refundNonce, confirm)
              }
              onBackToLightning={() => void checkout.dismissSwapToLightning()}
            />
          ) : quote !== undefined && !quote.available ? (
            <SwapUnavailable quote={quote} checkout={checkout.snapshot?.data} />
          ) : (
            <SwapPreparing label={label} />
          )}
        </div>
      </div>
    </div>
  );
});

const CompactMethodSelector: React.FC<{ checkout: CheckoutFlow }> = observer(({ checkout }) => {
  const entries = checkout.gridEntries;
  const snapshot = checkout.snapshot?.data;
  const currenciesLoading = checkout.currenciesLoading;
  const selectedKey = checkout.selectedPickerKey;
  const startingAsset = checkout.startingAsset;
  const gridBusy = startingAsset !== null;

  const selectedSwapEntry = selectedKey?.startsWith("swap:")
    ? entries.find(
        (entry) =>
          entry.kind === "swap" &&
          entry.group.label.trim().toUpperCase() === selectedKey.slice("swap:".length),
      )
    : undefined;
  const selectedGroup = selectedSwapEntry?.kind === "swap" ? selectedSwapEntry.group : undefined;
  const networkRequired = selectedGroup !== undefined && selectedGroup.options.length > 1;

  return (
    <>
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
                methodId={entry.method.id}
                title={entry.method.title}
                gridBusy={gridBusy}
                onContinue={() => {
                  checkout.selectMethod(entry.method.id);
                  // Trigger the Lightning mint when Bitcoin is selected. Safe to
                  // call repeatedly (idempotent reuse check in the store).
                  if (entry.method.id === "bitcoin") void checkout.ensureLightning();
                }}
              />
            ) : (
              <SwapGroupTile
                key={openReceiveSwapPickerKey(entry.group.label)}
                checkout={checkout}
                group={entry.group}
                snapshot={snapshot}
                selectedKey={selectedKey}
                startingAsset={startingAsset}
                gridBusy={gridBusy}
              />
            ),
          )}
          {currenciesLoading ? (
            <div
              key="currencies-loading"
              role="status"
              aria-live="polite"
              className={orClasses.methodCurrenciesLoading}
            >
              <span className={orClasses.spinner} aria-hidden="true" />
              <span className={orClasses.methodTitle}>
                {openReceiveCheckoutLabels.loadingCurrencies}
              </span>
            </div>
          ) : null}
        </div>
        {networkRequired && selectedGroup !== undefined ? (
          <div className={orClasses.methodNetworkRevealDesktop}>
            <NetworkSelector checkout={checkout} group={selectedGroup} mobile={false} />
          </div>
        ) : null}
      </div>
    </>
  );
});

const MethodTile: React.FC<{
  methodId: OpenReceivePaymentMethod;
  title: string;
  gridBusy: boolean;
  onContinue: () => void;
}> = ({ methodId, title, gridBusy, onContinue }) => {
  const accent = openReceivePaymentAccentId(methodId);
  return (
    <button
      type="button"
      className={openReceiveAssetButtonClasses({ accent, selected: false, disabled: gridBusy })}
      disabled={gridBusy}
      aria-disabled={gridBusy ? "true" : undefined}
      onClick={gridBusy ? undefined : onContinue}
    >
      <span aria-hidden="true" className={orClasses.methodIconWrap}>
        <img alt="" className={orClasses.methodIcon} src={methodIcon(methodId)} />
      </span>
      <span className={orClasses.methodTitleWrap}>
        <span className={orClasses.methodTitle}>{title}</span>
      </span>
    </button>
  );
};

const SwapGroupTile: React.FC<{
  checkout: CheckoutFlow;
  group: SwapGroup;
  snapshot: CheckoutSnapshot | undefined;
  selectedKey: string | null;
  startingAsset: string | null;
  gridBusy: boolean;
}> = observer(({ checkout, group, snapshot, selectedKey, startingAsset, gridBusy }) => {
  const groupKey = group.label.trim().toUpperCase();
  const pickerKey = openReceiveSwapPickerKey(group.label);
  const selected = selectedKey === pickerKey;
  const multiNetwork = group.options.length > 1;
  const displayOption =
    group.options.find((option) => option.available !== false) ?? group.options[0];
  if (displayOption === undefined) return null;
  const selectedAsset = checkout.selectedSwapNetworks[groupKey];
  const selectedOption =
    selectedAsset === undefined
      ? undefined
      : group.options.find((option) => option.pay_in_asset === selectedAsset);
  const activeOption = selectedOption ?? displayOption;
  const starting = group.options.some((option) => option.pay_in_asset === startingAsset);
  const disabled = group.options.every((option) => option.available === false);
  const accent = openReceivePaymentAccentId(group.label);
  const limitOption = disabled
    ? (swapGroupLimitOption(group.options) ?? activeOption)
    : activeOption;
  const limitMessage = swapOptionLimitMessage(limitOption, snapshot);
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
          accent,
          selected: starting || (multiNetwork && selected),
          disabled: disabled || (gridBusy && !starting),
        })}
        onClick={
          disabled || gridBusy
            ? undefined
            : multiNetwork
              ? () => checkout.selectPicker(pickerKey)
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
      {disabled && limitMessage !== undefined ? (
        <span className={orClasses.methodLimitHint}>{limitMessage}</span>
      ) : null}
      {multiNetwork ? (
        <div
          className={joinClassNames(
            orClasses.methodNetworkRevealAnim,
            selected
              ? orClasses.methodNetworkRevealAnimOpen
              : orClasses.methodNetworkRevealAnimClosed,
          )}
        >
          <div className={orClasses.methodNetworkRevealInner}>
            {selected ? <NetworkSelector checkout={checkout} group={group} mobile /> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
});

const NetworkSelector: React.FC<{
  checkout: CheckoutFlow;
  group: SwapGroup;
  mobile: boolean;
}> = observer(({ checkout, group, mobile }) => {
  const accent = openReceivePaymentAccentId(group.label);
  const groupKey = group.label.trim().toUpperCase();
  const snapshot = checkout.snapshot?.data;
  const selectedAsset = checkout.selectedSwapNetworks[groupKey];
  const selectedOption =
    selectedAsset === undefined
      ? undefined
      : group.options.find((option) => option.pay_in_asset === selectedAsset);
  const panelId = `network-panel-${groupKey.toLowerCase()}`;
  const startingAsset = checkout.startingAsset;
  const gridBusy = startingAsset !== null;

  const continueTarget =
    selectedOption !== undefined
      ? {
          payInAsset: selectedOption.pay_in_asset,
          disabled: selectedOption.available === false,
          limitMessage: swapOptionLimitMessage(selectedOption, snapshot),
        }
      : null;
  const continueStarting = continueTarget !== null && continueTarget.payInAsset === startingAsset;
  const canContinue =
    continueTarget !== null &&
    !continueTarget.disabled &&
    selectedOption !== undefined &&
    !gridBusy;

  const continueButton = (className: string): React.ReactElement => (
    <button
      type="button"
      className={className}
      disabled={!canContinue}
      aria-disabled={canContinue ? undefined : "true"}
      aria-busy={continueStarting ? "true" : undefined}
      onClick={
        !canContinue || continueTarget === null
          ? undefined
          : () => void checkout.startSwap(continueTarget.payInAsset)
      }
    >
      {continueStarting ? (
        <>
          <span className={orClasses.continueSpinner} aria-hidden="true" />
          {openReceiveCheckoutLabels.preparingPayment}
        </>
      ) : continueTarget?.disabled && continueTarget.limitMessage !== undefined ? (
        continueTarget.limitMessage
      ) : (
        openReceiveCheckoutLabels.continue
      )}
    </button>
  );

  return (
    // biome-ignore lint/a11y/useSemanticElements: 1:1 port — a fieldset would change the shared design
    <div
      id={panelId}
      role="group"
      aria-labelledby={`network-heading-${groupKey.toLowerCase()}`}
      className={
        mobile ? openReceiveNetworkMobileRevealClasses(accent) : orClasses.methodNetworkReveal
      }
    >
      <div className={orClasses.methodNetworkLayout}>
        <div>
          <h3
            id={`network-heading-${groupKey.toLowerCase()}`}
            className={orClasses.methodNetworkHeading}
          >
            {formatOpenReceiveChooseNetworkHeading(group.label)}
          </h3>
          <p className={orClasses.methodNetworkHint}>
            {openReceiveCheckoutLabels.selectNetworkToContinue}
          </p>
        </div>
        {/* biome-ignore lint/a11y/useSemanticElements: 1:1 port — a fieldset would change the shared design */}
        <div
          role="group"
          aria-labelledby={`network-heading-${groupKey.toLowerCase()}`}
          className={orClasses.methodNetworkGrid}
        >
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
        {continueButton(orClasses.methodConfirmDesktop)}
      </div>
      {selectedOption !== undefined ? (
        <p aria-live="polite" className={orClasses.methodNetworkSummary}>
          <span aria-hidden="true" className={openReceiveNetworkSummaryIconClasses(accent)}>
            ✓
          </span>
          {formatOpenReceiveNetworkSummary(group.label, selectedOption.network_label)}
        </p>
      ) : null}
    </div>
  );
});

/** Bitcoin/crypto breadcrumb flow: route picker, provider grid, swap actions per route. */
const MethodRouteFlow: React.FC<{ checkout: CheckoutFlow }> = observer(({ checkout }) => {
  const selection = checkout.wizardSelection?.data;
  if (selection === undefined || selection.selectedMethod === null) return null;
  const model: OpenReceivePaymentWizardModel = createOpenReceivePaymentWizardModel(selection);
  // Rebuild the route-asset displays with webpack-emitted icons; the package
  // helper resolves icon URLs relative to its own module, which 404s here.
  const routeAssetDisplays = model.routeAssets.map((asset) => {
    const id = asset.route ?? asset.symbol;
    return {
      id,
      label: asset.label,
      subtitle: getOpenReceiveRouteNetworkLabel(id),
      icon: routeIcon(asset),
      selected: model.selectedRoute === id,
    };
  });
  const routeDisplays = buildRouteDisplays(model.wizard.routes);
  const showRoutePicker =
    routeAssetDisplays.length > 0 && (model.selectedRoute === null || routeDisplays.length === 0);
  const methodLabel =
    selection.selectedMethod === "bitcoin"
      ? "Bitcoin"
      : selection.selectedMethod === "crypto"
        ? "Crypto"
        : openReceiveCheckoutLabels.paymentMethod;
  const routeLabel =
    model.selectedRoute === null || routeAssetDisplays.length <= 1
      ? null
      : (routeAssetDisplays.find((asset) => asset.id === model.selectedRoute)?.label ??
        model.selectedRoute);
  const swapOptions = checkout.swapAssetOptions;
  const currentSwapInvoice = checkout.currentSwapInvoice;

  return (
    <div className={orClasses.wizardBody}>
      <nav aria-label="Payment path" className={orClasses.breadcrumbs}>
        <ul>
          <li>
            <button
              className="link link-hover"
              onClick={() => checkout.changeMethod()}
              type="button"
            >
              {openReceiveCheckoutLabels.switchPaymentMethod}
            </button>
          </li>
          {routeLabel === null ? (
            <li>
              <span className={orClasses.breadcrumbCurrent}>{methodLabel}</span>
            </li>
          ) : (
            <>
              <li>
                <button
                  className="link link-hover"
                  onClick={() => checkout.changeRoute()}
                  type="button"
                >
                  {methodLabel}
                </button>
              </li>
              <li>
                <span className={orClasses.breadcrumbCurrent}>{routeLabel}</span>
              </li>
            </>
          )}
        </ul>
      </nav>
      {showRoutePicker ? (
        <div className={orClasses.routePicker} data-method={selection.selectedMethod}>
          {routeAssetDisplays.map((asset) => (
            <button
              className={asset.selected ? orClasses.routeButtonSelected : orClasses.routeButton}
              key={asset.id}
              onClick={() => checkout.selectRoute(asset.id)}
              type="button"
            >
              <img alt="" className={orClasses.methodIcon} src={asset.icon} />
              <span className={orClasses.methodTitle}>{asset.label}</span>
              <small className={orClasses.methodDetail}>{asset.subtitle}</small>
            </button>
          ))}
        </div>
      ) : null}
      <div className={orClasses.wizardResults}>
        {routeDisplays.length === 0 ? (
          <p className={orClasses.wizardEmpty}>
            {selection.selectedMethod === "bitcoin"
              ? openReceiveCheckoutLabels.emptyBitcoin
              : openReceiveCheckoutLabels.emptyCrypto}
          </p>
        ) : (
          routeDisplays.map((route) => {
            const routeSwapOptions = swapOptions.filter((option) =>
              openReceiveSwapAssetMatchesRoute(route.key, option.pay_in_asset),
            );
            const activeSwapForRoute =
              currentSwapInvoice !== undefined &&
              openReceiveSwapAssetMatchesRoute(route.key, currentSwapInvoice.swap?.pay_in_asset)
                ? currentSwapInvoice
                : undefined;
            return (
              <section className={orClasses.wizardRoute} key={route.key}>
                <div className={orClasses.wizardRouteHeading}>
                  <div>
                    <h3>{route.title}</h3>
                  </div>
                </div>
                {activeSwapForRoute === undefined ? (
                  <SwapActions
                    options={routeSwapOptions}
                    enabled={swapOptions.length > 0}
                    startingAsset={checkout.startingAsset}
                    onStart={(payInAsset) => void checkout.startSwap(payInAsset)}
                    checkout={checkout.snapshot?.data}
                  />
                ) : (
                  <SwapDepositPanel
                    invoice={activeSwapForRoute}
                    checkout={checkout.snapshot?.data}
                    now={checkout.nowSeconds}
                    onRefund={(attemptId, refundAddress, refundNonce, confirm) =>
                      void checkout.refundSwap(attemptId, refundAddress, refundNonce, confirm)
                    }
                    onBackToLightning={() => void checkout.dismissSwapToLightning()}
                  />
                )}
                {activeSwapForRoute === undefined ? (
                  <div className={orClasses.providerGrid}>
                    {route.providers.map((provider) => (
                      <article className={orClasses.providerCard} key={provider.id}>
                        <div className={orClasses.providerHeading}>
                          <img alt="" className={orClasses.providerIcon} src={provider.icon} />
                          <h4 className={orClasses.providerName}>{provider.name}</h4>
                        </div>
                        <p className={orClasses.providerKind}>{provider.kind}</p>
                        <div className={orClasses.providerActions}>
                          {provider.tutorials.length === 0 ? (
                            <a
                              className={orClasses.providerOpen}
                              href={provider.url}
                              rel="noreferrer"
                              target="_blank"
                            >
                              {provider.openLabel}
                            </a>
                          ) : (
                            <button
                              className={orClasses.providerOpen}
                              onClick={() =>
                                checkout.setActiveTutorial({
                                  providerId: provider.id,
                                  index: 0,
                                  copied: false,
                                })
                              }
                              type="button"
                            >
                              {provider.openLabel}
                            </button>
                          )}
                        </div>
                      </article>
                    ))}
                  </div>
                ) : null}
              </section>
            );
          })
        )}
      </div>
    </div>
  );
});

/** Finds the active tutorial's provider display and renders the modal. */
const TutorialModalHost: React.FC<{ checkout: CheckoutFlow }> = observer(({ checkout }) => {
  const tutorial = checkout.activeTutorial;
  const selection = checkout.wizardSelection?.data;
  if (tutorial === null || selection === undefined || selection.selectedMethod === null)
    return null;
  const model = createOpenReceivePaymentWizardModel(selection);
  const provider = buildRouteDisplays(model.wizard.routes)
    .flatMap((route) => route.providers)
    .find((candidate) => candidate.id === tutorial.providerId);
  if (provider === undefined) return null;
  const invoice = checkout.state?.invoice ?? "";

  return (
    <ProviderTutorialModal
      provider={provider}
      index={tutorial.index}
      copied={tutorial.copied}
      invoice={invoice}
      onClose={() => checkout.setActiveTutorial(null)}
      onCopy={async () => {
        if (invoice === "") return;
        try {
          await copyInvoiceHelper({ invoice });
          globalThis.dispatchEvent?.(createCheckoutProviderCopyEvent(provider.id));
          checkout.setActiveTutorial({ providerId: provider.id, index: 0, copied: true });
        } catch (error) {
          console.error(error);
        }
      }}
      onStep={(index) =>
        checkout.setActiveTutorial({ providerId: provider.id, index, copied: tutorial.copied })
      }
    />
  );
});

function ProviderTutorialModal(options: {
  readonly provider: OpenReceiveWizardProviderDisplay;
  readonly index: number;
  readonly copied: boolean;
  readonly invoice: string;
  readonly onClose: () => void;
  readonly onCopy: () => Promise<void>;
  readonly onStep: (index: number) => void;
}): React.ReactElement | null {
  const { provider } = options;
  const dialogRef = useRef<HTMLDivElement | null>(null);
  // Modal dialog contract: focus moves into the dialog on open, Tab is trapped
  // inside it, and focus returns to the opener on close.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    const opener =
      dialog.ownerDocument.activeElement instanceof HTMLElement
        ? dialog.ownerDocument.activeElement
        : null;
    dialog.focus();
    return () => {
      opener?.focus();
    };
  }, []);
  const trapTab = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (dialog === null) return;
    const focusables = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => !element.hasAttribute("disabled"));
    if (focusables.length === 0) return;
    const first = focusables[0] as HTMLElement;
    const last = focusables[focusables.length - 1] as HTMLElement;
    const active = dialog.ownerDocument.activeElement;
    if (event.shiftKey && (active === first || active === dialog)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };
  if (provider.tutorials.length === 0) return null;
  const totalSteps = provider.tutorials.length + 1;
  const stepIndex = Math.max(0, Math.min(provider.tutorials.length, options.index));
  const tutorial = stepIndex === 0 ? undefined : provider.tutorials[stepIndex - 1];
  const previousIndex = Math.max(0, stepIndex - 1);
  const nextIndex = Math.min(provider.tutorials.length, stepIndex + 1);
  const isFinalStep = stepIndex === provider.tutorials.length;
  const decodeHref = createOpenReceiveLightningInvoiceDecodeUrl(options.invoice);

  return (
    <div
      ref={dialogRef}
      aria-label={`${openReceiveCheckoutLabels.tutorialTitlePrefix} ${provider.name}`}
      aria-modal
      className={orClasses.tutorialModal}
      onClick={(event) => {
        if (event.target === event.currentTarget) options.onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") options.onClose();
        trapTab(event);
      }}
      role="dialog"
      tabIndex={-1}
    >
      <div className={orClasses.tutorialBox}>
        <div className={orClasses.tutorialHeader}>
          <div className={orClasses.tutorialTitle}>
            <img alt="" className={orClasses.tutorialHeaderLogo} src={provider.icon} />
            <h3>{`${openReceiveCheckoutLabels.tutorialTitlePrefix} ${provider.name}`}</h3>
          </div>
          <button
            aria-label="Close"
            className={orClasses.tutorialClose}
            onClick={options.onClose}
            type="button"
          >
            X
          </button>
        </div>
        {stepIndex === 0 ? (
          <div className={orClasses.tutorialIntro}>
            <img alt="" className={orClasses.tutorialProviderLogo} src={provider.icon} />
            <p>{`${openReceiveCheckoutLabels.tutorialIntroPrefix} ${provider.name}.`}</p>
            <p>{openReceiveCheckoutLabels.tutorialIntroCopy}</p>
            <button
              className={orClasses.tutorialCopy}
              onClick={() => void options.onCopy()}
              type="button"
            >
              {openReceiveCheckoutLabels.copyInvoice}
            </button>
            {decodeHref === undefined ? null : (
              <a
                className={orClasses.tutorialCopy}
                href={decodeHref}
                rel="noreferrer"
                target="_blank"
              >
                {openReceiveCheckoutLabels.decodeInvoice}
              </a>
            )}
            {options.copied ? (
              <p className={orClasses.tutorialCopyMessage}>
                {openReceiveCheckoutLabels.tutorialCopiedContinue}
              </p>
            ) : null}
          </div>
        ) : (
          <>
            <div className={orClasses.tutorialFrame}>
              <img
                alt={tutorial?.caption ?? ""}
                className={orClasses.tutorialImage}
                src={tutorial?.image ?? ""}
              />
            </div>
            <p className={orClasses.tutorialCaption}>{tutorial?.caption ?? ""}</p>
          </>
        )}
        <div aria-hidden="true" className={orClasses.tutorialSteps}>
          {Array.from({ length: totalSteps }, (_, index) => (
            <span
              className={
                index === stepIndex ? orClasses.tutorialStepActive : orClasses.tutorialStep
              }
              // biome-ignore lint/suspicious/noArrayIndexKey: static step dots, same as the widget
              key={index}
            />
          ))}
        </div>
        <p className={orClasses.tutorialProgress}>{`Step ${stepIndex + 1} of ${totalSteps}`}</p>
        <div className={orClasses.tutorialControls}>
          <button
            className={orClasses.btn}
            disabled={stepIndex === 0}
            onClick={() => options.onStep(previousIndex)}
            type="button"
          >
            Back
          </button>
          <button
            className={orClasses.btn}
            onClick={() => {
              if (isFinalStep) {
                options.onClose();
                return;
              }
              options.onStep(nextIndex);
            }}
            type="button"
          >
            {isFinalStep ? openReceiveCheckoutLabels.tutorialExit : "Next"}
          </button>
        </div>
      </div>
    </div>
  );
}
