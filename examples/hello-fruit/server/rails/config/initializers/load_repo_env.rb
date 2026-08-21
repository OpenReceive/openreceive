# frozen_string_literal: true

repo_env = Rails.root.join("../../../../.env")
Dotenv.overload(repo_env) if defined?(Dotenv) && repo_env.exist?
