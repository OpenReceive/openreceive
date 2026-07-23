# openreceive-rails

Mountable Rails engine for storage-free OpenReceive routes. The install generator writes an
initializer and mounts the engine; it creates no OpenReceive migration or table. Configure
`authorize`, `resolve_checkout_amount`, and `on_checkout_created` against the host Order model.
