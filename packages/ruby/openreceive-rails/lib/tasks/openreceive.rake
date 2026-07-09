# frozen_string_literal: true

# Provides `bin/rails openreceive:install:migrations` — copies the canonical OpenReceive migrations
# into the host's db/migrate with fresh timestamps (delegating to the install generator's migration
# step, so the migration superclass version is resolved to the host's Rails version). Run
# `bin/rails db:migrate` afterwards. This is the migrations-only slice of
# `bin/rails generate openreceive:install`.
namespace :openreceive do
  namespace :install do
    desc "Copy the OpenReceive migrations into db/migrate with fresh timestamps"
    task migrations: :environment do
      require "rails/generators"
      require "generators/openreceive/install/install_generator"

      Rails::Generators.invoke(
        "openreceive:install",
        ["--skip-initializer", "--skip-route"],
        behavior: :invoke,
        destination_root: ::Rails.root
      )
    end
  end
end
