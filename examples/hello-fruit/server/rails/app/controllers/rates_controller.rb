# frozen_string_literal: true

# Display rates for the client's currency picker. Delegates to the OpenReceive
# service's list_rates — the same call the mounted engine serves at
# GET /openreceive/rates — instead of re-implementing a price feed here
# (matches node-express, which renders `service.listRates()` at /rates).
class RatesController < ApplicationController
  def index
    currencies = params[:currencies].to_s.split(",").map(&:strip).reject(&:empty?)
    input = currencies.empty? ? {} : { "currencies" => currencies }
    render json: { rates: OpenReceive.config.service.list_rates(input) }
  rescue StandardError => e
    render json: { message: e.message }, status: :service_unavailable
  end
end
