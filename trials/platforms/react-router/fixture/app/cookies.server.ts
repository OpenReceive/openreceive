import { createCookie } from "react-router";

// Who placed an order: the id of a row in `users`. Plain http in Docker, so
// the cookie is not `secure`.
export const widgetUser = createCookie("widget_user", {
  httpOnly: true,
  path: "/",
  sameSite: "lax",
});
