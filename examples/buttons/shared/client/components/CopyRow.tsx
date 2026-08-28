import { ActionIcon, Code, CopyButton, Group, Text, Tooltip } from "@mantine/core";
import { IconCheck, IconCopy } from "@tabler/icons-react";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";

type CopyRowProps = {
  label: string;
  // THE REAL VALUE, always complete. Never pass a pre-shortened string: this
  // is what a payer's own selection copies, and a hand-truncated one puts an
  // ellipsis in the middle of an invoice that looks copyable and is not.
  value: string;
  // Shorten a long value TO ONE LINE. The shortening is CSS — the full string
  // stays in the DOM, so select-all-and-copy still yields the real value.
  truncate?: boolean;
  // Render the value so a click selects the whole of it — a deposit address or
  // an invoice a payer may want to select by hand rather than press a button.
  selectable?: boolean;
};

// Every value the payer has to REPRODUCE gets one of these: a label, the value,
// and a copy button. A badge or a sentence is not a copy affordance.
export const CopyRow: React.FC<CopyRowProps> = ({ label, value, truncate, selectable }) => (
  <div className="or-shop-copyrow">
    <Text className="or-shop-copyrow-label">{label}</Text>
    <Group gap={6} wrap="nowrap" align="center">
      <Code
        className="or-shop-copyrow-value"
        data-selectable={selectable || undefined}
        data-truncate={truncate || undefined}
      >
        {value}
      </Code>
      <CopyButton value={value} timeout={1600}>
        {({ copied, copy }) => (
          <Tooltip label={copied ? "Copied!" : `Copy ${label.toLowerCase()}`} withArrow>
            <ActionIcon
              variant="subtle"
              color={copied ? "orGreen" : "gray"}
              onClick={copy}
              aria-label={`Copy ${label.toLowerCase()}`}
            >
              {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
            </ActionIcon>
          </Tooltip>
        )}
      </CopyButton>
    </Group>
  </div>
);

// The copy button beside the bolt11, which goes through the controller so the
// package's own copy path (and its audit event) runs rather than a second one.
export const ControllerCopyButton: React.FC<{
  onCopy: () => Promise<void>;
  label: string;
  copiedLabel: string;
  children: (args: { label: string; onClick: () => void }) => React.ReactNode;
}> = ({ onCopy, label, copiedLabel, children }) => {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const handle = useCallback(() => {
    void onCopy().then(() => {
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1600);
    });
  }, [onCopy]);

  return <>{children({ label: copied ? copiedLabel : label, onClick: handle })}</>;
};
