// The provider tutorial modal and the "open provider" action the wizard links
// it from. The elements counterpart is elements/src/render-provider-tutorial.ts.
import {
  createLightningInvoiceDecodeUrl,
  checkoutLabels,
  type WizardProviderDisplay,
  orClasses,
} from "@openreceive/browser/headless";
import * as React from "react";

export function renderProviderOpenAction(
  provider: WizardProviderDisplay,
  onOpenTutorial: () => void,
): React.ReactElement {
  if (provider.tutorials.length === 0) {
    return React.createElement(
      "a",
      {
        className: orClasses.providerOpen,
        href: provider.url,
        rel: "noreferrer",
        target: "_blank",
      },
      provider.openLabel,
    );
  }

  return React.createElement(
    "button",
    {
      className: orClasses.providerOpen,
      onClick: onOpenTutorial,
      type: "button",
    },
    provider.openLabel,
  );
}

export function ProviderTutorialModal(options: {
  readonly provider: WizardProviderDisplay;
  readonly copied: boolean;
  readonly invoice: string;
  readonly decodeLinkUrl?: string;
  readonly onClose: () => void;
  readonly onCopy: () => Promise<void>;
}): React.ReactElement | null {
  const { provider } = options;
  // Copying comes first whenever there is an invoice to copy: the wallet steps
  // end with pasting it.
  const copySteps = options.invoice === "" ? 0 : 1;
  const stepCount = copySteps + provider.tutorials.length;
  const dialogRef = React.useRef<HTMLDivElement | null>(null);
  const [step, setStep] = React.useState(0);
  // Modal dialog contract: focus moves into the dialog on open, Tab is
  // trapped inside it, and focus returns to the opener on close.
  React.useEffect(() => {
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
  const onCopyStep = copySteps === 1 && step === 0;
  const copyPending = onCopyStep && !options.copied;
  const lastStep = step >= stepCount - 1;
  const decodeHref = createLightningInvoiceDecodeUrl(options.invoice, options.decodeLinkUrl);
  const captions = [
    ...(copySteps === 1 ? [checkoutLabels.tutorialCopyStep] : []),
    ...provider.tutorials.map((tutorial) => tutorial.caption),
  ];
  const copyHint = options.copied
    ? checkoutLabels.tutorialCopiedHint
    : checkoutLabels.tutorialCopyHint;

  return React.createElement(
    "div",
    {
      ref: dialogRef,
      "aria-label": `${checkoutLabels.tutorialTitlePrefix} ${provider.name}`,
      "aria-modal": true,
      className: orClasses.tutorialModal,
      onClick: (event: React.MouseEvent<HTMLDivElement>) => {
        if (event.target === event.currentTarget) options.onClose();
      },
      onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.key === "Escape") options.onClose();
        trapTab(event);
      },
      role: "dialog",
      tabIndex: -1,
    },
    React.createElement(
      "div",
      {
        className: orClasses.tutorialBox,
      },
      React.createElement(
        "div",
        {
          className: orClasses.tutorialHeader,
        },
        React.createElement(
          "div",
          {
            className: orClasses.tutorialTitle,
          },
          React.createElement("img", {
            alt: "",
            className: orClasses.tutorialHeaderLogo,
            src: provider.icon,
          }),
          React.createElement("h3", null, `${checkoutLabels.tutorialTitlePrefix} ${provider.name}`),
        ),
        React.createElement(
          "button",
          {
            "aria-label": checkoutLabels.tutorialClose,
            className: orClasses.tutorialClose,
            onClick: options.onClose,
            type: "button",
          },
          "X",
        ),
      ),
      decodeHref === undefined
        ? null
        : React.createElement(
            "a",
            {
              className: orClasses.tutorialCopy,
              href: decodeHref,
              rel: "noreferrer",
              target: "_blank",
            },
            checkoutLabels.decodeInvoice,
          ),
      React.createElement(
        "div",
        {
          className: orClasses.tutorialFrame,
        },
        onCopyStep
          ? React.createElement(
              "div",
              { className: orClasses.tutorialCopyPanel },
              React.createElement(
                "div",
                { className: orClasses.tutorialCopyMessage },
                React.createElement(
                  "p",
                  {
                    className: options.copied
                      ? orClasses.tutorialCopied
                      : orClasses.tutorialCopyHeading,
                  },
                  options.copied
                    ? checkoutLabels.tutorialInvoiceCopied
                    : checkoutLabels.tutorialCopyStep,
                ),
                React.createElement(
                  "p",
                  { className: orClasses.tutorialCopyHint },
                  copyHint.replace("{wallet}", provider.name),
                ),
              ),
            )
          : null,
        // No `<img>` until the lazily loaded screenshot is in hand: an empty
        // src is a request for the page itself.
        provider.tutorials.map((tutorial, index) =>
          tutorial.image === undefined
            ? null
            : React.createElement("img", {
                alt: tutorial.caption,
                className: orClasses.tutorialImage,
                hidden: index + copySteps !== step,
                key: tutorial.path,
                src: tutorial.image,
              }),
        ),
      ),
      React.createElement(
        "ol",
        { className: orClasses.tutorialSteps },
        captions.map((caption, index) =>
          React.createElement(
            "li",
            { key: caption },
            React.createElement(
              "button",
              {
                "aria-current": index === step ? "step" : undefined,
                className: index === step ? orClasses.tutorialStepActive : orClasses.tutorialStep,
                onClick: () => setStep(index),
                type: "button",
              },
              React.createElement(
                "span",
                { "aria-hidden": true, className: orClasses.tutorialStepNumber },
                index + 1,
              ),
              React.createElement("span", null, caption),
            ),
          ),
        ),
      ),
      React.createElement(
        "p",
        { className: orClasses.tutorialComeBack },
        checkoutLabels.tutorialComeBack,
      ),
      // One button for Copy invoice, Next and Done, so each change keeps its focus.
      React.createElement(
        "button",
        {
          className: orClasses.tutorialDone,
          onClick: copyPending
            ? () => void options.onCopy()
            : lastStep
              ? options.onClose
              : () => setStep(step + 1),
          type: "button",
        },
        copyPending
          ? checkoutLabels.copyInvoice
          : lastStep
            ? checkoutLabels.tutorialDone
            : checkoutLabels.tutorialNext,
      ),
    ),
  );
}
