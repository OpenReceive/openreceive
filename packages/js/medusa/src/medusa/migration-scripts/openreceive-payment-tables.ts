import { createPaymentTables, type MedusaContainer } from "../../runtime.ts";

// `npx medusa db:migrate` runs this once: OpenReceive's two tables in
// Medusa's database (openreceive_payments and openreceive_meta).
export default async function openReceivePaymentTables({
  container,
}: {
  readonly container: MedusaContainer;
}): Promise<void> {
  await createPaymentTables(container);
}
