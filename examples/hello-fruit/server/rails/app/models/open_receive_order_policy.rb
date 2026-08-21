# frozen_string_literal: true

module OpenReceiveOrderPolicy
  module_function

  def authorized?(context)
    order_id = context[:resource]&.[](:order_id) || context[:resource]&.[]("order_id")
    order_id.present? && Order.exists?(order_id)
  end
end
