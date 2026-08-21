# Run using bin/ci

CI.run do
  step "Setup", "bin/setup --skip-server"

  step "Tests", "bin/rails test"

  step "Security: Gem audit", "bin/bundler-audit"
  # No importmap audit: the browser client is the Shakapacker bundle
  # (app/javascript/), so JS dependencies are audited by the workspace npm
  # tooling instead.


  # Optional: set a green GitHub commit status to unblock PR merge.
  # Requires the `gh` CLI and `gh extension install basecamp/gh-signoff`.
  # if success?
  #   step "Signoff: All systems go. Ready for merge and deploy.", "gh signoff"
  # else
  #   failure "Signoff: CI failed. Do not merge or deploy.", "Fix the issues and try again."
  # end
end
