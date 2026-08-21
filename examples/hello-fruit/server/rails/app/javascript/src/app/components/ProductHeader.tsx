import { observer } from "mobx-react";
import type React from "react";
import { useContext } from "react";
import { ShopWorkspaceContext } from "../stores/ShopWorkspace.ts";

/**
 * Port of the vanilla renderProduct(): sticker image for the selected fruit
 * next to the product title and description. Fruit stickers arrive from the
 * bootstrap as absolute public paths, so the src is used as-is.
 */
const ProductHeader: React.FC = observer(() => {
  const workspace = useContext(ShopWorkspaceContext);
  const fruit = workspace.selectedFruit;

  return (
    <div className="flex gap-3 items-center" id="product-header">
      <img
        className="w-16 aspect-square"
        id="product-sticker"
        alt=""
        {...(fruit === undefined ? {} : { src: fruit.sticker })}
      />
      <div className="min-w-0">
        <h1 className="text-2xl font-bold leading-tight" id="product-title">
          {workspace.productInfo.data.name}
        </h1>
        <p className="text-base-content/70 text-sm" id="product-description">
          {workspace.productInfo.data.description}
        </p>
      </div>
    </div>
  );
});

export default ProductHeader;
