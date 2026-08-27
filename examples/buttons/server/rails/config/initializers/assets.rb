# frozen_string_literal: true

# JS and CSS ship through Shakapacker's manifest in public/packs. Propshaft
# serves everything left under the asset load path.
Rails.application.config.assets.version = "1.0"

# THE ARTWORK IS SERVED FROM ONE DIRECTORY.
#
# examples/buttons/images holds the only copy of the six product webp files and
# the two hero crops. Every stack reads that one directory; nobody copies the
# files into an app.
#
# Adding it to the asset load path is what makes
# `asset_path("openreceive-signal-red-button.webp")` return a DIGESTED url —
# which is in turn why the catalog has to ship from the server in the bootstrap
# payload: the browser could not derive that url, and must not be allowed to
# supply it.
#
# There is no ActiveStorage here and there should not be. These are six static
# files that ship in the repo; shop_products stores FILENAMES, not bytes and not
# attachments. ActiveStorage would mean a service config, a blobs table and a
# variant pipeline to serve a file Propshaft already serves with a digest and a
# far-future cache header.
Rails.application.config.assets.paths << Rails.root.join("../../images").expand_path

Rails.application.config.assets.excluded_paths << Rails.root.join("app/assets/stylesheets")
