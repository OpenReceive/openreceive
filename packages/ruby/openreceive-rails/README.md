# openreceive-rails

Mountable Rails engine for storage-free OpenReceive routes. The install generator writes an
initializer and mounts the engine; it creates no OpenReceive migration or table. Configure
`authorize`, `resolve_checkout`, and `on_checkout_created` against the host Order model.
The receive-only `nwc` value loads from the root `openreceive.yml`; `config.nwc` remains an
optional explicit override.
