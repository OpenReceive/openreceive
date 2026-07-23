# frozen_string_literal: true

require "base64"
require "json"
require "openssl"
require "securerandom"

module OpenReceive
  module Server
    module Tokens
      class InvalidToken < StandardError; end

      class Manager
        def initialize(keys:, clock: -> { Time.now.to_i })
          raise ArgumentError, "token keyring must not be empty" if keys.nil? || keys.empty?
          @keys = keys.to_h do |entry|
            id = (entry[:id] || entry["id"]).to_s
            raise ArgumentError, "token key id must be 1-32 URL-safe characters" unless /\A[A-Za-z0-9_-]{1,32}\z/.match?(id)
            [id, decode_key(entry[:key] || entry["key"])]
          end
          raise ArgumentError, "duplicate token key id" unless @keys.length == keys.length
          @current_id = (keys.first[:id] || keys.first["id"]).to_s
          @clock = clock
        end

        def seal(purpose, payload)
          prefix = "or_#{purpose}_v1"
          iv = SecureRandom.random_bytes(16)
          encryption_key, authentication_key = derive_keys(@keys.fetch(@current_id))
          cipher = OpenSSL::Cipher.new("aes-256-cbc").encrypt
          cipher.key = encryption_key
          cipher.iv = iv
          body = stringify(payload).merge("version" => 1, "purpose" => purpose.to_s, "issuedAt" => @clock.call)
          encrypted = cipher.update(JSON.generate(body)) + cipher.final
          tag = authenticate(authentication_key, prefix, @current_id, iv, encrypted)
          [prefix, @current_id, encode(iv), encode(encrypted), encode(tag)].join(".")
        end

        def open(purpose, token)
          prefix, key_id, iv, encrypted, tag, extra = token.to_s.split(".", -1)
          raise InvalidToken unless extra.nil? && prefix == "or_#{purpose}_v1"
          master_key = @keys.fetch(key_id)
          iv_bytes = decode(iv)
          encrypted_bytes = decode(encrypted)
          tag_bytes = decode(tag)
          raise InvalidToken unless iv_bytes.bytesize == 16 && tag_bytes.bytesize == 32
          encryption_key, authentication_key = derive_keys(master_key)
          expected_tag = authenticate(authentication_key, prefix, key_id, iv_bytes, encrypted_bytes)
          raise InvalidToken unless secure_compare(tag_bytes, expected_tag)
          decipher = OpenSSL::Cipher.new("aes-256-cbc").decrypt
          decipher.key = encryption_key
          decipher.iv = iv_bytes
          payload = JSON.parse(decipher.update(encrypted_bytes) + decipher.final)
          raise InvalidToken unless payload["version"] == 1 && payload["purpose"] == purpose.to_s && payload["issuedAt"].is_a?(Integer)
          raise InvalidToken if payload["expiresAt"] && payload["expiresAt"] <= @clock.call
          payload
        rescue KeyError, ArgumentError, JSON::ParserError, OpenSSL::Cipher::CipherError
          raise InvalidToken, "Invalid or expired OpenReceive token."
        end

        private

        def decode_key(value)
          text = value.to_s
          key = if /\A[0-9a-fA-F]{64}\z/.match?(text)
                  [text].pack("H*")
                else
                  text.include?("+") || text.include?("/") ? Base64.strict_decode64(text) : decode(text)
                end
          raise ArgumentError, "token keys must decode to 32 bytes" unless key.bytesize == 32
          key
        end

        def encode(value)
          Base64.urlsafe_encode64(value, padding: false)
        end

        def decode(value)
          Base64.urlsafe_decode64(value.to_s)
        end

        def stringify(value)
          value.to_h.transform_keys(&:to_s)
        end

        def derive_keys(master_key)
          [
            OpenSSL::HMAC.digest("SHA256", master_key, "openreceive:token:encryption:v1"),
            OpenSSL::HMAC.digest("SHA256", master_key, "openreceive:token:authentication:v1")
          ]
        end

        def authenticate(key, prefix, key_id, iv, encrypted)
          OpenSSL::HMAC.digest("SHA256", key, "#{prefix}.#{key_id}." + iv + encrypted)
        end

        def secure_compare(left, right)
          return false unless left.bytesize == right.bytesize
          result = 0
          left.bytes.zip(right.bytes) { |a, b| result |= a ^ b }
          result.zero?
        end
      end

      module_function

      def parse_keyring(value)
        value.to_s.split(",").map do |entry|
          id, key = entry.split(":", 2)
          raise ArgumentError, "token keys must use kid:key entries" if id.to_s.empty? || key.to_s.empty?
          { id: id, key: key }
        end
      end
    end
  end
end
