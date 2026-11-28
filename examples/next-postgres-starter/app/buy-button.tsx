"use client";

import { useFormStatus } from "react-dom";

/** Keeps its label while the order is created, with a spinner beside it. */
export function BuyButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="button"
      aria-disabled={pending}
      onClick={(event) => {
        if (pending) event.preventDefault();
      }}
    >
      {pending ? <span className="spinner" aria-hidden="true" /> : null}
      {label}
      <span className="visually-hidden" aria-live="polite">
        {pending ? "Opening checkout…" : ""}
      </span>
    </button>
  );
}
