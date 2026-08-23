# frozen_string_literal: true

module OpenReceive
  # Base controller for the engine. It inherits DYNAMICALLY from the configured
  # `config.parent_controller` (default "ActionController::Base"; a host sets "ApplicationController")
  # so the engine automatically gets the host's authentication and current_user.
  #
  # Set `parent_controller` in a normal initializer — not `after_initialize`. Production
  # eager-loads this class before after_initialize runs, so a late parent_controller change
  # is ignored and the default ActionController::Base CSRF `:exception` strategy remains.
  #
  # Every action is a thin adapter: it converts the Rails request into the inputs the shared
  # OpenReceive::Server::RequestHandler needs, delegates, and renders the returned
  # [status, headers, body] triple. Controllers and the Rack app therefore cannot drift — the
  # routing/authorize/error semantics live in one place (the server gem's RequestHandler).
  class ApplicationController < OpenReceive.config.parent_controller.constantize
    # The host's forgery protection is inherited, not skipped: whatever
    # `protect_from_forgery` the parent controller configures applies to the
    # engine's routes exactly as it applies to the host's own. The shipped
    # browser client sends `X-CSRF-Token` from `<meta name="csrf-token">`
    # whenever the page renders `csrf_meta_tags`, so a Rails host needs no
    # extra wiring; API-only parents (ActionController::API) have no forgery
    # protection, and the shared handler's JSON-only + same-site gates cover
    # them. A failed check answers with the shared 403 error contract instead
    # of the opaque 500 the StandardError rescue below would produce.

    # Any OpenReceive call is a settlement trigger (mirrors the JS handler's
    # dispatch): after the route matched and before its own work, run one
    # durably gated reconcile pass. Every mounted route participates, including
    # unauthenticated GET /rates. maybe_reconcile! never raises; a failed scan
    # must not fail this request. payments/check consumes this pass result —
    # exactly one gate claim per request. Host-only routes never auto-run this;
    # hosts call OpenReceive.maybe_reconcile! from their own code instead.
    around_action :openreceive_opportunistic_reconcile

    # Any exception the thin adapter layer itself raises (body cap, render)
    # still answers with the shared error contract instead of the host's HTML
    # error page — the same last-resort rescue as Server::RackApp#call. The
    # handler's error_response redacts unexpected exceptions and reports them
    # through Rails.error before the opaque 500 goes on the wire.
    rescue_from StandardError do |error|
      openreceive_respond(openreceive_handler.error_response(error, openreceive_request_id))
    end

    rescue_from ActionController::InvalidAuthenticityToken do
      forbidden = Server::ForbiddenError.new("Invalid or missing CSRF token.")
      openreceive_respond(openreceive_handler.error_response(forbidden, openreceive_request_id))
    end

    private

    def openreceive_opportunistic_reconcile
      @openreceive_reconcile_pass = OpenReceive.maybe_reconcile!
      yield
    end

    # The memoized shared request handler (Service + configured host callbacks).
    def openreceive_handler
      OpenReceive.config.request_handler
    end

    # Always server-generated (matches RackApp and JS): client-supplied
    # X-Request-Id values are unvalidated content and are never reflected.
    def openreceive_request_id
      "req_#{SecureRandom.uuid}"
    end

    # The raw JSON request body string (Server::RequestHandler parses it so the parse/error semantics
    # match the Rack app exactly rather than relying on Rails' params coercion). Capped pre-auth,
    # mirroring RackApp#read_body and the JS readJsonBody: an over-declared Content-Length is
    # rejected before any read, and the read itself stops one byte past the cap so a chunked body
    # can never stream unbounded input into memory.
    def openreceive_raw_body
      max_bytes = Server::RequestHandler::MAX_BODY_BYTES
      raise Server::PayloadTooLargeError if request.get_header("CONTENT_LENGTH").to_i > max_bytes

      body = request.body
      return "" if body.nil?

      raw = body.respond_to?(:read) ? body.read(max_bytes + 1).to_s : body.to_s
      body.rewind if body.respond_to?(:rewind)
      raise Server::PayloadTooLargeError if raw.bytesize > max_bytes

      raw
    end

    # Render a [status, headers, body] triple with a byte-equal JSON body. `render body:` with an
    # explicit content_type avoids Rails appending a charset, keeping the wire body identical to the
    # Rack app; the JSON is generated exactly as RackApp generates it. Every non-Content-Type header
    # from the shared handler is copied onto the Rails response verbatim.
    def openreceive_respond(result)
      status, headers, body = result
      headers.each do |key, value|
        next if key.casecmp("content-type").zero?

        response.set_header(key, value)
      end
      render body: JSON.generate(body), content_type: "application/json", status: status
    end
  end
end
