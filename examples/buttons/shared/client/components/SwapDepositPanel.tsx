import { Alert, Button, Group, Stack, Text, TextInput } from "@mantine/core";
import { checkoutLabels, type SwapDisplayModel } from "@openreceive/browser/headless";
import { IconAlertTriangle, IconInfoCircle } from "@tabler/icons-react";
import { observer } from "mobx-react";
import type React from "react";
import type { ShopCheckout } from "../stores/ShopCheckout.ts";
import { CheckoutLinkAlert } from "./CheckoutLink.tsx";
import { CopyRow } from "./CopyRow.tsx";
import { usePayloadQrSvg } from "./useQrSvg.ts";

type SwapPanelProps = { checkout: ShopCheckout; swap: SwapDisplayModel };

/**
 * The three states in which there is a refund to talk about and no deposit to
 * make. Everything the deposit panel shows — the QR, the address, the amount,
 * the fee breakdown — is either done with or actively misleading here: a payer
 * who reads "send 15.01 USDT to this address" while their last send is being
 * refunded will send twice.
 */
const REFUND_STATES: ReadonlySet<SwapDisplayModel["state"]> = new Set([
  "refund_required",
  "refund_pending",
  "refunded",
]);

/**
 * The swap attempt, as one screen.
 *
 * A refund REPLACES the deposit panel rather than appearing under it. This is
 * the whole reason the two branches are separate components: the deposit
 * branch owns a QR hook, and a component that rendered both would have to run
 * it for a screen with no code on it.
 */
export const SwapDepositPanel: React.FC<SwapPanelProps> = observer(({ checkout, swap }) =>
  REFUND_STATES.has(swap.state) ? (
    <SwapRefundStage checkout={checkout} swap={swap} />
  ) : (
    <SwapDepositStage swap={swap} />
  ),
);

const SwapDepositStage: React.FC<{ swap: SwapDisplayModel }> = observer(({ swap }) => {
  const qr = usePayloadQrSvg(swap.qrPayload);

  return (
    <Stack gap="sm">
      {/* The alarm is scoped to the rails where it is TRUE. The risk comes
          from a deposit ADDRESS that fails to pin the chain, so ETH, USDT and
          USDC get the full warning and SOL — where a base58 ed25519 address is
          Solana-only — gets a quiet "Send the exact amount". A banner shown on
          every rail is read on none. `depositRisk` is on the model; the table
          is not ours to re-derive. */}
      <Alert
        color={swap.depositRisk === "pinned" ? "gray" : "red"}
        variant="light"
        icon={swap.depositRisk === "pinned" ? <IconInfoCircle /> : <IconAlertTriangle />}
        title={swap.networkWarningTitle}
      >
        <Text size="sm">{swap.networkWarning}</Text>
        <Text size="sm" fw={700} mt={4}>
          {swap.networkWarningEmphasis}
        </Text>
      </Alert>

      {/* The deposit address and the amount belong NEXT TO the code that
          encodes them, not under it — a payer typing six decimals by hand is
          reading both. */}
      <div className="or-shop-payload">
        {qr ? (
          <div
            className="or-shop-qr"
            role="img"
            aria-label={`${swap.assetLabel} deposit address`}
            dangerouslySetInnerHTML={{ __html: qr }}
          />
        ) : null}

        <Stack gap="sm">
          {/* Address, memo AND the bare amount each get a labelled copy row.
              The amount is the one that gets left out and the one that costs
              money: on token rails the QR encodes the address and carries no
              amount, so the payer types six decimals by hand, and a short send
              against a fixed-rate order is `refund_required`. */}
          <Stack gap={8}>
            {swap.copyRows.map((row) => (
              <CopyRow
                key={row.label}
                label={row.label}
                value={row.copyValue ?? row.value}
                selectable={row.selectable}
              />
            ))}
          </Stack>

          <Group justify="space-between">
            <Text size="sm" c="dimmed">
              {swap.providerStateLabel}
            </Text>
            {swap.countdownLabel ? (
              <Text size="sm" c="dimmed">
                {swap.countdownLabel}
              </Text>
            ) : null}
          </Group>
          <Text size="sm">{swap.providerStateDetail}</Text>
        </Stack>
      </div>

      {swap.feeBreakdown ? <FeeBreakdown swap={swap} /> : null}
    </Stack>
  );
});

const FeeBreakdown: React.FC<{ swap: SwapDisplayModel }> = ({ swap }) => {
  const fees = swap.feeBreakdown;
  if (!fees) return null;

  const rows: [string, string | undefined][] = [
    [checkoutLabels.cartTotal, fees.cartTotal],
    [checkoutLabels.youSend, fees.youSend],
    [
      checkoutLabels.swapAndNetworkFees,
      fees.feePercent ? `${fees.fee} (${fees.feePercent})` : fees.fee,
    ],
  ];

  return (
    <div className="or-shop-fees">
      <Text className="or-shop-section-title">{checkoutLabels.paymentBreakdown}</Text>
      {rows
        .filter(([, value]) => Boolean(value))
        .map(([label, value]) => (
          <Group key={label} justify="space-between" gap="xs">
            <Text size="sm" c="dimmed">
              {label}
            </Text>
            <Text size="sm">{value}</Text>
          </Group>
        ))}
    </div>
  );
};

