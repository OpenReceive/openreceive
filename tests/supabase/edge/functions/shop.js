// The shop's side of both functions: its orders, and the buyer known by the
// `buyer` cookie the shop set when it created the order.
export function currentBuyer(request) {
  const cookie = request.headers.get("cookie") ?? "";
  return cookie
    .split(";")
    .map((part) => part.trim().split("="))
    .find(([name]) => name === "buyer")?.[1];
}

export function orderAmount(order) {
  return order?.state === "awaiting_payment"
    ? { currency: "SAT", value: order.amount, description: "Edge Function order" }
    : null;
}

/** The routes sit under /openreceive/ wherever the function is mounted. */
export function routed(request) {
  const url = new URL(request.url);
  const at = url.pathname.indexOf("/openreceive/");
  return at < 0 ? null : new Request(new URL(url.pathname.slice(at), url.origin), request);
}
