import { observer } from "mobx-react";
import type React from "react";
import { useContext } from "react";
import { formatHelloFruitFiat } from "../../../../../../../shared/demo-formatting.ts";
import type { HelloFruitOrderItem } from "../../../../../../../shared/demo-order.ts";
import { ShopWorkspaceContext } from "../stores/ShopWorkspace.ts";

/**
 * Port of the vanilla renderOrder(): the order summary card shown in pay mode
 * with per-item payment state and the "Start over" action.
 */
const OrderPanel: React.FC = observer(() => {
  const workspace = useContext(ShopWorkspaceContext);
  const order = workspace.order?.data;
  if (order === undefined) return null;

  return (
    <section className="card card-border bg-base-200 px-3 py-2.5 grid gap-1" aria-label="Order">
      <div className="flex justify-between items-baseline gap-3">
        <strong className="text-sm">Order</strong>
        <span className="font-semibold">{formatHelloFruitFiat(order.total_amount)}</span>
      </div>
      {order.items.map((item: HelloFruitOrderItem) => (
        <div
          key={item.product_id}
          className="flex justify-between items-baseline gap-3 text-sm text-base-content/80"
        >
          <span>{`${item.name} ×${item.quantity}`}</span>
          <span className="text-base-content/60">
            {order.status === "paid" ? "Paid" : "Awaiting payment"}
          </span>
        </div>
      ))}
      <div className="card-actions pt-1">
        <button
          className="btn btn-sm btn-outline"
          type="button"
          onClick={() => workspace.startOver()}
        >
          Start over
        </button>
      </div>
    </section>
  );
});

export default OrderPanel;
