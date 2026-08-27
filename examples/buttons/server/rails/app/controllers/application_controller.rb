# frozen_string_literal: true

class ApplicationController < ActionController::Base
  # Rails' default forgery protection applies to the OpenReceive engine's routes
  # too — the engine's parent controller is this class. The layout renders
  # csrf_meta_tags, and shared/client/http.ts sends X-CSRF-Token from it on
  # every body-bearing request, the engine's included.
  #
  # ShopIdentity is deliberately NOT included here. It is included by
  # ShopController alone: minting a ShopUser row for every asset, docs or
  # health-check request is a junk-row generator.
end
