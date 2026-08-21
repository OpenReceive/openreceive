# frozen_string_literal: true

module ApplicationCable
  class Connection < ActionCable::Connection::Base
    # Guest checkout: connections carry no identity. Channels authorize
    # individually (OrderChannel requires a valid order id).
  end
end
