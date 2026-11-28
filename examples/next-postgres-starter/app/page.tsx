import { formatPrice, product } from "@/lib/catalog";
import { walletConfigured } from "@/lib/config";
import { buy } from "./actions";
import { StickerArt } from "./art";
import { BuyButton } from "./buy-button";
import { Setup } from "./setup";

// Reads NWC_URI on each request, so the setup steps show until it is set.
export const dynamic = "force-dynamic";

export default function Home() {
  if (!walletConfigured()) return <Setup />;
  const price = formatPrice(product.price, product.currency);
  return (
    <section className="card product" aria-labelledby="product-name">
      <div className="product-art">
        <StickerArt />
      </div>
      <div className="product-body">
        <p className="eyebrow">Pay with Bitcoin Lightning</p>
        <h1 id="product-name">{product.name}</h1>
        <p className="price">{price}</p>
        <p className="lede">{product.description}</p>
        <ul className="facts">
          <li>Pay from any Lightning wallet in seconds.</li>
          <li>The price converts to bitcoin when you check out.</li>
          <li>Bookmark the order page to come back to it.</li>
        </ul>
        <form action={buy}>
          <BuyButton label={`Buy for ${price}`} />
        </form>
      </div>
    </section>
  );
}
