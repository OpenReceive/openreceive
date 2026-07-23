# frozen_string_literal: true

module OpenReceive
  # Base controller for the engine. It inherits DYNAMICALLY from the configured
  # `config.parent_controller` (default "ActionController::Base"; a host sets "ApplicationController")
  # so the engine automatically gets the host's CSRF protection, authentication, and current_user.
  #
  # Every action is a thin adapter: it converts the Rails request into the inputs the shared
  # OpenReceive::Server::RequestHandler needs, delegates, and renders the returned
  # [status, headers, body] triple. Controllers and the Rack app therefore cannot drift — the
  # routing/authorize/error semantics live in one place (the server gem's RequestHandler).
  class ApplicationController < OpenReceive.config.parent_controller.constantize
    private

    # The memoized shared request handler (Service + Tokens + configured hooks).
    def openreceive_handler
      OpenReceive.config.request_handler
    end

    # Raw capability token (Bearer, then X-OpenReceive-Order-Token, then the path-scoped
    # `openreceive_order_token` cookie) via the one shared extractor. The Cookie header is passed as
    # the raw request header so the cookie parsing matches the Rack app exactly.
    def openreceive_token
      OpenReceive::Server::RequestHandler.extract_token(
        request.get_header("HTTP_AUTHORIZATION"),
        request.get_header("HTTP_X_OPENRECEIVE_ORDER_TOKEN"),
        request.get_header("HTTP_COOKIE")
      )
    end

    # Echo the incoming X-Request-Id (matches RackApp; nil when absent).
    def openreceive_request_id
      request.get_header("HTTP_X_REQUEST_ID")
    end

    # The raw JSON request body string (Server::RequestHandler parses it so the parse/error semantics
    # match the Rack app exactly rather than relying on Rails' params coercion).
    def openreceive_raw_body
      body = request.body
      return "" if body.nil?

      raw = body.respond_to?(:read) ? body.read : body.to_s
      body.rewind if body.respond_to?(:rewind)
      raw
    end

    # Render a [status, headers, body] triple with a byte-equal JSON body. `render body:` with an
    # explicit content_type avoids Rails appending a charset, keeping the wire body identical to the
    # Rack app; the JSON is generated exactly as RackApp generates it. Every non-Content-Type header
    # from the shared handler is copied onto the Rails response verbatim — including the create route's
    # capability `Set-Cookie` header, so the browser stores it just as it
    # would from the Rack app.
    def openreceive_respond(result)
      status, headers, body = result
      headers.each do |key, value|
        next if key == "Content-Type"

        response.set_header(key, value)
      end
      render body: JSON.generate(body), content_type: "application/json", status: status
    end
  end
end
