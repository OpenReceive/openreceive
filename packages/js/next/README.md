# @openreceive/next

Next.js App Router handlers for the OpenReceive shipped routes. A thin pass-through over
[`@openreceive/http`](../http) (Next route handlers already speak Web Request/Response).

```ts
// app/openreceive/[...openreceive]/route.ts
import { createOpenReceive } from "@openreceive/node";
import { openReceiveNextHandlers } from "@openreceive/next";

const service = await createOpenReceive();
export const { GET, POST } = openReceiveNextHandlers({ service, authorize, getOrderAmount });
```

See `docs/guides/routes.md` for the route contract, tiers, and capability tokens.
