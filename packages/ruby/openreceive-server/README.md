# openreceive-server

Storage-free Ruby service and Rack handler. Configure a receive-only NWC client and token
keyring. The host passes order amounts, commits payment hashes before responding, and consumes
at-least-once verified payment events by hash.
