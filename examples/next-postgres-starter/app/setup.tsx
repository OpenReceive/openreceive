/** Shown instead of the shop until NWC_URI is set. */
export function Setup() {
  return (
    <section className="card panel" aria-labelledby="setup-title">
      <p className="eyebrow">One step left</p>
      <h1 id="setup-title">Add Your Wallet Code</h1>
      <p className="lede">
        This shop creates Lightning invoices with a receive-only NWC code from your wallet. Payments
        go straight to that wallet. Add the code and the shop opens.
      </p>
      <ol className="steps">
        <li>
          <span>
            Get a receive-only code from your Lightning wallet.{" "}
            <a href="https://openreceive.org/get_a_nwc_code_to_receive_payments">
              How to get a code
            </a>
          </span>
        </li>
        <li>
          <span>
            On Vercel, open your project&rsquo;s Settings &rarr; Environment Variables and add{" "}
            <code translate="no">NWC_URI</code>. Running locally, put it in{" "}
            <code translate="no">.env.local</code>.
          </span>
        </li>
        <li>
          <span>Redeploy, or restart the dev server, then reload this page.</span>
        </li>
      </ol>
      <p className="note">
        The code stays on the server. It never reaches the browser, and a receive-only code
        can&rsquo;t spend from your wallet.
      </p>
    </section>
  );
}
