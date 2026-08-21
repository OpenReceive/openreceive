import { TransactionDetails } from "@openreceive/react";
import { observer } from "mobx-react";
import type React from "react";
import { useContext } from "react";
import { helloFruitStickerModalCopy } from "../../../../../../../shared/demo-formatting.ts";
import { ShopWorkspaceContext } from "../stores/ShopWorkspace.ts";

/**
 * Post-payment sticker download dialog. Transaction details render via the
 * shared @openreceive/react component once the checkout has settled.
 */
const StickerModal: React.FC = observer(() => {
  const workspace = useContext(ShopWorkspaceContext);
  const modal = workspace.stickerModal?.data;
  if (modal === undefined) return null;
  const checkout = workspace.checkout;
  const settledState = checkout?.settled === true ? checkout.state : undefined;
  const copy = helloFruitStickerModalCopy(modal.stickers);

  return (
    <div className="modal modal-open" id="sticker-modal-backdrop">
      <section
        className="modal-box"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sticker-modal-title"
      >
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 justify-items-center">
          {modal.stickers.map((sticker) => (
            <img
              className="w-full max-w-[180px] aspect-square"
              key={sticker.productId}
              src={sticker.objectUrl}
              alt=""
            />
          ))}
        </div>
        <h2 className="text-2xl font-bold" id="sticker-modal-title">
          {copy.title}
        </h2>
        <p>{copy.detail}</p>
        <div className="grid gap-2">
          {modal.stickers.map((sticker) => (
            <a
              className="card card-border bg-base-100 flex-row items-center gap-3 p-3"
              download={sticker.filename}
              href={sticker.objectUrl}
              key={sticker.productId}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold">{sticker.name} sticker</span>
                <span className="block text-sm text-base-content/60">
                  SVG file{sticker.quantity > 1 ? ` · ×${sticker.quantity}` : ""}
                </span>
              </span>
              <span className="btn btn-primary btn-sm">Download</span>
            </a>
          ))}
        </div>
        {settledState === undefined ? null : <TransactionDetails state={settledState} />}
        <div className="modal-action">
          <button className="btn" type="button" onClick={() => workspace.closeStickerModal()}>
            Close
          </button>
        </div>
      </section>
    </div>
  );
});

export default StickerModal;
