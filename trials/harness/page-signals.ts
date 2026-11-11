import type { Browser, BrowserContext, Page } from "@playwright/test";
import type { Check } from "./types.ts";

// What every page of a payer walk did that the payer would suffer from and no
// step looked at: console errors, uncaught exceptions, and checkout requests
// the page started and gave up on. Issue #137 was the last of these: an
// element that aborted its own prepare and sent another, on every order page
// of six store plugins, and nothing in the walk noticed. Both checks are
// polish, not blockers: a React development build mounts every component
// twice (StrictMode) and abandons the first prepare by design, and a shop's
// own scripts may log errors that are not OpenReceive's.

export interface PageSignals {
  readonly uncaught: string[];
  readonly consoleErrors: string[];
  readonly abandoned: string[];
}

export const PAGE_SIGNAL_IDS = {
  console: "payer_console_clean",
  abandoned: "payer_no_abandoned_checkout_requests",
} as const;

/** POST routes that start work on the server: prepare, create, swap. */
const CHECKOUT_WORK = /\/(?:checkouts(?:\/prepare)?|swaps)\/?$/;

/**
 * The checkout route a POST names when it starts work on the server, or
 * undefined. The route is in the path, in `?rest_route=` (WordPress's plain
 * permalinks) or in `?path=` (PrestaShop's module controller).
 */
export function checkoutWorkRoute(method: string, href: string): string | undefined {
  if (method.toUpperCase() !== "POST") return undefined;
  const url = new URL(href);
  return [url.pathname, url.searchParams.get("rest_route"), url.searchParams.get("path")].find(
    (route): route is string => route !== null && CHECKOUT_WORK.test(route),
  );
}

/** A console error worth reporting: Chromium's own failed-resource lines are left out. */
export function reportableConsoleError(type: string, text: string): boolean {
  return type === "error" && !text.startsWith("Failed to load resource");
}

function watchPage(page: Page, signals: PageSignals): void {
  page.on("pageerror", (error) => signals.uncaught.push(`${page.url()}: ${error.message}`));
  page.on("console", (message) => {
    if (reportableConsoleError(message.type(), message.text())) {
      signals.consoleErrors.push(`${page.url()}: ${message.text()}`);
    }
  });
  page.on("requestfailed", (request) => {
    const route = checkoutWorkRoute(request.method(), request.url());
    if (route === undefined) return;
    signals.abandoned.push(
      `${page.url()}: POST ${route} (${request.failure()?.errorText ?? "failed"})`,
    );
  });
}

/**
 * Watch every page any context of `browser` opens from now on. Each step of a
 * walk makes its own context (a fresh buyer), so the watch goes on the
 * browser, not on one page.
 */
export function watchBrowserPages(browser: Browser): PageSignals {
  const signals: PageSignals = { uncaught: [], consoleErrors: [], abandoned: [] };
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (...args: Parameters<Browser["newContext"]>) => {
    const context: BrowserContext = await newContext(...args);
    for (const page of context.pages()) watchPage(page, signals);
    context.on("page", (page) => watchPage(page, signals));
    return context;
  };
  return signals;
}

function listed(lines: readonly string[]): string {
  const shown = lines.slice(0, 8).join(" | ");
  return lines.length > 8 ? `${shown} | and ${lines.length - 8} more` : shown;
}

export function pageSignalChecks(signals: PageSignals): Check[] {
  const errors = [...signals.uncaught.map((line) => `uncaught ${line}`), ...signals.consoleErrors];
  return [
    {
      id: PAGE_SIGNAL_IDS.console,
      severity: "polish",
      pass: errors.length === 0,
      summary: "No page of the walk threw an uncaught error or logged a console error.",
      ...(errors.length === 0 ? {} : { evidence: listed(errors) }),
    },
    {
      id: PAGE_SIGNAL_IDS.abandoned,
      severity: "polish",
      pass: signals.abandoned.length === 0,
      summary:
        "No page started a prepare, create or swap request and then abandoned it (a React development build does this once per mount; a production build must not).",
      ...(signals.abandoned.length === 0 ? {} : { evidence: listed(signals.abandoned) }),
    },
  ];
}
