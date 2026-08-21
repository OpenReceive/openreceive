# frozen_string_literal: true

# Load the monorepo-root .env (NWC_URI, LSC_*, LOG_LEVEL) for local `bin/dev`.
# Docker / production should inject secrets via the environment instead.
repo_env = Rails.root.join("../../.env")
Dotenv.overload(repo_env) if defined?(Dotenv) && repo_env.exist?
