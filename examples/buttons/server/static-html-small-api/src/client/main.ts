// The packaged checkout's stylesheet, then the shop's design, then the
// no-framework client's own controls. Same order, same cascade, as every other
// stack.
import "@openreceive/elements/styles.css";
import "../../../../shared/shop.css";
import "../../../../shared/client-vanilla/shop-vanilla.css";

// The whole UI. See the note at the top of that file for what it deliberately
// does and does not share with the React clients.
import "../../../../shared/client-vanilla/main.ts";
