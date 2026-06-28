# frozen_string_literal: true

post "/openreceive/v1/invoices", to: "openreceive#create"
get "/openreceive/v1/invoices/:invoice_id", to: "openreceive#show"
post "/openreceive/v1/invoices/:invoice_id/status", to: "openreceive#status"
