"use client";

import { Alert, Group, Loader, MantineProvider, Text } from "@mantine/core";
import type React from "react";
import { useEffect, useState } from "react";
import { loadShopBootstrap } from "../../../../shared/bootstrap.ts";
import { CheckoutStage } from "../../../../shared/client/components/CheckoutStage.tsx";
import { ShopPanel } from "../../../../shared/client/components/ShopPanel.tsx";
import { ShopStore } from "../../../../shared/client/stores/ShopStore.ts";
import { shopTheme } from "../../../../shared/client/theme.ts";

/**
 * The Next.js host.
 *
 * Every component below the `renderCheckout` seam is the shared one, and this
 * stack plugs the same keystone-driven CheckoutStage into it that Rails does —
 * so Rails and Next.js render an identical shop against two completely
 * different servers. node-express is the stack that plugs in something else.
 */
export const ShopApp: React.FC = () => {
  const [shop] = useState(() => new ShopStore({}));
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    loadShopBootstrap()
      .then((bootstrap) => {
        if (cancelled) return;
        if (bootstrap) shop.hydrate(bootstrap);
        setStatus(bootstrap ? "ready" : "failed");
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setStatus("failed");
      });
    return () => {
      cancelled = true;
    };
  }, [shop]);

  return (
    <MantineProvider theme={shopTheme} defaultColorScheme="light">
      <main className="or-page">
        <div className="or-page-inner">
          {status === "loading" ? (
            <Group gap="sm" justify="center" py="xl">
              <Loader color="orGreen" size="sm" />
              <Text c="dimmed" size="sm">
                Loading the shop…
              </Text>
            </Group>
          ) : status === "failed" ? (
            <Alert color="red" title="The shop could not load" variant="light">
              {error || "The bootstrap payload was empty."}
            </Alert>
          ) : (
            <ShopPanel renderCheckout={() => <CheckoutStage shop={shop} />} shop={shop} />
          )}
          <Text className="or-page-note">Next.js app router + SQLite.</Text>
        </div>
      </main>
    </MantineProvider>
  );
};
