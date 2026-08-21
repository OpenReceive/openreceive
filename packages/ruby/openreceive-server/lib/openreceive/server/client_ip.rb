# frozen_string_literal: true

module OpenReceive
  module Server
    # Client-IP bucketing shared by rate limiting and attempt-row stamping.
    # Ports the JS openReceiveClientIpBucket exactly: the same input string
    # must produce the same bucket string in both engines (mirrored tests in
    # tests/rate-limit.test.mjs and the Ruby server tests).
    #
    # - IPv4-mapped IPv6 (`::ffff:a.b.c.d`) collapses to the plain IPv4, so
    #   the same client never gets two independent budgets.
    # - IPv6 buckets to its /64 (`2001:db8:1:2::/64`): privacy extensions
    #   rotate the low 64 bits freely, so per-address budgets would hand every
    #   IPv6 payer an unlimited stream of fresh budgets.
    # - IPv4 and already-bucketed values pass through unchanged (idempotent).
    # - Unparsable input passes through as-is — an odd value still gets SOME
    #   consistent bucket rather than disabling the limit.
    module ClientIp
      module_function

      # nil/empty-safe wrapper mirroring the JS handler's extractClientIp:
      # no attributable IP stays nil (the limiter fails open); anything else
      # is normalized into the bucket that is both stored and counted.
      def attributed(raw)
        value = raw.to_s
        return nil if value.strip.empty?
        bucket(value)
      end

      def bucket(ip)
        value = ip.to_s.strip.downcase
        value = value.delete_prefix("::ffff:") if value.start_with?("::ffff:") && value.include?(".")
        return value unless value.include?(":")
        return value if value.end_with?("/64")
        address = value.split("%", -1).first || ""
        hextets = expand_ipv6(address)
        return value if hextets.nil?
        "#{hextets.first(4).join(':')}::/64"
      end

      def expand_ipv6(value)
        parts = value.split("::", -1)
        return nil if parts.length > 2 || value.empty?
        head = hextets_of(parts[0] || "")
        tail = parts.length == 2 ? hextets_of(parts[1] || "") : []
        return nil if head.nil? || tail.nil?
        return head.length == 8 ? head : nil if parts.length == 1
        missing = 8 - head.length - tail.length
        return nil if missing < 1
        head + Array.new(missing, "0") + tail
      end

      def hextets_of(segment)
        return [] if segment == ""
        groups = []
        segment.split(":", -1).each do |group|
          if /\A[0-9a-f]{1,4}\z/.match?(group)
            groups << group.sub(/\A0+(?=.)/, "")
          elsif /\A\d{1,3}(\.\d{1,3}){3}\z/.match?(group)
            octets = group.split(".").map { |octet| Integer(octet, 10) }
            return nil if octets.any? { |octet| octet > 255 }
            # Embedded IPv4 tail expands to two hextets.
            groups << (((octets[0] << 8) | octets[1]).to_s(16))
            groups << (((octets[2] << 8) | octets[3]).to_s(16))
          else
            return nil
          end
        end
        groups
      end
    end
  end
end
