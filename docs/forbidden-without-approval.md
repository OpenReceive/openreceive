# Forbidden Without Approval

These files and behaviors require explicit maintainer approval in v0.1:

- Any real `.env` file or NWC connection string.
- Private openreceive.org app code or deployment inventory.
- Demo host IPs, SSH keys, Cloudflare tokens, certificates, or WireGuard files.
- New SDKs or framework adapters before the v0.1 contracts and Express path
  are green.
- Changes to `spec/schemas/**` without matching vector updates.
- Changes to settlement detection that treat preimage alone as final proof.
- Pure frontend live checkout behavior.
- Send-payment methods in OpenReceive receive-checkout APIs.
- Provider claims without evidence URLs or verification dates.
