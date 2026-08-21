import { observer } from "mobx-react";
import type React from "react";
import { useContext } from "react";
import {
  formatHelloFruitBuyNowLabel,
  helloFruitDemoLabels,
} from "../../../../../../../shared/demo-formatting.ts";
import {
  formatHelloFruitDisplayPrice,
  toHelloFruitDisplayAmount,
} from "../../../../../../../shared/demo-pricing.ts";
import { ShopWorkspaceContext } from "../stores/ShopWorkspace.ts";

/**
 * Shop mode: currency picker, fruit grid, add-to-cart, cart card and the
 * create-order button. Port of renderCurrencyPicker / renderFruitGrid /
 * renderCreateOrderControls / renderCart from the vanilla client.
 */
const ShopPanel: React.FC = observer(() => {
  const workspace = useContext(ShopWorkspaceContext);
  const selectedFruit = workspace.selectedFruit;
  const rates = workspace.rates.data ?? undefined;
  const cartItems = workspace.cartItems;
  const cartQuantity = workspace.cartQuantity;

  return (
    <div className="grid gap-3" id="shop-panel">
      <div id="currency-panel">
        <label className="form-control w-full max-w-xs">
          <span className="label-text mb-1">Currency</span>
          <select
            className="select select-bordered w-full"
            value={workspace.selectedCurrency}
            onChange={(event) => workspace.setCurrency(event.target.value)}
          >
            {workspace.currencyOptions.data.map((currency) => (
              <option key={currency} value={currency}>
                {currency}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2" id="fruit-grid">
        {workspace.fruits.data.map((fruit) => (
          <button
            key={fruit.id}
            type="button"
            className={[
              "card card-border bg-base-100 p-3 grid gap-2 text-left cursor-pointer hover:border-primary",
              fruit.id === workspace.selectedFruitId ? "border-primary ring-2 ring-primary/30" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            onClick={() => workspace.selectFruit(fruit.id)}
          >
            <img className="w-full aspect-square" src={fruit.sticker} alt="" />
            <span>{fruit.name}</span>
            <small className="text-base-content/70">
              {formatHelloFruitDisplayPrice(fruit.fiat, workspace.selectedCurrency, rates)}
            </small>
          </button>
        ))}
      </div>

      {selectedFruit === undefined ? null : (
        <button
          className="btn btn-outline"
          id="add-to-cart"
          type="button"
          onClick={() => workspace.addSelectedFruitToCart()}
        >
          {formatHelloFruitBuyNowLabel(
            toHelloFruitDisplayAmount(selectedFruit.fiat, workspace.selectedCurrency, rates),
          )}
        </button>
      )}

      <div id="cart-panel">
        {cartItems.length === 0 ? null : (
          <section
            className="card card-border bg-base-100 px-3 py-2.5 grid gap-1.5"
            aria-label="Cart"
          >
            <div className="flex justify-between items-center text-sm">
              <strong>Cart</strong>
              <span>{`${cartQuantity} item${cartQuantity === 1 ? "" : "s"}`}</span>
            </div>
            {cartItems.map((item) => (
              <div key={item.fruit.id} className="flex justify-between items-center gap-2 text-sm">
                <span>{`${item.fruit.name} ×${item.quantity}`}</span>
                <button
                  className="btn btn-ghost btn-xs"
                  type="button"
                  onClick={() => workspace.removeFruitFromCart(item.fruit.id)}
                >
                  Remove
                </button>
              </div>
            ))}
          </section>
        )}
      </div>

      {cartQuantity === 0 ? null : (
        <button
          className="btn btn-outline"
          id="create-order"
          type="button"
          disabled={workspace.creatingOrder}
          onClick={() => void workspace.createOrder()}
        >
          {workspace.creatingOrder
            ? helloFruitDemoLabels.creatingOrder
            : helloFruitDemoLabels.createOrder}
        </button>
      )}
    </div>
  );
});

export default ShopPanel;
