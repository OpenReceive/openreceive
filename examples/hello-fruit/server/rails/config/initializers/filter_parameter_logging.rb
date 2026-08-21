# frozen_string_literal: true

Rails.application.config.filter_parameters += [
  :passw, :email, :secret, :token, :_key, :crypt, :salt, :certificate, :otp, :ssn, :cvv, :cvc,
  :swap_data, :nwc, :NWC_URI, :LSC_URI_PRIMARY, :LSC_URI_BACKUP
]
