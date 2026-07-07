# React Material UI Recipe

This recipe uses the individual `@openreceive/react` checkout components with
Material UI components. It is a composition example, not a dependency of
OpenReceive.

Frontend code still receives only display-safe checkout data. The backend creates
the checkout, verifies payment, and owns fulfillment.

## Component

```tsx
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import {
  Checkout,
  QRCode,
  PaymentState,
  useCheckout
} from "@openreceive/react";

export function MaterialCheckout({
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

The default checkout also accepts component and class slots. Use those slots
when your design-system button accepts native button props; otherwise keep
using the headless actions as shown above.

```tsx
<Checkout
  checkout={checkout}
  orderUrl="/order"
  components={{
    Button,
    InvoiceSummary: MaterialInvoiceSummary
  }}
  classNames={{
    root: "or-material-root",
    actions: "or-material-actions"
  }}
/>
```

## Integration Notes

- Do not pass `OPENRECEIVE_NWC` or any receive-only NWC code into React.
- Create invoices through your backend.
- Treat client polling as UI state only.
- Fulfill products only from your backend `onPaid` path.
- Keep Material UI theme ownership in the host app.
