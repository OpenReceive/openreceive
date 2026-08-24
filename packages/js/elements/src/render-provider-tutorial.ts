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
      ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.providerTutorialIndex}="0"
      type="button"
    >${escapeHtml(provider.openLabel)}</button>
  `;
}

export function renderTutorialModalHtml(
  routes: readonly WizardRouteDisplay[],
  activeProviderId: string | null,
  activeTutorialIndex: number,
  copied: boolean,
  lightningInvoice?: string,
  decodeLinkUrl?: string,
): string {
  if (activeProviderId === null) return "";
  const provider = routes
    .flatMap((route) => route.providers)
    .find((candidate) => candidate.id === activeProviderId);
  if (provider === undefined || provider.tutorials.length === 0) return "";

  const totalSteps = provider.tutorials.length + 1;
  const stepIndex = Math.max(0, Math.min(provider.tutorials.length, activeTutorialIndex));
  const tutorial = stepIndex === 0 ? undefined : provider.tutorials[stepIndex - 1];
  const previousIndex = Math.max(0, stepIndex - 1);
  const nextIndex = Math.min(provider.tutorials.length, stepIndex + 1);
  const isFinalStep = stepIndex === provider.tutorials.length;
  const decodeHref =
    lightningInvoice === undefined || lightningInvoice.trim() === ""
      ? undefined
      : createLightningInvoiceDecodeUrl(lightningInvoice, decodeLinkUrl);
  const decodeButton =
    decodeHref === undefined
      ? ""
      : `<a part="tutorial-decode" class="${orClasses.tutorialCopy}" href="${escapeHtml(decodeHref)}" rel="noreferrer" target="_blank">${escapeHtml(checkoutLabels.decodeInvoice)}</a>`;
  const body =
    stepIndex === 0
      ? `
        <div part="tutorial-intro" class="${orClasses.tutorialIntro}">
          <img part="tutorial-provider-logo" alt="" src="${escapeHtml(provider.icon)}" class="${orClasses.tutorialProviderLogo}">
          <p>${escapeHtml(checkoutLabels.tutorialIntroPrefix)} ${escapeHtml(provider.name)}.</p>
          <p>${escapeHtml(checkoutLabels.tutorialIntroCopy)}</p>
          <button part="tutorial-copy" class="${orClasses.tutorialCopy}" type="button">${escapeHtml(checkoutLabels.copyInvoice)}</button>
          ${decodeButton}
          ${
            copied
              ? `<p part="tutorial-copy-message" class="${orClasses.tutorialCopyMessage}">${escapeHtml(checkoutLabels.tutorialCopiedContinue)}</p>`
              : ""
          }
        </div>
      `
      : `
        <div part="tutorial-frame" class="${orClasses.tutorialFrame}">
          <img part="tutorial-image" class="${orClasses.tutorialImage}" alt="${escapeHtml(tutorial?.caption ?? "")}" src="${escapeHtml(tutorial?.image ?? "")}">
        </div>
        <p part="tutorial-caption" class="${orClasses.tutorialCaption}">${escapeHtml(tutorial?.caption ?? "")}</p>
      `;

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
        ${body}
        <div part="tutorial-steps" class="${orClasses.tutorialSteps}" aria-hidden="true">
          ${Array.from(
            { length: totalSteps },
            (_, index) => `
            <span part="${index === stepIndex ? "tutorial-step-active" : "tutorial-step"}" class="${index === stepIndex ? orClasses.tutorialStepActive : orClasses.tutorialStep}"></span>
          `,
          ).join("")}
        </div>
        <p part="tutorial-progress" class="${orClasses.tutorialProgress}">Step ${stepIndex + 1} of ${totalSteps}</p>
        <div part="tutorial-controls" class="${orClasses.tutorialControls}">
          <button
            part="tutorial-nav"
            class="${orClasses.btn}"
            ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.providerTutorial}="${escapeHtml(provider.id)}"
            ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.providerTutorialIndex}="${previousIndex}"
            type="button"
            ${stepIndex === 0 ? "disabled" : ""}
          >${escapeHtml(checkoutLabels.tutorialBack)}</button>
          <button
            part="tutorial-nav"
            class="${orClasses.btn}"
            ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.providerTutorial}="${isFinalStep ? "" : escapeHtml(provider.id)}"
            ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.providerTutorialIndex}="${nextIndex}"
            type="button"
          >${escapeHtml(isFinalStep ? checkoutLabels.tutorialExit : checkoutLabels.tutorialNext)}</button>
        </div>
      </div>
    </div>
  `;
}
