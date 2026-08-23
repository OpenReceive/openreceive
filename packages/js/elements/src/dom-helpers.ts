import {
  createDetailExternalLink,
  createTransientFeedbackController,
  escapeHtml,
  OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES,
  OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES,
  OPENRECEIVE_PAYMENT_WIZARD_SELECTORS,
  checkoutLabels,
  optionalUnixTimeLabel,
  orClasses,
} from "@openreceive/browser/headless";

export const COPY_INVOICE_ICON = `<svg class="${orClasses.copyIcon}" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false"><rect x="5" y="5" width="8" height="9" rx="1.5" stroke="currentColor" stroke-width="1.5"/><path d="M3.5 11V3.5A1.5 1.5 0 0 1 5 2h5.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;

const elementCopyFeedbackControllers = new WeakMap<
  Element,
  ReturnType<typeof createTransientFeedbackController<string>>
>();

export function readElementFiatQuote(element: Element) {
  const currency = element.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.fiatCurrency);
  const value = element.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.fiatValue);
  if (currency === null || value === null) return undefined;
  return {
    fiat: {
      currency,
      value,
    },
  };
}

/**
 * WHICH ATTRIBUTES MAY BE READ STRICTLY, decided once for the whole element.
 *
 * `parseOptionalInteger` throws on a negative or non-integer value.
 * That is the right read for an attribute a HOST typed by hand — a typo should
 * be heard — and exactly the wrong read for one carrying SERVER data, because
 * `render()` reads these and nothing wraps `render()`: one bad field then blanks
 * the whole payment screen and every wrapper built on the element.
 *
 * The test is whether `createCheckoutElementAttributes` can put a server's value
 * in the attribute, and it is checked PER ATTRIBUTE, not assumed — assuming is
 * what left `expires-at` behind when `amount-msats` was fixed:
 *
 * - `amount-msats`  SERVER. Written as `String(invoice.amount_msats ??
 *                   snapshot.amount_msats)`. Read leniently, below.
 * - `expires-at`    SERVER. Written as `String(invoice.expires_at)`, and the
 *                   only bound on the way in is a TYPE bound (swap-http.ts
 *                   checks `typeof provider_expires_at !== "number"`;
 *                   checkout-transport.ts's optional/requiredSafeInteger admit
 *                   negatives). Read leniently, below.
 * - `poll-interval-ms` HOST. `createCheckoutElementAttributes` does write it,
 *                   but only ever from its own caller's `options.pollIntervalMs`
 *                   — no server field feeds it anywhere in the repo. It stays on
 *                   the strict parser in `startCheckoutController`.
 *
 * The lenient readers parse the number and keep it RAW; only a value that is no
 * number at all is dropped here. What happens next differs by attribute, and the
 * difference is the point: `amount-msats` rides on untouched because a display
 * boundary (`optionalMsatsLabel`) blanks it downstream, so the raw amount still
 * reaches the detail rows exactly as it does on the React path, while
 * `expires-at` has no such boundary downstream — nothing judges
 * `expires_in_seconds` — so {@link readElementExpiresAt} does its own judging
 * here. Either way a malformed value costs its label or its row and nothing else.
 */
function readElementNumberAttribute(element: Element, attribute: string): number | undefined {
  const raw = element.getAttribute(attribute);
  if (raw === null || raw.trim() === "") return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Read `amount-msats` WITHOUT judging it. See {@link readElementNumberAttribute}. */
export function readElementAmountMsats(element: Element): number | undefined {
  return readElementNumberAttribute(element, OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.amountMsats);
}

/**
 * How far AHEAD OF NOW a value may sit and still be read as a checkout
 * DEADLINE: one year.
 *
 * The number is not delicate — anything from about a week to about a century
 * does the same job — because the two things it separates are far apart:
 *
 * - A real checkout deadline is minutes to hours out. The testkit mints 600s
 *   invoices; its swap provider quotes 900s deposit windows and 1800s invoices;
 *   a bolt11's expiry is measured in minutes. A year is four orders of magnitude
 *   past those and still two orders past a day-long checkout lock, so no honest
 *   value comes anywhere near this edge.
 * - A timestamp sent in MILLISECONDS, read as seconds, sits ~1000x further from
 *   the epoch than now does — 1.787e12 today, roughly fifty-six thousand years
 *   out. It overshoots a one-year horizon by nearly three orders of magnitude,
 *   and microseconds overshoot by nearly six.
 *
 * Only the FUTURE side is bounded. A deadline in the past is not implausible —
 * it is the expired screen's entire input, and the age of the order it belongs
 * to is not ours to guess — and no unit inflation can ever land there, because
 * multiplying a positive epoch by 1000 always moves it further into the future.
 * The floor is therefore the renderability bound's own (`> 0`) and nothing more.
 */
const MAX_DEADLINE_HORIZON_SECONDS = 365 * 24 * 60 * 60;

/**
 * Read `expires-at` without throwing, then keep the value only if it is
 * plausibly a DEADLINE. Two bounds, because a deadline is judged differently
 * from a label.
 *
 * The lenient parse alone is not the whole mirror of `readElementAmountMsats`.
 * There, the raw value flows on to `optionalMsatsLabel`, which blanks it; here
 * the raw value flows into `expires_in_seconds`, which no boundary judges — it
 * is merely floored at zero — so passing everything through would trade a crash
 * for two different lies. `-1` would read as "expired at the dawn of time" and
 * blank the QR and the amount off the screen the payer came to pay from, and an
 * `expires_at` sent in MILLISECONDS would render a countdown of twenty-nine
 * billion minutes.
 *
 * `optionalUnixTimeLabel` catches the first and NOT the second, which is why
 * there are two bounds here and not one. Its question is renderability — is
 * this finite, above zero, inside the ECMAScript `Date` range — and that is the
 * right question for a LABEL and the wrong one for a deadline. The `Date` range
 * runs to 8.64e12 seconds; today's moment in milliseconds is 1.787e12, well
 * under that ceiling, so the label bound KEPT it and the countdown measured
 * "29759354970:54". {@link MAX_DEADLINE_HORIZON_SECONDS} asks the deadline
 * question instead — is this plausibly a moment a checkout expires — and only
 * the pair of them is the rule.
 *
 * Dropping a value costs the countdown ROW and the client-side expiry
 * transition that reads it. It does NOT repair the `status` attribute:
 * `createCheckoutElementAttributes` derives that from the SAME
 * `invoice.expires_at` (see deriveStatus in @openreceive/browser), so a
 * deadline that has genuinely passed but was sent in milliseconds is written as
 * `status="pending"` before this reader ever sees it. This guard keeps the
 * element rendering; it cannot recover the truth a unit mistake destroyed
 * upstream. Fixing that means bounding the unit at the wire boundary, which is
 * a separate change — see docs/internal/display-boundary-findings.md.
 *
 * A deadline that has genuinely passed is renderable and inside the horizon, so
 * it arrives intact. The one exception is exactly `0`, which the renderability
 * floor (`> 0`) rejects; `status` still carries the expiry for that value.
 */
export function readElementExpiresAt(element: Element): number | undefined {
  const expiresAt = readElementNumberAttribute(
    element,
    OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.expiresAt,
  );
  if (expiresAt === undefined || optionalUnixTimeLabel(expiresAt) === undefined) return undefined;
  // `unixSeconds()` inlined rather than imported: this package depends on
  // @openreceive/browser alone, and ./internal does not re-export it.
  const horizon = Math.floor(Date.now() / 1000) + MAX_DEADLINE_HORIZON_SECONDS;
  return expiresAt > horizon ? undefined : expiresAt;
}

export function parseElementRail(value: string | null): "lightning" | "swap" | "checkout_lock" {
  if (value === "swap") return "swap";
  if (value === "checkout_lock") return "checkout_lock";
  return "lightning";
}

export function showElementCopyFeedback(button: Element | null): void {
  if (button === null) return;
  let controller = elementCopyFeedbackControllers.get(button);
  if (controller === undefined) {
    const labelEl = button.querySelector(OPENRECEIVE_PAYMENT_WIZARD_SELECTORS.swapCopyLabel);
    const resetValue =
      button.getAttribute("aria-label")?.trim() ||
      labelEl?.textContent?.trim() ||
      button.textContent?.trim() ||
      checkoutLabels.copyInvoice;
    controller = createTransientFeedbackController({
      resetValue,
      onValue: (label) => {
        if (!button.isConnected) return;
        if (button instanceof HTMLElement && button.hasAttribute("aria-label")) {
          button.setAttribute("aria-label", label);
          button.setAttribute("title", label);
        }
        if (labelEl instanceof HTMLElement) {
          labelEl.textContent = label;
          return;
        }
        if (!(button instanceof HTMLElement && button.querySelector("svg"))) {
          button.textContent = label;
        }
      },
    });
    elementCopyFeedbackControllers.set(button, controller);
  }
  controller.show(checkoutLabels.copied);
}

export function wireSwapSelectAllInputs(root: ParentNode): void {
  for (const input of root.querySelectorAll(OPENRECEIVE_PAYMENT_WIZARD_SELECTORS.swapSelectAll)) {
    if (!(input instanceof HTMLInputElement)) continue;
    const selectAll = () => {
      input.select();
    };
    input.addEventListener("focus", selectAll);
    input.addEventListener("click", selectAll);
    input.addEventListener("mouseup", (event) => {
      event.preventDefault();
    });
    input.addEventListener("select", () => {
      if (input.selectionStart !== 0 || input.selectionEnd !== input.value.length) {
        input.setSelectionRange(0, input.value.length);
      }
    });
  }
}
export function renderElementSwapCopyDetailHtml(
  label: string,
  value: string,
  displayValue: string = value,
  payInAsset?: string,
  href?: string,
  hrefLabel?: string,
): string {
  const link =
    href === undefined
      ? createDetailExternalLink({
          label,
          value,
          ...(payInAsset === undefined ? {} : { payInAsset }),
        })
      : {
          href,
          hrefLabel: hrefLabel ?? checkoutLabels.viewOnExplorer,
        };
  const external =
    link === undefined
      ? ""
      : `<a
        part="swap-external"
        class="${orClasses.swapDetailsLink}"
        href="${escapeHtml(link.href)}"
        rel="noreferrer"
        target="_blank"
      >${escapeHtml(link.hrefLabel)}</a>`;
  const valueField =
    label === "Address" || label === "Amount"
      ? `<input
          class="${orClasses.swapDetailsInput}"
          type="text"
          readonly
          value="${escapeHtml(displayValue)}"
          aria-label="${escapeHtml(label)}"
          ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapSelectAll}
        />`
      : `<code class="${orClasses.swapDetailsCode}">${escapeHtml(displayValue)}</code>`;
  return `
    <dt class="${orClasses.swapDetailsDt}">${escapeHtml(label)}</dt>
    <dd class="${orClasses.swapDetailsDd}">
      ${valueField}
      <div class="${orClasses.swapDetailsActions}">
        <button
          part="swap-copy"
          class="${orClasses.detailCopy}"
          aria-label="Copy"
          title="Copy"
          ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapCopy}="${escapeHtml(value)}"
          type="button"
        >${COPY_INVOICE_ICON}</button>
        ${external}
      </div>
    </dd>
  `;
}
