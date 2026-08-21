# frozen_string_literal: true

class ApplicationController < ActionController::Base
  # Match Node demos: JSON checkout clients are not session forms.
  protect_from_forgery with: :null_session
end
