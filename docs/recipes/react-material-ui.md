# React Material UI Recipe

This recipe composes OpenReceive's React checkout with Material UI components.
It is a composition example, not a dependency of OpenReceive.

Frontend code still receives only display-safe checkout data. The backend creates
the checkout, verifies payment, and owns fulfillment.

## Create mode (the default integration)

`<Checkout reference>` prepares, mints, and polls by itself; Material UI comes in
through the component and class-name slots. Use the slots when your
design-system button accepts native button props:

```tsx
import Button from "@mui/material/Button";
import { Checkout } from "@openreceive/react";
import "@openreceive/react/styles.css";

export function MaterialOrderCheckout({ reference }) {
  return (
    <Checkout
      reference={reference}
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
snapshot through `useCheckout`. Unlike `<Checkout>`, the hook does not default
`prefix`, so the bare `useCheckout({ checkout })` below renders the snapshot it
is handed and never polls — the dialog updates only when the parent passes a
newer snapshot. Add `prefix` to make the hook poll `${prefix}/payments/check`
itself (`useCheckout({ checkout, prefix: "/openreceive" })`), then tune it with
`pollIntervalMs`, or stop it again with `polling: false`:

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
  const isTouchDevice = window.matchMedia("(pointer: coarse)").matches;

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
        {/* Copy is the primary action, and it is the only one on a desktop.
            `model.openWallet` hands the payer a `lightning:` URI by navigating
            the CURRENT window: with no registered handler the click is inert,
            and with one it takes the payer off a checkout that is still
            polling. Draw it only where it works — which is why the shipped
            <Checkout> ships no wallet button and exposes
            `components.OpenWalletButton` as an opt-in slot instead. */}
        <Button onClick={model.copyInvoice} variant="contained">
          Copy invoice
        </Button>
        {isTouchDevice && (
          <Button onClick={model.openWallet}>Open Wallet</Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
```

Everything above about `components` and `classNames` applies to both modes.

The QR code is the desktop payment path, so the dialog above leads with Copy and
keeps the wallet button behind a touch check. See
[Headless checkout](../guides/headless-checkout.md#the-openreceivebrowserheadless-surface)
for what `openWallet` actually does.

## Integration Notes

- Do not pass `nwc` or any receive-only NWC code into React.
- Create orders through your backend; the checkout mints from the order ID.
- Treat client polling as UI state only.
- Fulfill products only from your backend `onPaid` path.
- Keep Material UI theme ownership in your app.
