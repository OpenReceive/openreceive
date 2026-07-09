# frozen_string_literal: true

require "digest"
require "securerandom"

module OpenReceive
  module Server
    # Per-order capability tokens (the Ruby port of the Node `tokens.ts`).
    #
    # On the first checkout for an order the route mints a high-entropy URL-safe token and
    # returns it ONCE as `order_access_token`. Only its hash is stored. Tier-2 reads present
    # the raw token and the route verifies it by hashing and comparing.
    #
    # The hash is persisted in the store's meta KV under `order_access_token:<orderId>`, using
    # `cas_meta(key, hash, nil)` which is insert-if-absent — write-once minting for free.
    #
    # `hash_token` is byte-for-byte identical to the JS `hashOrderAccessToken`: `sha256:` +
    # the lowercase hex sha256 of the raw UTF-8 token. This keeps the cross-language capability
    # token contract identical regardless of where the hash is physically stored.
    module Tokens
      module_function

      ORDER_ACCESS_TOKEN_META_PREFIX = "order_access_token:"
      # 32 random bytes → 256 bits of entropy, URL-safe.
      ORDER_ACCESS_TOKEN_BYTES = 32
      # Name of the httpOnly cookie the create route sets with the minted per-order token, and which
      # RequestHandler.extract_token reads back on same-origin reads. Byte-identical to the JS
      # ORDER_TOKEN_COOKIE_NAME in @openreceive/http (handler.ts).
      ORDER_TOKEN_COOKIE_NAME = "openreceive_order_token"

      # Generate a fresh URL-safe capability token (256 bits of entropy).
      def generate
        SecureRandom.urlsafe_base64(ORDER_ACCESS_TOKEN_BYTES)
      end

      # Hash a raw token into its stored form (`sha256:<64 lowercase hex>`).
      def hash_token(token)
        "sha256:#{Digest::SHA256.hexdigest(token)}"
      end

      # Build the meta key for an order's stored token hash.
      def meta_key(order_id, namespace = nil)
        scope = namespace && namespace != "default" ? "#{namespace}:" : ""
        "#{ORDER_ACCESS_TOKEN_META_PREFIX}#{scope}#{order_id}"
      end

      # Per-order token manager backed by the store's meta KV (needs only get_meta/cas_meta,
      # which every OpenReceive store implements).
      class Manager
        def initialize(store:, namespace: "default", generator: nil)
          @store = store
          @namespace = namespace
          @generator = generator || Tokens.method(:generate)
        end

        def meta_key(order_id)
          assert_order_id(order_id)
          Tokens.meta_key(order_id, @namespace)
        end

        # Returns { token_hash:, created: } and, only when this call minted, { token: }.
        def mint(order_id)
          key = meta_key(order_id)
          existing = @store.get_meta(key)
          return { token_hash: existing["value"], created: false } unless existing.nil?

          token = @generator.call
          token_hash = Tokens.hash_token(token)
          result = @store.cas_meta(key: key, value: token_hash, expected_rev: nil)
          if result["status"] == "ok"
            { token: token, token_hash: token_hash, created: true }
          else
            # Lost a mint race with a concurrent checkout: replay the winner's hash, no token.
            winner = @store.get_meta(key)
            { token_hash: winner ? winner["value"] : result.dig("row", "value"), created: false }
          end
        end

        # Constant-time verification of a presented raw token against the stored hash.
        def verify(order_id, token)
          return false unless token.is_a?(String) && !token.empty?

          existing = @store.get_meta(meta_key(order_id))
          return false if existing.nil?

          secure_compare(Tokens.hash_token(token), existing["value"].to_s)
        end

        private

        def assert_order_id(order_id)
          return if order_id.is_a?(String) && !order_id.empty?

          raise ArgumentError, "order access token order_id must be a non-empty string"
        end

        def secure_compare(left, right)
          if defined?(Rack::Utils) && Rack::Utils.respond_to?(:secure_compare)
            Rack::Utils.secure_compare(left, right)
          else
            return false unless left.bytesize == right.bytesize

            left_bytes = left.unpack("C*")
            result = 0
            right.each_byte.with_index { |byte, index| result |= byte ^ left_bytes[index] }
            result.zero?
          end
        end
      end
    end
  end
end
