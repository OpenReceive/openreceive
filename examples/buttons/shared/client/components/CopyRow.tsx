import { ActionIcon, Code, CopyButton, Group, Text, Tooltip } from "@mantine/core";
import { IconCheck, IconCopy } from "@tabler/icons-react";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";

type CopyRowProps = {
  label: string;
  value: string;
  // The untruncated string a copy button writes, when the displayed value is
  // shortened. Always copy this, never the display value.
  copyValue?: string;
  // Render the value in a selectable field rather than a code block — a deposit
  // address a payer may want to drag-select as well as copy.
  selectable?: boolean;
};

// Every value the payer has to REPRODUCE gets one of these: a label, the value,
// and a copy button. A badge or a sentence is not a copy affordance.
export const CopyRow: React.FC<CopyRowProps> = ({ label, value, copyValue, selectable }) => (
  <div className="or-shop-copyrow">
    <Text className="or-shop-copyrow-label">{label}</Text>
    <Group gap={6} wrap="nowrap" align="center">
      <Code
        className={selectable ? "or-shop-copyrow-value is-selectable" : "or-shop-copyrow-value"}
      >
        {value}
      </Code>
      <CopyButton value={copyValue ?? value} timeout={1600}>
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
