import { test as base, expect, type Page } from "@playwright/test";

/**
 * Every browser spec's `test`: the same Playwright test, plus a watch on the
 * page that fails the test when the page did something a payer would suffer
 * from and no assertion looked at.
 *
 * - An uncaught exception in the page.
 * - A `console.error`. Chromium's own "Failed to load resource" lines are left
 *   out: specs that walk a failure path provoke server errors on purpose and
 *   assert on the answers themselves. The checkout's `console.warn` for a
 *   reworded error is by design and is not an error.
 * - An abandoned checkout request: a prepare, create or swap the page started
 *   and the browser gave up on. Issue #137 was exactly this (the element
 *   aborted its own prepare and sent another), and no spec asserted on it.
 *
 * A spec that expects one of these says so with `expectPageProblem`, and the
 * watch then requires it to happen.
 */

const ALLOW = "expected-page-problem";

/** POST routes that start work on the server: prepare, create, swap. */
const CHECKOUT_WORK = /\/(?:checkouts(?:\/prepare)?|swaps)\/?$/;

export interface PageProblems {
  readonly uncaught: string[];
  readonly consoleErrors: string[];
  readonly abandoned: string[];
}

export function watchPageProblems(page: Page): PageProblems {
  const problems: PageProblems = { uncaught: [], consoleErrors: [], abandoned: [] };
  page.on("pageerror", (error) => problems.uncaught.push(error.message));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (text.startsWith("Failed to load resource")) return;
    problems.consoleErrors.push(text);
  });
  page.on("requestfailed", (request) => {
    if (request.method() !== "POST") return;
    const url = new URL(request.url());
    // WordPress's plain permalinks carry the route in ?rest_route=.
    const route = url.searchParams.get("rest_route") ?? url.pathname;
    if (!CHECKOUT_WORK.test(route)) return;
    problems.abandoned.push(`POST ${route} (${request.failure()?.errorText ?? "failed"})`);
  });
  return problems;
}

/**
 * This test is expected to produce a page problem matching `pattern` (checked
 * against "uncaught: …", "console: …" or "abandoned: …"). The test fails if it
 * does not.
 */
export function expectPageProblem(pattern: RegExp): void {
  test.info().annotations.push({ type: ALLOW, description: pattern.source });
}

export const test = base.extend<{ pageProblems: PageProblems }>({
  pageProblems: [
    async ({ page }, use, testInfo) => {
      const problems = watchPageProblems(page);
      await use(problems);
      // A test that already failed has said what went wrong.
      if (testInfo.status === "failed" || testInfo.status === "timedOut") return;
      const seen = [
        ...problems.uncaught.map((text) => `uncaught: ${text}`),
        ...problems.consoleErrors.map((text) => `console: ${text}`),
        ...problems.abandoned.map((text) => `abandoned: ${text}`),
      ];
      const expected = testInfo.annotations
        .filter((annotation) => annotation.type === ALLOW)
        .map((annotation) => new RegExp(annotation.description ?? ""));
      const unexpected = seen.filter((line) => !expected.some((pattern) => pattern.test(line)));
      const missing = expected.filter((pattern) => !seen.some((line) => pattern.test(line)));
      expect(unexpected, "the page threw, logged an error or abandoned a checkout request").toEqual(
        [],
      );
      expect(
        missing.map((pattern) => pattern.source),
        "a page problem this test expects did not happen",
      ).toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

export type { Locator, Page } from "@playwright/test";
