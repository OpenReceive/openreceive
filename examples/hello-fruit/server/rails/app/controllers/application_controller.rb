# frozen_string_literal: true

class ApplicationController < ActionController::Base
  # Rails' default forgery protection applies to the OpenReceive engine's
  # routes too: the layout renders csrf_meta_tags and both this app's JSON
  # helpers and the OpenReceive checkout client send X-CSRF-Token from it.
end
