import { ShopApp } from "./shop-client.tsx";

/**
 * The shop page.
 *
 * The bootstrap payload is NOT server-rendered into this component, even
 * though Next.js could. It MINTS the visitor and sets a signed cookie, and a
 * server component cannot set one during render — so the client fetches
 * `/shop/bootstrap` exactly as the Express stack does, and identity is written
 * on a route rather than smuggled through a render.
 */
export default function Page() {
  return <ShopApp />;
}
