# frozen_string_literal: true

module OpenReceive
  module Server
    # Server-layer errors. Every error carries
    # #status and #code so the Rack layer can map to an error.schema.json body directly.

    # Generic service error carrying an explicit HTTP status + canonical code,
    # the Ruby analogue of the JS ServiceError. Used where the JS
    # service raises serviceError(status, code, message) — e.g. the swap flows
    # — so both engines put the same status/code/message on the wire.
    class ServiceError < StandardError
      attr_reader :status, :code, :retryable, :details

      def initialize(status, code, message, retryable: nil, details: nil)
        super(message)
        @status = status
        @code = code
        @retryable = retryable
        @details = details
      end
    end

    # 400 — the request body/params were malformed or violated a contract rule.
    class ValidationError < StandardError
      attr_reader :status, :code

      def initialize(message = "Invalid request.")
        super(message)
        @status = 400
        @code = "INVALID_REQUEST"
      end
    end

    # 403 — the host application did not authorize this request. FORBIDDEN,
    # not UNAUTHORIZED: that name belongs to the NIP-47 wallet layer.
    class ForbiddenError < StandardError
      attr_reader :status, :code

      def initialize(message = "Forbidden.")
        super(message)
        @status = 403
        @code = "FORBIDDEN"
      end
    end

    # 404 — the order or checkout was not found.
    class NotFoundError < StandardError
      attr_reader :status, :code

      def initialize(message = "Not found.")
        super(message)
        @status = 404
        @code = "NOT_FOUND"
      end
    end

    class ConflictError < StandardError
      attr_reader :status, :code

      def initialize(message = "Conflict.")
        super(message)
        @status = 409
        @code = "CONFLICT"
      end
    end

    # 405 — a known OpenReceive path called with the wrong HTTP method.
    # Mirrors the JS router exactly: INVALID_REQUEST, no Allow header.
    class MethodNotAllowedError < StandardError
      attr_reader :status, :code

      def initialize(message = "This OpenReceive route does not support that HTTP method.")
        super(message)
        @status = 405
        @code = "INVALID_REQUEST"
      end
    end

    # 500 INTERNAL raised deliberately (for example: the host resolved an
    # order without an amount). Unlike an unexpected exception, the message is
    # payer-safe by construction and stays on the wire — mirroring the JS
    # handler's HttpError(500, "INTERNAL", ...).
    class InternalHostError < StandardError
      attr_reader :status, :code

      def initialize(message = "Internal server error.")
        super(message)
        @status = 500
        @code = "INTERNAL"
      end
    end

    # 503 — infrastructure failed to persist the payment attempt (database
    # down, host hook bug). Mirrors the JS handler's commit(): a retryable
    # INTERNAL, never a payer-blaming conflict; the invoice is still withheld.
    class HostPersistenceError < StandardError
      attr_reader :status, :code, :retryable

      def initialize(message = "The host could not persist this payment attempt; " \
                               "payer instructions were withheld. Please retry.")
        super(message)
        @status = 503
        @code = "INTERNAL"
        @retryable = true
      end
    end

    # 413 — contract bodies are tiny; anything larger is rejected before any
    # host callback runs (mirrors the JS handler's pre-auth body cap).
    class PayloadTooLargeError < StandardError
      attr_reader :status, :code

      def initialize(message = "Request body is too large.")
        super(message)
        @status = 413
        @code = "INVALID_REQUEST"
      end
    end

    # 415 — the body-bearing routes accept `application/json` only. This is the
    # CSRF-equivalent on cookie-authenticated mounts: a cross-site HTML form
    # cannot set a JSON content type, and a cross-origin fetch that does is
    # non-simple (CORS-preflighted, which the library never grants), so a
    # forgery can never reach `authorize` with the victim's session. Rejected
    # before authorize, like the body cap. Mirrors the JS handler.
    class UnsupportedMediaTypeError < StandardError
      attr_reader :status, :code

      def initialize(message = "Request content type must be application/json.")
        super(message)
        @status = 415
        @code = "INVALID_REQUEST"
      end
    end

    # 429 — the payer exceeded the configured invoice-creation budget. Mirrors
    # the JS handler: RATE_LIMITED with retryable: true so clients back off
    # and retry instead of treating it as a permanent failure, plus a
    # `Retry-After` hint (seconds) emitted as a response header.
    class RateLimitedError < StandardError
      attr_reader :status, :code, :retryable, :retry_after_seconds

      def initialize(message = "Too many requests.")
        super(message)
        @status = 429
        @code = "RATE_LIMITED"
        @retryable = true
        @retry_after_seconds = 60
      end
    end

    # 501 — the host has not configured the capability this route needs
    # (for example GET /rates without a price provider).
    class NotImplementedHttpError < StandardError
      attr_reader :status, :code

      def initialize(message = "Not implemented.")
        super(message)
        @status = 501
        @code = "NOT_IMPLEMENTED"
      end
    end

    # Wallet/relay failure normalized per the shared error-normalization
    # vectors. Carries the canonical code and retryable flag so browsers can
    # distinguish "retry" from "bug" against Rails exactly as against Node.
    class WalletFailureError < StandardError
      attr_reader :status, :code, :retryable, :details

      def initialize(normalized)
        super(normalized.fetch("message"))
        @code = normalized.fetch("code")
        @retryable = normalized.fetch("retryable", false)
        @details = normalized["details"]
        @status = @retryable ? 503 : 502
      end
    end

    # 502 — the wallet responded but violated the receive-checkout contract
    # (for example minting an invoice that ignores the requested expiry).
    class WalletContractError < StandardError
      attr_reader :status, :code

      def initialize(message = "Wallet violated the receive-checkout contract.")
        super(message)
        @status = 502
        @code = "UNSUPPORTED_METHOD"
      end
    end

    # Boot-time refusal: the connection offered an info method but preflight
    # could not clear it — the read failed, the wallet cannot receive, or it
    # speaks no encryption mode we support. Booting blind would defer the
    # failure to the first customer checkout, so preflight fails closed
    # (mirrors the JS WALLET_PREFLIGHT_FAILED config error).
    class WalletPreflightError < StandardError
      def initialize(reason)
        super(
          "OpenReceive wallet preflight failed: #{reason} Use a receive-only " \
          "NWC connection advertising make_invoice and list_transactions."
        )
      end
    end

    # Boot-time refusal: the configured NWC connection advertises spend methods.
    # OpenReceive is receive-only; a spend-capable code in a receive deployment
    # is a live theft risk, so preflight fails closed instead of booting.
    class SpendCapableWalletError < StandardError
      def initialize(methods)
        super(
          "The configured NWC connection advertises spend methods " \
          "(#{Array(methods).join(', ')}). OpenReceive is receive-only; use a " \
          "receive-only NWC code, or override explicitly with " \
          "config.allow_spend_capable_wallet = true or " \
          "OPENRECEIVE_ALLOW_SPEND_CAPABLE_NWC=1."
        )
      end
    end
  end
end
