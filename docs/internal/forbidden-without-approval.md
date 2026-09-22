# Forbidden Without Approval

These files and behaviors need explicit approval from a maintainer:

- Any real `.env` file or NWC connection string.
- Private openreceive.org app code or deployment inventory.
- Demo host IPs, SSH keys, Cloudflare tokens, certificates, or WireGuard files.
- Changes to `spec/schemas/**` without matching vector updates.
- Changes to settlement detection that treat the preimage alone as final proof.
- Live checkout behavior that runs purely in the frontend.
- Send-payment methods in OpenReceive receive-checkout APIs.
- Provider claims without evidence URLs or verification dates.
