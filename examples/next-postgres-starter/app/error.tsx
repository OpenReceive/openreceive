"use client";

import Link from "next/link";

export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <section className="card panel" aria-labelledby="error-title">
      <h1 id="error-title">Something Went Wrong</h1>
      <p className="lede">
        The shop couldn&rsquo;t load this page. Try again in a moment. If you run this shop, check
        the function logs and that the database is connected.
      </p>
      <div className="actions">
        <button type="button" className="button secondary" onClick={reset}>
          Try Again
        </button>
        <Link href="/" className="button secondary">
          Back to the Shop
        </Link>
      </div>
    </section>
  );
}
