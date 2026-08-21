# frozen_string_literal: true

# Demo authorization: any existing order may use OpenReceive routes.
# Replace with session/ownership checks in a real app.
module OpenReceiveOrderPolicy
  module_function

  def authorized?(context)
    order_id = context[:resource]&.[](:order_id) || context[:resource]&.[]("order_id")
    order_id.present? && Order.exists?(order_id)
  end
end
