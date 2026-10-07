"use client";

import { Checkout } from "@openreceive/react";
import "@openreceive/react/styles.css";

export function OrderCheckout({ reference }: { reference: string }) {
  return <Checkout reference={reference} prefix="/openreceive" />;
}
