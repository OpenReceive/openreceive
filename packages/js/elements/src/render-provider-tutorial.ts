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

function renderCopyStepHtml(copied: boolean): string {
  return `
    <li>
      <button
        part="tutorial-copy"
        class="${copied ? orClasses.tutorialCopyStepDone : orClasses.tutorialCopyStep}"
        type="button"
      ><span class="${orClasses.tutorialStepNumber}" aria-hidden="true">1</span><span part="tutorial-copy-label">${escapeHtml(copied ? checkoutLabels.tutorialInvoiceCopied : checkoutLabels.copyInvoice)}</span></button>
    </li>
  `;
}

function renderTutorialStepHtml(
  tutorial: WizardProviderDisplay["tutorials"][number],
  stepNumber: number,
  locked: boolean,
): string {
  // No `<img>` until the lazily loaded screenshot is in hand: an empty src
  // requests the page itself.
  const image =
    tutorial.image === undefined
      ? ""
      : `<img part="tutorial-image" class="${orClasses.tutorialImage}" alt="${escapeHtml(tutorial.caption)}" src="${escapeHtml(tutorial.image)}">`;
  return `
    <li>
      <div part="tutorial-step" class="${locked ? orClasses.tutorialStepLocked : orClasses.tutorialStep}"><span class="${orClasses.tutorialStepNumber}" aria-hidden="true">${stepNumber}</span><span>${escapeHtml(tutorial.caption)}</span></div>
      ${locked ? "" : `<div part="tutorial-frame" class="${orClasses.tutorialFrame}">${image}</div>`}
    </li>
  `;
}

export function renderTutorialModalHtml(
  routes: readonly WizardRouteDisplay[],
  activeProviderId: string | null,
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
  // end with pasting it, so they stay greyed out until the copy has worked. Then
  // the whole route shows at once, because a payer on one phone can't flip
  // between this page and the wallet for each step.
  const copySteps = hasInvoice ? 1 : 0;
  const copyPending = hasInvoice && !copied;
  const decodeHref = hasInvoice
    ? createLightningInvoiceDecodeUrl(lightningInvoice, decodeLinkUrl)
    : undefined;
  const decodeButton =
    decodeHref === undefined
      ? ""
      : `<a part="tutorial-decode" class="${orClasses.tutorialCopy}" href="${escapeHtml(decodeHref)}" rel="noreferrer" target="_blank">${escapeHtml(checkoutLabels.decodeInvoice)}</a>`;
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
        <ol part="tutorial-steps" class="${orClasses.tutorialSteps}">
          ${hasInvoice ? renderCopyStepHtml(copied) : ""}
          ${provider.tutorials
            .map((tutorial, index) =>
              renderTutorialStepHtml(tutorial, index + copySteps + 1, copyPending),
            )
            .join("")}
        </ol>
        ${decodeButton}
        ${
          copyPending
            ? ""
            : `<button part="tutorial-done" class="${orClasses.tutorialDone}" ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.providerTutorial}="" type="button">${escapeHtml(checkoutLabels.tutorialDone)}</button>`
        }
      </div>
    </div>
  `;
}
