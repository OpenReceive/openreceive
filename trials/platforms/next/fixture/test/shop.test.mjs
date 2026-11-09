import assert from "node:assert/strict";
import test from "node:test";
import {
  createOrder,
  createUser,
  findOrder,
  findProduct,
  findUser,
  listProducts,
} from "../lib/shop.js";

test("the catalog has its five products", () => {
  assert.deepEqual(
    listProducts().map((product) => product.name),
    ["Facet", "Bezel", "Hinge", "Latch", "Knob"],
  );
  assert.equal(findProduct(1).price, "7.00");
});

test("a buyer's order is theirs alone", () => {
  const buyer = `buyer-${process.pid}`;
  createUser(buyer);
  assert.equal(findUser(buyer).id, buyer);
  const id = createOrder(buyer, findProduct(1));
  assert.equal(findOrder(id, buyer).status, "awaiting_payment");
  assert.ok(findOrder(id, "someone-else") === undefined);
});
