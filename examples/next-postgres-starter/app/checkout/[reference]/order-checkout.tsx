"use client";

import { Checkout } from "@openreceive/react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import "@openreceive/react/styles.css";

export function OrderCheckout({ reference, paid }: { reference: string; paid: boolean }) {
  const router = useRouter();
  // Read once, when the page opens. An order that was already paid has nothing
  // left to pay, and its checkout would only fail to start. A payment made on
  // this page keeps its checkout, receipt included, through the refresh below.
  const [paidOnArrival] = useState(paid);
  if (paidOnArrival) return null;
  // `onPaid` has marked the order paid by the time the checkout shows
  // settlement, so a refresh re-renders the page's status line from the order
  // row. The checkout keeps its state across the refresh.
  return (
    <Checkout reference={reference} prefix="/openreceive" onSettled={() => router.refresh()} />
  );
}
