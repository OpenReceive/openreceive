# frozen_string_literal: true

module OpenReceiveOrderPolicy
  module_function

  def authorized?(context)
    reference = context[:resource]&.[](:reference) || context[:resource]&.[]("reference")
    reference.present? && Order.exists?(reference)
  end
end
