// The provider tutorial modal and the "open provider" action the wizard links
// it from. React's counterpart is react/src/provider-tutorial.ts.
import {
  createLightningInvoiceDecodeUrl,
  escapeHtml,
  OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES,
  checkoutLabels,
  type WizardProviderDisplay,
  type WizardRouteDisplay,
  orClasses,
} from "@openreceive/browser/headless";

export function renderProviderOpenActionHtml(provider: WizardProviderDisplay): string {
  if (provider.tutorials.length === 0) {
    return `<a class="${orClasses.providerOpen}" href="${escapeHtml(provider.url)}" rel="noreferrer" target="_blank">${escapeHtml(provider.openLabel)}</a>`;
  }

  return `
    <button
      part="provider-open"
      class="${orClasses.providerOpen}"
      ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.providerTutorial}="${escapeHtml(provider.id)}"
      type="button"
    >${escapeHtml(provider.openLabel)}</button>
  `;
}

function renderTutorialStepHtml(caption: string, index: number, active: boolean): string {
  return `
    <li>
      <button
        part="${active ? "tutorial-step-active" : "tutorial-step"}"
        class="${active ? orClasses.tutorialStepActive : orClasses.tutorialStep}"
        ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.tutorialStep}="${index}"
        ${active ? 'aria-current="step"' : ""}
        type="button"
      ><span class="${orClasses.tutorialStepNumber}" aria-hidden="true">${index + 1}</span><span>${escapeHtml(caption)}</span></button>
    </li>
  `;
}

export function renderTutorialModalHtml(
  routes: readonly WizardRouteDisplay[],
  activeProviderId: string | null,
  activeStep: number,
  copied: boolean,
  lightningInvoice?: string,
  decodeLinkUrl?: string,
): string {
  if (activeProviderId === null) return "";
  const provider = routes
    .flatMap((route) => route.providers)
    .find((candidate) => candidate.id === activeProviderId);
  if (provider === undefined || provider.tutorials.length === 0) return "";

  const hasInvoice = lightningInvoice !== undefined && lightningInvoice.trim() !== "";
  // Copying comes first whenever there is an invoice to copy: the wallet steps
  // end with pasting it.
  const copySteps = hasInvoice ? 1 : 0;
  const stepCount = copySteps + provider.tutorials.length;
  const step = Math.max(0, Math.min(stepCount - 1, activeStep));
  const copyPending = hasInvoice && step === 0 && !copied;
  const lastStep = step === stepCount - 1;
  const decodeHref = hasInvoice
    ? createLightningInvoiceDecodeUrl(lightningInvoice, decodeLinkUrl)
    : undefined;
  const decodeButton =
    decodeHref === undefined
      ? ""
      : `<a part="tutorial-decode" class="${orClasses.tutorialCopy}" href="${escapeHtml(decodeHref)}" rel="noreferrer" target="_blank">${escapeHtml(checkoutLabels.decodeInvoice)}</a>`;
  // The prompt and the confirmation are both drawn and one is hidden, so a
  // finished copy flips them without a rebuild that would drop the dialog's focus.
  const copyPanel = hasInvoice
    ? `
      <div part="tutorial-copy-step" class="${orClasses.tutorialCopyPanel}" ${step === 0 ? "" : "hidden"}>
        <div part="tutorial-copy-prompt" class="${orClasses.tutorialCopyMessage}" ${copied ? "hidden" : ""}>
          <p class="${orClasses.tutorialCopyHeading}">${escapeHtml(checkoutLabels.tutorialCopyStep)}</p>
          <p class="${orClasses.tutorialCopyHint}">${escapeHtml(checkoutLabels.tutorialCopyHint.replace("{wallet}", provider.name))}</p>
        </div>
        <div part="tutorial-copied" class="${orClasses.tutorialCopyMessage}" ${copied ? "" : "hidden"}>
          <p class="${orClasses.tutorialCopied}">${escapeHtml(checkoutLabels.tutorialInvoiceCopied)}</p>
          <p class="${orClasses.tutorialCopyHint}">${escapeHtml(checkoutLabels.tutorialCopiedHint.replace("{wallet}", provider.name))}</p>
        </div>
      </div>
    `
    : "";
  const captions = [
    ...(hasInvoice ? [checkoutLabels.tutorialCopyStep] : []),
    ...provider.tutorials.map((tutorial) => tutorial.caption),
  ];
  // Every frame is drawn and a step change toggles `hidden`. No `<img>` until the
  // lazily loaded screenshot is in hand: an empty src requests the page itself.
  const frames = provider.tutorials
    .map((tutorial, index) =>
      tutorial.image === undefined
        ? ""
        : `<img part="tutorial-image" class="${orClasses.tutorialImage}" ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.tutorialImage}="${index + copySteps}" alt="${escapeHtml(tutorial.caption)}" src="${escapeHtml(tutorial.image)}" ${index + copySteps === step ? "" : "hidden"}>`,
    )
    .join("");

  return `
    <div part="tutorial" class="${orClasses.tutorialModal}" role="dialog" aria-modal="true" aria-label="${escapeHtml(checkoutLabels.tutorialTitlePrefix)} ${escapeHtml(provider.name)}" tabindex="-1">
      <div part="tutorial-dialog" class="${orClasses.tutorialBox}">
        <div part="tutorial-header" class="${orClasses.tutorialHeader}">
          <div part="tutorial-title" class="${orClasses.tutorialTitle}">
            <img part="tutorial-header-logo" alt="" src="${escapeHtml(provider.icon)}" class="${orClasses.tutorialHeaderLogo}">
            <h3>${escapeHtml(checkoutLabels.tutorialTitlePrefix)} ${escapeHtml(provider.name)}</h3>
          </div>
          <button
            part="tutorial-close"
            class="${orClasses.tutorialClose}"
            ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.providerTutorial}=""
            type="button"
            aria-label="${escapeHtml(checkoutLabels.tutorialClose)}"
          >X</button>
        </div>
        ${decodeButton}
        <div part="tutorial-frame" class="${orClasses.tutorialFrame}">${copyPanel}${frames}</div>
        <ol part="tutorial-steps" class="${orClasses.tutorialSteps}">
          ${captions.map((caption, index) => renderTutorialStepHtml(caption, index, index === step)).join("")}
        </ol>
        <p part="tutorial-come-back" class="${orClasses.tutorialComeBack}">${escapeHtml(checkoutLabels.tutorialComeBack)}</p>
        ${
          hasInvoice
            ? `<button part="tutorial-copy" class="${orClasses.tutorialDone}" type="button" ${copyPending ? "" : "hidden"}>${escapeHtml(checkoutLabels.copyInvoice)}</button>`
            : ""
        }
        <button
          part="tutorial-next"
          class="${orClasses.tutorialDone}"
          type="button"
          ${copyPending || lastStep ? "hidden" : ""}
        >${escapeHtml(checkoutLabels.tutorialNext)}</button>
        <button
          part="tutorial-done"
          class="${orClasses.tutorialDone}"
          ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.providerTutorial}=""
          type="button"
          ${lastStep ? "" : "hidden"}
        >${escapeHtml(checkoutLabels.tutorialDone)}</button>
      </div>
    </div>
  `;
}
