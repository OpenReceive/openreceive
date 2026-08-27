# frozen_string_literal: true

# THE SHARED BOUNDARY, enforced.
#
# examples/buttons/shared/ is named so that a wrong import is visible in the
# diff rather than discovered at build time:
#
#   client/       React + Mantine + mobx-keystone. Rails and Next.js.
#   client-vanilla/  the no-framework host ONLY.
#   server-node/  SQLite and Express. The Node stacks ONLY.
#
# Rails has ActiveRecord and its own controllers, so it must never import
# shared/server-node/**, and it has no business in client-vanilla/ either. The
# vanilla half of the rule is enforced differently — by keeping @mantine/* and
# mobx* out of that workspace's package.json, where an accidental import simply
# fails to resolve. This is the Rails half.

app_root = File.expand_path("..", __dir__)
sources = Dir[File.join(app_root, "app/javascript/**/*.{ts,tsx,js,jsx}")]

FORBIDDEN = %w[server-node client-vanilla].freeze

violations = sources.flat_map do |path|
  File.readlines(path).each_with_index.filter_map do |line, index|
    next unless line.include?("shared/")

    directory = FORBIDDEN.find { |dir| line.include?("shared/#{dir}/") }
    next unless directory

    "#{path.delete_prefix("#{app_root}/")}:#{index + 1} imports shared/#{directory}/"
  end
end

unless violations.empty?
  warn "The Rails demo may only import shared/shop-types.ts and shared/client/**:"
  violations.each { |violation| warn "- #{violation}" }
  exit 1
end

puts "Shared-boundary check passed: #{sources.length} client files, no " \
     "shared/server-node or shared/client-vanilla imports."
