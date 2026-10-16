import { type MedusaContainer, reconcileAndPlaceOrders } from "../../runtime.ts";

// Every minute: finds a payment whose buyer closed the page before it
// settled, and hands every paid session Medusa has not completed to
// Medusa's process-payment workflow. Does nothing until NWC_URI is set.
export default async function openReceiveReconcile(container: MedusaContainer): Promise<void> {
  await reconcileAndPlaceOrders(container);
}

export const config = {
  name: "openreceive-reconcile",
  schedule: "* * * * *",
};
