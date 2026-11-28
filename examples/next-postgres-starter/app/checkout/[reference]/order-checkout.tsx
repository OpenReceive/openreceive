"use client";

import { Checkout } from "@openreceive/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import "@openreceive/react/styles.css";

export function OrderCheckout({ reference, paid }: { reference: string; paid: boolean }) {
  const router = useRouter();
  // Read once, when the page opens. An order that was already paid has nothing
  // left to pay, and its checkout would only fail to start. A payment made on
  // this page keeps its checkout, receipt included, through the refresh below.
  const [paidOnArrival] = useState(paid);
  if (paidOnArrival) {
    return (
      <div className="card thanks">
        <h2>Thank You</h2>
        <p className="lede">
          This order is paid. The bitcoin is already in the shop&rsquo;s wallet.
        </p>
        <Link href="/" className="button secondary">
          Back to the Shop
        </Link>
      </div>
    );
  }
  // `onPaid` has marked the order paid by the time the checkout shows
  // settlement, so a refresh re-renders the order summary from the order row.
  // The checkout keeps its state across the refresh. `theme="system"` matches
  // the page, which follows the system color scheme too.
  return (
    <Checkout
      reference={reference}
      prefix="/openreceive"
      theme="system"
      onSettled={() => router.refresh()}
    />
  );
}