/**
 * The whole payment column, once a deposit needs refunding.
 *
 * There is no merchant-initiated refund of a settled Lightning payment — the
 * wallet cannot spend. This is the other kind: a payer reclaiming a deposit
 * that never converted. It is the worst moment in the flow and the one where
 * the payer is most likely to close the tab, so the screen says the whole of
 * what is happening, in this order: what went wrong, how to come back, and the
 * form.
 */
const SwapRefundStage: React.FC<SwapPanelProps> = observer(({ checkout, swap }) => (
  <Stack gap="sm" className="or-shop-refund-stage">
    <Alert color="red" variant="light" icon={<IconAlertTriangle />} title={swap.providerStateLabel}>
      <Text size="sm">{swap.providerStateDetail}</Text>
    </Alert>

    <CheckoutLinkAlert checkout={checkout} label={swap.refundReturnLabel} />

    <RefundFacts swap={swap} />

    {swap.state === "refund_required" ? (
      <RefundForm checkout={checkout} swap={swap} />
    ) : (
      <Stack gap={8}>
        {swap.refundAddress ? (
          <CopyRow label="Refund address" value={swap.refundAddress} selectable truncate />
        ) : null}
        {swap.refundTxId ? (
          <CopyRow label="Refund transaction" value={swap.refundTxId} truncate />
        ) : null}
      </Stack>
    )}
  </Stack>
));

/** What the provider says about the money: sent, expected, and coming back. */
const RefundFacts: React.FC<{ swap: SwapDisplayModel }> = ({ swap }) => {
  const rows: [string, string | undefined][] = [
    [
      "Amount received",
      swap.depositReceivedAmount && `${swap.depositReceivedAmount} ${swap.assetLabel}`,
    ],
    ["Amount required", swap.depositReceivedAmount && `${swap.depositAmount} ${swap.assetLabel}`],
    ["Estimated refund", swap.refundAmount && `${swap.refundAmount} ${swap.assetLabel}`],
  ];
  const shown = rows.filter(([, value]) => Boolean(value));
  if (shown.length === 0) return null;

  return (
    <div className="or-shop-fees">
      {shown.map(([label, value]) => (
        <Group key={label} justify="space-between" gap="xs">
          <Text size="sm" c="dimmed">
            {label}
          </Text>
          <Text size="sm">{value}</Text>
        </Group>
      ))}
    </div>
  );
};

// Two steps, and only the second submits.
//
// A refund is reachable from exactly one provider state, and the server
// re-reads that state at confirm time — so a 409 here is a normal outcome, the
// state moving under the payer, and not an error screen.
const RefundForm: React.FC<SwapPanelProps> = observer(({ checkout, swap }) => {
  const error = checkout.refundFormError;
  const staged = checkout.refundStagedAddress;

  return (
    <Stack gap="xs" className="or-shop-refund">
      <Text className="or-shop-section-title">Refund this deposit</Text>
      {swap.refundReason ? (
        <Text size="sm" c="dimmed">
          Reason: {swap.refundReason.replace(/_/g, " ")}
        </Text>
      ) : null}
      <Text size="sm">
        Use a {swap.networkLabel} address you control. Do not paste the deposit address.
      </Text>

      {staged ? (
        <>
          <Text size="sm">{checkoutLabels.confirmRefundTo.replace("{address}", staged)}</Text>
          <Group gap="sm">
            <Button
              onClick={checkout.confirmRefund}
              loading={checkout.refundSubmitting}
              disabled={!swap.refundAllowed}
            >
              {checkoutLabels.confirmRefund}
            </Button>
            <Button variant="default" onClick={checkout.cancelRefundReview}>
              {checkoutLabels.tutorialBack}
            </Button>
          </Group>
        </>
      ) : (
        <>
          <TextInput
            value={checkout.refundAddress}
            placeholder={checkoutLabels.refundAddressPlaceholder.replace(
              "{network}",
              swap.networkLabel,
            )}
            onChange={(event) => checkout.setRefundAddress(event.currentTarget.value)}
            error={checkout.refundAddress ? error : undefined}
          />
          <Button
            onClick={checkout.stageRefund}
            loading={checkout.refundSubmitting}
            disabled={Boolean(error)}
          >
            {checkoutLabels.reviewRefundAddress}
          </Button>
        </>
      )}

      {checkout.refundNotice ? (
        <Text size="sm" c="dimmed">
          {checkout.refundNotice}
        </Text>
      ) : null}
    </Stack>
  );
});
