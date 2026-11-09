// The provider tutorial modal and the "open provider" action the wizard links
// it from. The elements counterpart is elements/src/render-provider-tutorial.ts.
import {
  checkoutLabels,
  createLightningInvoiceDecodeUrl,
  orClasses,
  type WizardProviderDisplay,
} from "@openreceive/browser/headless";
import * as React from "react";
import { selectAllInputHandlers } from "./utils.ts";

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
  readonly copyRefused?: boolean;
  readonly invoice: string;
  readonly decodeLinkUrl?: string;
  readonly onClose: () => void;
  readonly onCopy: () => Promise<void>;
}): React.ReactElement | null {
  const { provider } = options;
  // Copying comes first whenever there is an invoice to copy: the wallet steps
  // end with pasting it, so they stay greyed out until the copy has worked. Then
  // the whole route shows at once, because a payer on one phone can't flip
  // between this page and the wallet for each step.
  const copySteps = options.invoice === "" ? 0 : 1;
  const dialogRef = React.useRef<HTMLDivElement | null>(null);
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
  const copyRefused = options.copyRefused === true;
  const invoiceFieldRef = React.useRef<HTMLInputElement | null>(null);
  React.useEffect(() => {
    if (!copyRefused) return;
    invoiceFieldRef.current?.focus();
    invoiceFieldRef.current?.select();
  }, [copyRefused]);
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
  const copyPending = copySteps === 1 && !options.copied && !copyRefused;
  const decodeHref = createLightningInvoiceDecodeUrl(options.invoice, options.decodeLinkUrl);

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
      React.createElement(
        "ol",
        { className: orClasses.tutorialSteps },
        copySteps === 1
          ? React.createElement(
              "li",
              { key: "copy" },
              ...(copyRefused
                ? [
                    React.createElement(
                      "div",
                      { key: "label", className: orClasses.tutorialStep },
                      React.createElement(
                        "span",
                        { "aria-hidden": true, className: orClasses.tutorialStepNumber },
                        1,
                      ),
                      React.createElement("span", null, checkoutLabels.tutorialCopyByHand),
                    ),
                    React.createElement("input", {
                      key: "invoice",
                      ref: invoiceFieldRef,
                      "aria-label": checkoutLabels.tutorialCopyByHand,
                      className: orClasses.swapDetailsInput,
                      readOnly: true,
                      type: "text",
                      value: options.invoice,
                      ...selectAllInputHandlers(),
                    }),
                  ]
                : [
                    React.createElement(
                      "button",
                      {
                        key: "button",
                        className: options.copied
                          ? orClasses.tutorialCopyStepDone
                          : orClasses.tutorialCopyStep,
                        onClick: () => void options.onCopy(),
                        type: "button",
                      },
                      React.createElement(
                        "span",
                        { "aria-hidden": true, className: orClasses.tutorialStepNumber },
                        1,
                      ),
                      React.createElement(
                        "span",
                        null,
                        options.copied
                          ? checkoutLabels.tutorialInvoiceCopied
                          : checkoutLabels.copyInvoice,
                      ),
                    ),
                  ]),
            )
          : null,
        provider.tutorials.map((tutorial, index) =>
          React.createElement(
            "li",
            { key: tutorial.path },
            React.createElement(
              "div",
              { className: copyPending ? orClasses.tutorialStepLocked : orClasses.tutorialStep },
              React.createElement(
                "span",
                { "aria-hidden": true, className: orClasses.tutorialStepNumber },
                index + copySteps + 1,
              ),
              React.createElement("span", null, tutorial.caption),
            ),
            // No `<img>` until the lazily loaded screenshot is in hand: an empty
            // src is a request for the page itself.
            copyPending
              ? null
              : React.createElement(
                  "div",
                  { className: orClasses.tutorialFrame },
                  tutorial.image === undefined
                    ? null
                    : React.createElement("img", {
                        alt: tutorial.caption,
                        className: orClasses.tutorialImage,
                        src: tutorial.image,
                      }),
                ),
          ),
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
      copyPending
        ? null
        : React.createElement(
            "button",
            { className: orClasses.tutorialDone, onClick: options.onClose, type: "button" },
            checkoutLabels.tutorialDone,
          ),
    ),
  );
}
