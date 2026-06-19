# React Material UI Recipe

This recipe uses `@openreceive/react` primitives with Material UI components.
It is a composition example, not a dependency of OpenReceive.

Frontend code still receives only display-safe invoice data. The backend creates
the invoice, performs lookup, and owns fulfillment.

## Component

```tsx
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import {
  OpenReceiveQRCode,
  OpenReceivePaymentState,
  useOpenReceiveCheckout
} from "@openreceive/react";

export function MaterialOpenReceiveCheckout({
  invoice,
  payment_hash,
  amount_msats,
  transaction_state,
  open,
  onClose
}) {
  const checkout = useOpenReceiveCheckout({
    invoice,
    payment_hash,
    amount_msats,
    transaction_state
  });

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
      <DialogContent>
        <Stack spacing={2} alignItems="center">
          <OpenReceiveQRCode
            invoice={checkout.invoice}
            style={{
              inlineSize: 256,
              blockSize: 256
            }}
          />
          <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>
            {checkout.invoice}
          </Typography>
          <OpenReceivePaymentState state={checkout.transaction_state} />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={checkout.copyInvoice}>Copy</Button>
        <Button onClick={checkout.openWallet} variant="contained">
          Open Wallet
        </Button>
      </DialogActions>
    </Dialog>
  );
}
```

## Integration Notes

- Do not pass `OPENRECEIVE_NWC` or any wallet secret into React.
- Create invoices through the merchant backend.
- Treat event streams and client polling as UI state only.
- Fulfill products only after backend lookup confirms settlement.
- Keep Material UI theme ownership in the host app.
