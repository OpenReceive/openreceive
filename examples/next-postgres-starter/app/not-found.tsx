import Link from "next/link";

export default function NotFound() {
  return (
    <section className="card panel" aria-labelledby="missing-title">
      <p className="eyebrow">404</p>
      <h1 id="missing-title">Nothing Here</h1>
      <p className="lede">
        This page doesn&rsquo;t exist, or the order belongs to another browser. An order opens only
        in the browser that placed it.
      </p>
      <div className="actions">
        <Link href="/" className="button secondary">
          Back to the Shop
        </Link>
      </div>
    </section>
  );
}
