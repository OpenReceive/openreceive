# frozen_string_literal: true

module OpenReceive
  module Server
    # Server-layer errors. Every error carries
    # #status and #code so the Rack layer can map to an error.schema.json body directly.

    # 400 — the request body/params were malformed or violated a contract rule.
    class ValidationError < StandardError
      attr_reader :status, :code

      def initialize(message = "Invalid request.")
        super(message)
        @status = 400
        @code = "INVALID_REQUEST"
      end
    end

    # 403 — the host application did not authorize this request.
    class UnauthorizedError < StandardError
      attr_reader :status, :code

      def initialize(message = "Unauthorized.")
        super(message)
        @status = 403
        @code = "UNAUTHORIZED"
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
  end
end
