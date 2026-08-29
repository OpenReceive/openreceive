import { Group, Loader, Text } from "@mantine/core";
import type { CheckoutStatusModel } from "@openreceive/browser/headless";
import type React from "react";

/**
 * Where the payment has got to, as a status line rather than a stepper.
 *
 * Progress here is a STATUS: four wire values for status, six phases, twelve
 * provider states, and the forward path is the minority of all three — there is
 * nowhere on a Cart → Pay → Done bar to put an expired invoice or a refund under
 * review.
 *
 * `title`, `detail` and the countdown are finished payer-facing copy off
 * `createCheckoutStatusModel`; they are printed, never rewritten. Both stacks
 * render this from the same model — Rails from the keystone store's `status`,
 * node-express from the state the packaged checkout reports — so the summary
 * column reads identically beside two different payment panels.
 */
export const StatusCard: React.FC<{ status: CheckoutStatusModel }> = ({ status }) => (
  <div className="or-shop-status" data-phase={status.phase}>
    <Group justify="space-between" align="flex-start" wrap="nowrap">
      <div>
        <Text className="or-shop-status-title">{status.title}</Text>
        <Text className="or-shop-status-detail">{status.detail}</Text>
      </div>
      {status.waiting ? <Loader size="xs" color="orGreen" /> : null}
    </Group>
    {status.countdownLabel ? (
      <Text className="or-shop-status-countdown">
        {status.countdownPrefix} {status.countdownLabel}
      </Text>
    ) : null}
  </div>
);
