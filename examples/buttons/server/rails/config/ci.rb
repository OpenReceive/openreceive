# Run using bin/ci

CI.run do
  step "Setup", "bin/setup --skip-server"

  step "Tests", "bin/rails test"

  # The committed openreceive migration + db/schema.rb are snapshots of the
  # library-owned schema; re-render the generator template and diff.
  step "Drift: OpenReceive migration snapshot", "bundle exec ruby script/check-migration-drift.rb"

  # Every row in shared/shop-catalog.json names an artwork file that exists in
  # examples/buttons/images.
  step "Drift: catalog vs artwork", "node script/check-catalog-artwork.mjs"

  # The shared boundary: this stack may import shared/shop-types.ts and
  # shared/client/**, and must never reach into shared/server-node/**.
  step "Boundary: no server-node imports", "bundle exec ruby script/check-shared-boundary.rb"

  step "Security: Gem audit", "bin/bundler-audit"
  # No importmap audit: the browser client is the Shakapacker bundle
  # (app/javascript/ plus examples/buttons/shared/), so JS dependencies are
  # audited by the workspace npm tooling instead.
end
