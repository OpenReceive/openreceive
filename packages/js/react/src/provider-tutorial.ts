// The provider tutorial modal and the "open provider" action the wizard links
// it from. The elements counterpart is elements/src/render-provider-tutorial.ts.
import {
  createOpenReceiveLightningInvoiceDecodeUrl,
  openReceiveCheckoutLabels,
  type OpenReceiveWizardProviderDisplay,
  orClasses,
} from "@openreceive/browser/internal";
import * as React from "react";

export function renderProviderOpenAction(
  provider: OpenReceiveWizardProviderDisplay,
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
  readonly provider: OpenReceiveWizardProviderDisplay;
  readonly index: number;
  readonly copied: boolean;
  readonly invoice: string;
  readonly decodeLinkUrl?: string;
  readonly onClose: () => void;
  readonly onCopy: () => Promise<void>;
  readonly onStep: (index: number) => void;
}): React.ReactElement | null {
  const { provider } = options;
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
  const decodeHref = createOpenReceiveLightningInvoiceDecodeUrl(
    options.invoice,
    options.decodeLinkUrl,
  );

  return React.createElement(
    "div",
    {
      ref: dialogRef,
      "aria-label": `${openReceiveCheckoutLabels.tutorialTitlePrefix} ${provider.name}`,
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
          React.createElement(
            "h3",
            null,
            `${openReceiveCheckoutLabels.tutorialTitlePrefix} ${provider.name}`,
          ),
        ),
        React.createElement(
          "button",
          {
            "aria-label": "Close",
            className: orClasses.tutorialClose,
            onClick: options.onClose,
            type: "button",
          },
          "X",
        ),
      ),
      stepIndex === 0
        ? React.createElement(
            "div",
            {
              className: orClasses.tutorialIntro,
            },
            React.createElement("img", {
              alt: "",
              className: orClasses.tutorialProviderLogo,
              src: provider.icon,
            }),
            React.createElement(
              "p",
              null,
              `${openReceiveCheckoutLabels.tutorialIntroPrefix} ${provider.name}.`,
            ),
            React.createElement("p", null, openReceiveCheckoutLabels.tutorialIntroCopy),
            React.createElement(
              "button",
              {
                className: orClasses.tutorialCopy,
                onClick: () => void options.onCopy(),
                type: "button",
              },
              openReceiveCheckoutLabels.copyInvoice,
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
                  openReceiveCheckoutLabels.decodeInvoice,
                ),
            options.copied
              ? React.createElement(
                  "p",
                  {
                    className: orClasses.tutorialCopyMessage,
                  },
                  openReceiveCheckoutLabels.tutorialCopiedContinue,
                )
              : null,
          )
        : React.createElement(
            React.Fragment,
            null,
            React.createElement(
              "div",
              {
                className: orClasses.tutorialFrame,
              },
              React.createElement("img", {
                alt: tutorial?.caption ?? "",
                className: orClasses.tutorialImage,
                src: tutorial?.image ?? "",
              }),
            ),
            React.createElement(
              "p",
              {
                className: orClasses.tutorialCaption,
              },
              tutorial?.caption ?? "",
            ),
          ),
      React.createElement(
        "div",
        {
          "aria-hidden": "true",
          className: orClasses.tutorialSteps,
        },
        Array.from({ length: totalSteps }, (_, index) =>
          React.createElement("span", {
            className: index === stepIndex ? orClasses.tutorialStepActive : orClasses.tutorialStep,
            key: index,
          }),
        ),
      ),
      React.createElement(
        "p",
        {
          className: orClasses.tutorialProgress,
        },
        `Step ${stepIndex + 1} of ${totalSteps}`,
      ),
      React.createElement(
        "div",
        {
          className: orClasses.tutorialControls,
        },
        React.createElement(
          "button",
          {
            className: orClasses.btn,
            disabled: stepIndex === 0,
            onClick: () => options.onStep(previousIndex),
            type: "button",
          },
          "Back",
        ),
        React.createElement(
          "button",
          {
            className: orClasses.btn,
            onClick: () => {
              if (isFinalStep) {
                options.onClose();
                return;
              }
              options.onStep(nextIndex);
            },
            type: "button",
          },
          isFinalStep ? openReceiveCheckoutLabels.tutorialExit : "Next",
        ),
      ),
    ),
  );
}
