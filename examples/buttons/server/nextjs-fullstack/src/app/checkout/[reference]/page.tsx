import { ShopApp } from "../../shop-client.tsx";

/**
 * The checkout's own URL.
 *
 * A payer with a swap deposit in flight has no account and no email from us —
 * `/checkout/:reference` is the only thing that brings them back to their
 * payment screen, so it has to survive a hard reload and a bookmark.
 *
 * The SAME component as the root page, deliberately: the shop reads the uuid
 * off `location.pathname` and asks its own `/shop/orders/:reference` for the
 * summary — the route that decides whether this browser may see it — rather
 * than this segment resolving anything. That is also what lets the client push
 * this path with the History API without asking the app router for a different
 * tree, so placing an order changes the address bar and remounts nothing.
 */
export default function CheckoutPage() {
  return <ShopApp />;
}
