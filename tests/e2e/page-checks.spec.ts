import { expectPageProblem, type Page, test } from "./page-checks.ts";

/**
 * The page watch in page-checks.ts must have teeth: each page below does one
 * thing the watch exists to catch, so each test is marked `test.fail()`, and
 * passes only when the watch turned it red. Self-contained, like
 * element-mounts.spec.ts: the pages are served by `page.route`.
 */

const ORIGIN = "http://page-checks.test";

async function serve(page: Page, script: string): Promise<void> {
  await page.route(`${ORIGIN}/**`, async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === "/") {
      return route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html><body><script>${script}</script></body></html>`,
      });
    }
    if (pathname.startsWith("/openreceive/")) {
      // Never answers in time: the page gives up first.
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      return route.fulfill({ contentType: "application/json", body: "{}" }).catch(() => {});
    }
    return route.fulfill({ status: 404, body: "" });
  });
  await page.goto(`${ORIGIN}/`);
  await page.waitForTimeout(300);
}

const ABANDON_PREPARE = `
  const controller = new AbortController();
  fetch("/openreceive/checkouts/prepare", { method: "POST", body: "{}", signal: controller.signal }).catch(() => {});
  setTimeout(() => controller.abort(), 50);`;

test("the watch fails a test whose page logs console.error @smoke", async ({ page }) => {
  test.fail();
  await serve(page, `console.error("boom");`);
});

test("the watch fails a test whose page throws @smoke", async ({ page }) => {
  test.fail();
  await serve(page, `setTimeout(() => { throw new Error("boom"); }, 0);`);
});

test("the watch fails a test whose page abandons a prepare @smoke", async ({ page }) => {
  test.fail();
  await serve(page, ABANDON_PREPARE);
});

test("an expected page problem passes @smoke", async ({ page }) => {
  expectPageProblem(/^console: boom$/);
  await serve(page, `console.error("boom");`);
});

test("an expected page problem that never happens fails @smoke", async ({ page }) => {
  test.fail();
  expectPageProblem(/^abandoned: /);
  await serve(page, "");
});

test("a status poll cut off is not an abandoned checkout request @smoke", async ({ page }) => {
  await serve(
    page,
    `const controller = new AbortController();
     fetch("/openreceive/payments/check", { method: "POST", body: "{}", signal: controller.signal }).catch(() => {});
     setTimeout(() => controller.abort(), 50);`,
  );
});
