import { supabaseAdmin } from "@/integrations/supabase/client.server";

export interface Order {
  id: string;
  product_id: number;
  title: string;
  total: string;
  currency: string;
  status: string;
}

/** A new order for one product, its price copied from the catalog. */
export async function createOrder(productId: number): Promise<Order | null> {
  const { data: product } = await supabaseAdmin
    .from("products")
    .select("id, name, price, currency")
    .eq("id", productId)
    .maybeSingle();
  if (!product) return null;
  const { data, error } = await supabaseAdmin
    .from("orders")
    .insert({
      product_id: product.id,
      title: product.name,
      total: product.price,
      currency: product.currency,
    })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function findOrder(id: string): Promise<Order | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { data, error } = await supabaseAdmin.from("orders").select().eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}
