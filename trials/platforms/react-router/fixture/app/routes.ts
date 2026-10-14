import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("orders", "routes/orders.ts"),
  route("orders/:id", "routes/order.tsx"),
  route("health", "routes/health.ts"),
] satisfies RouteConfig;
