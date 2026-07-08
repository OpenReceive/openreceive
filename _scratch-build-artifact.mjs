import { readFileSync, writeFileSync } from "node:fs";

const base = "/private/tmp/claude-501/-Users-perls-workspace-openrecieve/d2e897fb-078f-49ec-b38a-fe423d7d1c4b/scratchpad";
const { css, beforeHtml, afterHtml } = JSON.parse(readFileSync(`${base}/artifact-parts.json`, "utf8"));

// Force both embedded checkouts to dark to match the product screenshots.
const toDark = (h) =>
  h.replace(/data-theme="light"/g, 'data-theme="dark"').replace(/data-openreceive-theme="light"/g, 'data-openreceive-theme="dark"');

const page = `<style>
:root{
  --ground:#eceff4; --surface:#ffffff; --surface-2:#f6f8fb;
  --text:#1b2333; --muted:#66708a; --border:#d9dfe9;
  --accent:#2563eb; --added:#1a7f45; --removed:#b26a06;
  --frame:#0f1118; --frame-edge:#2a303d;
}
@media (prefers-color-scheme: dark){
  :root{
    --ground:#0d0f15; --surface:#161922; --surface-2:#1b1f29;
    --text:#eef1f6; --muted:#98a1b3; --border:#2a3140;
    --accent:#6aa2ff; --added:#4cc98a; --removed:#e0a24a;
    --frame:#0f1118; --frame-edge:#2a303d;
  }
}
:root[data-theme="light"]{
  --ground:#eceff4; --surface:#ffffff; --surface-2:#f6f8fb;
  --text:#1b2333; --muted:#66708a; --border:#d9dfe9;
  --accent:#2563eb; --added:#1a7f45; --removed:#b26a06; --frame:#0f1118; --frame-edge:#2a303d;
}
:root[data-theme="dark"]{
  --ground:#0d0f15; --surface:#161922; --surface-2:#1b1f29;
  --text:#eef1f6; --muted:#98a1b3; --border:#2a3140;
  --accent:#6aa2ff; --added:#4cc98a; --removed:#e0a24a; --frame:#0f1118; --frame-edge:#2a303d;
}
*{box-sizing:border-box}
.review{
  background:var(--ground); color:var(--text);
  font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  min-height:100%; padding:40px 20px 72px;
}
.wrap{max-width:1060px; margin:0 auto}
.eyebrow{
  font:600 12px/1 ui-monospace,SFMono-Regular,Menlo,monospace;
  letter-spacing:.14em; text-transform:uppercase; color:var(--accent); margin:0 0 14px;
}
h1{font-size:clamp(24px,3.4vw,34px); line-height:1.12; margin:0 0 12px; letter-spacing:-.015em; text-wrap:balance; font-weight:700}
.lede{color:var(--muted); max-width:62ch; margin:0 0 34px; font-size:16px}
.grid{display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:22px}
@media (max-width:820px){.grid{grid-template-columns:1fr}}
.card{background:var(--surface); border:1px solid var(--border); border-radius:14px; overflow:hidden; display:flex; flex-direction:column}
.card-head{display:flex; align-items:center; gap:10px; padding:14px 16px; border-bottom:1px solid var(--border)}
.dot{width:9px;height:9px;border-radius:999px;flex:0 0 auto}
.dot.before{background:var(--removed)}
.dot.after{background:var(--added)}
.card-head strong{font-size:14px; font-weight:650}
.card-head .tag{margin-left:auto; font:600 11px/1 ui-monospace,Menlo,monospace; letter-spacing:.06em; text-transform:uppercase; color:var(--muted)}
.stage{background:linear-gradient(180deg,#12141c,#0d0f15); padding:22px; display:flex; justify-content:center}
.stage .frame{width:100%; max-width:360px}
.notes{padding:16px 18px; display:grid; gap:9px; margin:0}
.notes li{list-style:none; display:flex; gap:9px; align-items:flex-start; color:var(--muted); font-size:13.5px}
.notes li::before{content:""; width:6px;height:6px;border-radius:999px;background:var(--accent);margin-top:7px;flex:0 0 auto}
.changed{margin-top:40px; background:var(--surface); border:1px solid var(--border); border-radius:14px; padding:8px 4px}
.changed h2{font-size:13px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); margin:14px 18px 4px; font-weight:650}
.changed dl{margin:0; display:grid; grid-template-columns:minmax(0,1fr); gap:1px}
.row{display:grid; grid-template-columns:minmax(0,1.1fr) minmax(0,2fr); gap:16px; padding:14px 18px; align-items:baseline}
@media (max-width:640px){.row{grid-template-columns:1fr; gap:4px}}
.row + .row{border-top:1px solid var(--border)}
.row code{font:600 12.5px/1.4 ui-monospace,Menlo,monospace; color:var(--text); word-break:break-word}
.row span{color:var(--muted); font-size:13.5px}
.foot{margin-top:26px; color:var(--muted); font-size:12.5px}
/* --- real OpenReceive checkout styles (verbatim), scoped by their own [data-openreceive-*] selectors --- */
${css}
</style>
<div class="review">
  <div class="wrap">
    <p class="eyebrow">OpenReceive · Checkout</p>
    <h1>Paying with crypto now replaces the Lightning invoice</h1>
    <p class="lede">When a payer chooses a swap coin, the crypto payment panel takes over the whole checkout instead of sitting beneath a second Lightning QR. The panel borrows the Lightning section's status card, and its deposit QR is sized down so one clear "pay this" surface is on screen at a time.</p>

    <div class="grid">
      <section class="card">
        <div class="card-head"><span class="dot before"></span><strong>Choosing how to pay</strong><span class="tag">Lightning shown</span></div>
        <div class="stage"><div class="frame">${toDark(beforeHtml)}</div></div>
        <ul class="notes">
          <li>Lightning QR, amount, status and "Copy invoice" are visible while the payer is still deciding.</li>
          <li>Each configured coin (USDT, SOL…) is a one-tap choice under the standard methods.</li>
        </ul>
      </section>

      <section class="card">
        <div class="card-head"><span class="dot after"></span><strong>Paying with USDT · Solana</strong><span class="tag">Lightning hidden</span></div>
        <div class="stage"><div class="frame">${toDark(afterHtml)}</div></div>
        <ul class="notes">
          <li>The Lightning section is gone — the crypto panel fully replaces it.</li>
          <li>Leads with the same status card ("Waiting for your payment" + spinner) as Lightning.</li>
          <li>Deposit QR capped at 200px instead of stretching the full panel width.</li>
          <li>"Pay with Lightning instead" steps back and brings the Lightning section back.</li>
        </ul>
      </section>
    </div>

    <div class="changed">
      <h2>What changed</h2>
      <dl>
        <div class="row"><code>react · Checkout / PaymentWizard</code><span>New <code>onSwapFocusChange</code> lets the wizard tell the checkout when a swap is being paid; the checkout hides its Lightning QR, status, countdown, summary and copy action.</span></div>
        <div class="row"><code>react · renderSwapDepositPanel</code><span>The deposit panel reuses the Lightning <code>WaitingState</code> status card (spinner + title + detail) instead of the plain heading row.</span></div>
        <div class="row"><code>browser · styles.css · .or-swap-qr</code><span>Removed the <code>width:100%</code> override that made the QR fill the panel; now capped at <code>min(200px, 100%)</code>.</span></div>
      </dl>
    </div>

    <p class="foot">Rendered from the real component markup and stylesheet. QR codes are live-generated for the sample invoice and deposit address.</p>
  </div>
</div>`;

writeFileSync(`${base}/checkout-swap-redesign.html`, page);
console.log("wrote", `${base}/checkout-swap-redesign.html`, page.length, "bytes");
