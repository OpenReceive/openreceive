import { Button, Group, Image, Stack, Text, UnstyledButton } from "@mantine/core";
import {
  type CheckoutPaymentMethod,
  checkoutLabels,
  getNetworkIcon,
  getPaymentMethodIcon,
  getSwapOptionIcon,
  type MethodGridGroupDisplay,
} from "@openreceive/browser/headless";
import { IconCheck } from "@tabler/icons-react";
import { observer } from "mobx-react";
import type React from "react";
import type { ShopCheckout } from "../stores/ShopCheckout.ts";

type MethodGroup = MethodGridGroupDisplay<CheckoutPaymentMethod>;

// The method picker.
//
// The rule this grid exists to keep is that a network question is asked only
// where there IS one: USDT is on three networks, USDC two, SOL and ETH exactly
// one, and asking "which network?" above a single tile teaches the payer that
// the step is ceremony to click past — one screen before USDT, where a wrong
// send is unrecoverable. The store hands the click to `resolveWizardSelection`,
// which cannot represent that mistake; this component only draws what the
// display model already decided.
//
// The icon getters take an OPTIONAL asset resolver and are called here without
// one, so the packaged URLs resolve against `import.meta.url`. Under webpack
// that is a dead `file://` path, which is why this demo's webpack config
// rewrites the expression to the running script's URL and copies the packaged
// icons next to the chunk. Vite resolves it natively. See
// config/webpack/openreceive-import-meta-url-loader.js.
export const MethodGrid: React.FC<{ checkout: ShopCheckout }> = observer(({ checkout }) => {
  const grid = checkout.methodGrid;

  return (
    <Stack gap="sm">
      <Text className="or-shop-section-title">{checkoutLabels.paymentMethod}</Text>

      <div className="or-shop-methods">
        {grid.entries.map((entry) => {
          if (entry.kind === "method") {
            const icon = getPaymentMethodIcon(entry.method.id);
            return (
              <UnstyledButton
                key={entry.method.id}
                className="or-shop-method"
                data-accent={entry.accent}
                data-selected={checkout.pickerKey === `method:${entry.method.id}` || undefined}
                disabled={entry.disabled || grid.gridBusy}
                onClick={() => checkout.selectTile(`method:${entry.method.id}`)}
              >
                {icon ? <Image src={icon} alt="" w={26} h={26} /> : null}
                <Text className="or-shop-method-title">{entry.method.title}</Text>
                <Text className="or-shop-method-detail">{entry.method.detail}</Text>
              </UnstyledButton>
            );
          }

          const group = entry.group as MethodGroup;
          const icon = getSwapOptionIcon(group.displayOption);
          return (
            <UnstyledButton
              key={group.pickerKey}
              className="or-shop-method"
              data-accent={group.accent}
              data-selected={group.selected || undefined}
              disabled={group.disabled || grid.gridBusy}
              aria-controls={group.multiNetwork ? group.panelId : undefined}
              onClick={() => checkout.selectTile(group.pickerKey)}
            >
              {icon ? <Image src={icon} alt="" w={26} h={26} /> : null}
              <Text className="or-shop-method-title">{group.label}</Text>
              <Text className="or-shop-method-detail">
                {/* An unavailable tile says WHY, in the payer's own currency —
                    "Minimum amount $2.71" — quoted from the group's cheapest
                    entry point, so a two-dollar cart is a recoverable cart and
                    not a dead end. */}
                {group.limitMessage ??
                  (group.multiNetwork
                    ? group.options.map((option) => option.network_label).join(" · ")
                    : group.activeOption.network_label)}
              </Text>
            </UnstyledButton>
          );
        })}
      </div>

      {/* The network reveal, drawn only for a group that genuinely has more
          than one — `networkRequired` comes from the display model. */}
      {grid.selectedGroup && grid.networkRequired ? (
        <NetworkChooser checkout={checkout} group={grid.selectedGroup as MethodGroup} />
      ) : null}

      {grid.continueTarget ? (
        <Button
          size="md"
          disabled={grid.continueTarget.disabled}
          loading={grid.continueTarget.starting}
          onClick={checkout.continueWithSelection}
        >
          {grid.continueTarget.label}
        </Button>
      ) : null}
    </Stack>
  );
});

const NetworkChooser: React.FC<{ checkout: ShopCheckout; group: MethodGroup }> = observer(
  ({ checkout, group }) => {
    const selectedAsset = group.selectedOption?.pay_in_asset;

    return (
      // A fieldset rather than a div: these are a set of mutually exclusive
      // choices, and `aria-labelledby` means nothing on an element with no
      // grouping role. shop.css strips the browser's default fieldset chrome.
      <fieldset className="or-shop-networks" id={group.panelId} aria-labelledby={group.headingId}>
        <Text id={group.headingId} className="or-shop-section-title">
          {group.heading}
        </Text>
        <Group gap="xs" mt={6}>
          {group.options.map((option) => {
            const icon = getNetworkIcon(option.network_label);
            const isSelected = selectedAsset === option.pay_in_asset;
            return (
              <UnstyledButton
                key={option.pay_in_asset}
                className="or-shop-network"
                data-selected={isSelected || undefined}
                disabled={option.available === false}
                onClick={() => checkout.chooseNetwork(group.groupKey, option.pay_in_asset)}
              >
                {icon ? <Image src={icon} alt="" w={18} h={18} /> : null}
                <Text size="sm">{option.network_label}</Text>
                {isSelected ? <IconCheck size={14} /> : null}
              </UnstyledButton>
            );
          })}
        </Group>
      </fieldset>
    );
  },
);
