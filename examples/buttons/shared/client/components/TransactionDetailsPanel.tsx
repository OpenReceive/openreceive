import { Anchor, Collapse, Group, Stack, Text, UnstyledButton } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { checkoutLabels, type TransactionDetailRow } from "@openreceive/browser/headless";
import { IconChevronRight } from "@tabler/icons-react";
import type React from "react";
import { CopyRow } from "./CopyRow.tsx";

// The whole transaction record, collapsed behind a caret, on the live checkout
// AND on the receipt.
//
// This is not developer debug output. A Bitcoin payment leaves the payer holding
// a payment hash and, on a swap, a deposit txid, and those are the only evidence
// they have that they paid. The rows are public checkout state by construction —
// the builder never touches an NWC or LSC secret.
export const TransactionDetailsPanel: React.FC<{ rows: readonly TransactionDetailRow[] }> = ({
  rows,
}) => {
  const [opened, { toggle }] = useDisclosure(false);

  if (!rows.length) return null;

  return (
    <div className="or-shop-details">
      <UnstyledButton className="or-shop-details-toggle" onClick={toggle} aria-expanded={opened}>
        <Group gap={6} wrap="nowrap">
          <IconChevronRight
            size={16}
            className="or-shop-details-chevron"
            data-open={opened || undefined}
          />
          <Text size="sm" fw={600}>
            {checkoutLabels.transactionDetails}
          </Text>
        </Group>
      </UnstyledButton>

      <Collapse expanded={opened}>
        <Stack gap={8} mt="xs">
          {rows.map((row) => (
            <div key={`${row.label}-${row.value}`}>
              <CopyRow label={row.label} value={row.value} copyValue={row.copyValue ?? row.value} />
              {row.href ? (
                <Anchor
                  href={row.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  size="xs"
                  className="or-shop-details-link"
                >
                  {row.hrefLabel ?? "View"}
                </Anchor>
              ) : null}
            </div>
          ))}
        </Stack>
      </Collapse>
    </div>
  );
};
