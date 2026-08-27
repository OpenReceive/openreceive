# frozen_string_literal: true

module ButtonShop
  # Cache-Control for files ActionDispatch::Static serves from public/.
  #
  # Digested Shakapacker files (`/packs/js/buttons-<contenthash>.js`) and
  # digested Propshaft files (`/assets/openreceive-signal-red-button-<digest>.webp`)
  # may be cached forever. The HTML that names those digests must not, or a
  # rebuild leaves browsers on a dead bundle. Unhashed OpenReceive runtime
  # images (copied next to the chunk at /packs/js/assets/…) revalidate.
  class PublicCacheHeaders
    YEAR = 31_536_000
    IMMUTABLE = "public, max-age=#{YEAR}, immutable"
    REVALIDATE = "public, max-age=0, must-revalidate"
    NO_STORE = "no-store"

    # Content-hash suffix: buttons-a1b2c3d4.js (Propshaft-style 8 hex) or
    # buttons-3b4c5d6e7f8091a2b3c4.js (webpack contenthash), incl. .js.map.
    FINGERPRINTED =
      %r{\A/(?:assets|packs(?:-test)?)/(?:.+/)*[^/]+-[0-9a-f]{8,64}(?:\.[A-Za-z0-9]+)*\.[A-Za-z0-9]+\z}

    def initialize(app)
      @app = app
    end

    def call(env)
      status, headers, body = @app.call(env)
      directive = self.class.cache_control_for(env["PATH_INFO"].to_s)
      return [status, headers, body] if directive.nil? || status != 200

      headers = headers.dup
      headers["cache-control"] = directive
      [status, headers, body]
    end

    def self.cache_control_for(path)
      return NO_STORE if html_shell?(path)
      return IMMUTABLE if path.match?(FINGERPRINTED)
      return REVALIDATE if public_static?(path)

      nil
    end

    def self.html_shell?(path)
      path == "/" || path == "/index.html" || path.end_with?(".html")
    end
    private_class_method :html_shell?

    def self.public_static?(path)
      path.start_with?("/assets/") ||
        path.start_with?("/packs/") ||
        path.start_with?("/packs-test/") ||
        path == "/robots.txt" ||
        path.match?(%r{\A/icon\.(?:png|svg)\z})
    end
    private_class_method :public_static?
  end
end
