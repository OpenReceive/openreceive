import { expect, test } from "@playwright/test";
import {
  addButtonToCart,
  bitcoinTile,
  expectWizardCurrencies,
  openShop,
  paymentColumn,
  selectFrameworkTab,
  startCheckout,
} from "./helpers.ts";

/**
 * The drop-in is an EMBEDDED component: the host decides its box, and that
 * box is routinely much narrower than the viewport. Every responsive rule in
 * the checkout therefore keys on the checkout's own inline size (the root is a
 * CSS query container), never on a viewport media query.
 *
 * The shape that caught this: a 560px-max card on a 1280px page. With
 * viewport breakpoints the `md:` two-column provider list fired at 1280px and
 * split 560px into two 234px cards, whose icon+name column collapsed to 1.6px
 * — the 28px provider icon was crushed to a sliver and the name truncated to
 * nothing. The same page at a 700px viewport (one column) was perfect.
 */

const HOST_BOX_WIDTH = 560;
const VIEWPORT = { width: 1280, height: 900 };

for (const framework of ["react", "vue"] as const) {
  test(`${framework} tab: a ${HOST_BOX_WIDTH}px host box lays out by its own width, not the viewport's`, async ({
    page,
  }) => {
    await page.setViewportSize(VIEWPORT);
    await openShop(page);
    await addButtonToCart(page);
    await startCheckout(page);
    // Narrow the payment column to the card width, on top of the shop's own
    // stylesheet — exactly what a host card, sidebar or modal does.
    await page.addStyleTag({
      content: `.or-checkout-pay { max-width: ${HOST_BOX_WIDTH}px !important; }`,
    });
    await selectFrameworkTab(page, framework);
    await expectWizardCurrencies(page);
    await bitcoinTile(page).click();
    await expect(page.getByText("Bitcoin Lightning invoice")).toBeVisible();

    const column = paymentColumn(page);
    const columnBox = await column.boundingBox();
    expect(columnBox?.width ?? 0).toBeLessThanOrEqual(HOST_BOX_WIDTH);

    // The checkout root: a query container that paints a padded surface.
    // `section[part=root]` is the custom element's root inside its shadow
    // root (Playwright pierces it); React's carries the data attributes.
    const root = column
      .locator("[data-openreceive-root][data-openreceive-checkout], section[part='root']")
      .first();
    await expect(root).toBeVisible();
    const rootStyles = await root.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        containerType: style.containerType,
        paddingLeft: Number.parseFloat(style.paddingLeft),
        paddingTop: Number.parseFloat(style.paddingTop),
        backgroundColor: style.backgroundColor,
        width: element.getBoundingClientRect().width,
      };
    });
    expect(rootStyles.containerType).toBe("inline-size");
    expect(rootStyles.width).toBeLessThanOrEqual(HOST_BOX_WIDTH);
    // FIX 4: a painted surface (daisyUI's base-100 on the theme root) must
    // pad itself — content flush against the edge of a colour slab is never
    // right. Either transparent or >= 16px; the current build pads.
    const transparent = rootStyles.backgroundColor === "rgba(0, 0, 0, 0)";
    if (!transparent) {
      expect(rootStyles.paddingLeft).toBeGreaterThanOrEqual(16);
      expect(rootStyles.paddingTop).toBeGreaterThanOrEqual(16);
    }

    // The Bitcoin provider (wallet tutorial) list: every card keeps its icon
    // and its name at this width. This single assertion would have caught the
    // 1.6px column.
    const cards = column.locator("article");
    await expect(cards.first()).toBeVisible();
    const cardCount = await cards.count();
    expect(cardCount).toBeGreaterThan(0);
    for (let index = 0; index < Math.min(cardCount, 4); index += 1) {
      const card = cards.nth(index);
      const icon = card.locator("img").first();
      const name = card.locator("h4").first();
      const iconBox = await icon.boundingBox();
      const nameBox = await name.boundingBox();
      expect(iconBox?.width ?? 0, `provider icon ${index}`).toBeGreaterThanOrEqual(24);
      expect(nameBox?.width ?? 0, `provider name ${index}`).toBeGreaterThan(0);
    }

    // The QR sizes from the container (cqw), not the viewport: below the
    // @md container breakpoint it is min(148px, 38cqw) = 148px here.
    const qr = column.locator("[data-openreceive-qr] svg, [part='qr'] svg").first();
    await expect(qr).toBeVisible();
    const qrBox = await qr.boundingBox();
    expect(qrBox?.width ?? 0).toBeGreaterThanOrEqual(140);
    expect(qrBox?.width ?? 0).toBeLessThanOrEqual(150);

    // Containment must not capture the provider tutorial modal: it is
    // position: fixed and has to cover the VIEWPORT, not the 560px box.
    // Providers without a tutorial link out instead; take the first with one.
    await cards.getByRole("button", { name: "How To Pay" }).first().click();
    const modal = column.locator(".modal").first();
    await expect(modal).toBeVisible();
    const modalBox = await modal.boundingBox();
    expect(modalBox?.width ?? 0).toBeGreaterThanOrEqual(VIEWPORT.width - 1);
    expect(modalBox?.x ?? 1).toBeLessThanOrEqual(0);
  });
}
