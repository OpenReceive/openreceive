import { createServerFn } from "@tanstack/react-start";

export const listProducts = createServerFn().handler(async () => {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("products")
    .select("id, name, price, currency")
    .order("id");
  if (error) throw new Error(error.message);
  return data;
});

export const getOrder = createServerFn()
  .validator((id: string) => id)
  .handler(async ({ data: id }) => {
    const { findOrder } = await import("@/lib/shop.server");
    return (await findOrder(id)) ?? null;
  });
