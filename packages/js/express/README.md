# @openreceive/express

Express adapter for the OpenReceive shipped routes. A thin wrapper over
[`@openreceive/http`](../http); all routing, authorization, capability-token, and
error-mapping logic lives there.

```ts
import express from "express";
import { createOpenReceive } from "@openreceive/node";
import { openReceiveExpress } from "@openreceive/express";

const service = await createOpenReceive();
const app = express();
app.use(express.json());
app.use(openReceiveExpress({ service, authorize, getOrderAmount }));
```

See `docs/guides/routes.md` for the route contract, tiers, and capability tokens.
