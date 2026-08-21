# React Material UI Recipe

This recipe composes OpenReceive's React checkout with Material UI components.
It is a composition example, not a dependency of OpenReceive.

Frontend code still receives only display-safe checkout data. The backend creates
the checkout, verifies payment, and owns fulfillment.

## Create mode (the default integration)

`<Checkout orderId>` prepares, mints, and polls by itself; Material UI comes in
through the component and class-name slots. Use the slots when your
design-system button accepts native button props:

```tsx
import Button from "@mui/material/Button";
import { Checkout } from "@openreceive/react";
import "@openreceive/react/styles.css";

export function MaterialOrderCheckout({ orderId }) {
  return (
    <Checkout
      orderId={orderId}
      prefix="/openreceive"
      components={{
        Button,
        InvoiceSummary: MaterialInvoiceSummary,
      }}
      classNames={{
        root: "or-material-root",
        actions: "or-material-actions",
      }}
    />
  );
}
```

## Snapshot variant (custom layout)

For a fully custom layout — here a Material `Dialog` — drive a checkout
snapshot through `useCheckout`. The hook polls the payment status itself (a
bare snapshot polls via the default `/openreceive` prefix; tune with
`orderUrl`, `polling`, and `pollIntervalMs`):

```tsx
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import {
  QRCode,
  PaymentState,
  useCheckout
} from "@openreceive/react";

export function MaterialCheckoutDialog({
  checkout,
  open,
  onClose
}) {
  const model = useCheckout({ checkout });

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
      <DialogContent>
        <Stack spacing={2} alignItems="center">
          <QRCode
            invoice={model.invoice}
            style={{
              inlineSize: 256,
              blockSize: 256
            }}
          />
          <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>
            {model.invoice}
          </Typography>
          <PaymentState state={model.status} />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={model.copyInvoice}>Copy</Button>
        <Button onClick={model.openWallet} variant="contained">
          Open Wallet
        </Button>
      </DialogActions>
    </Dialog>
  );
}
```

Everything above about `components` and `classNames` applies to both modes.

## Integration Notes

- Do not pass `nwc` or any receive-only NWC code into React.
- Create orders through your backend; the checkout mints from the order ID.
- Treat client polling as UI state only.
- Fulfill products only from your backend `onPaid` path.
- Keep Material UI theme ownership in your app.
