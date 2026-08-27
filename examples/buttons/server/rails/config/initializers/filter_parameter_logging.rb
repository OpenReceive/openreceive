# frozen_string_literal: true

# `shop_user_id` is the ownership token for every order a browser ever placed.
# It is filtered here, and it must not be written into any manual logging
# either — in particular, never next to the client IP.
Rails.application.config.filter_parameters += [
  :passw, :email, :secret, :token, :_key, :crypt, :salt, :certificate, :otp, :ssn, :cvv, :cvc,
  :swap_data, :nwc, :shop_user_id, :NWC_URI, :LSC_URI_PRIMARY, :LSC_URI_BACKUP
]
