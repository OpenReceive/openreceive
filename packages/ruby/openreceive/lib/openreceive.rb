# frozen_string_literal: true

require_relative "openreceive/version"
# The kernel vocabularies every engine shares, generated from spec/ (npm run
# generate:models). Loaded first: core and the server gem alias its constants.
require_relative "openreceive/generated/tables"
require_relative "openreceive/core"
require_relative "openreceive/nwc_ruby"
require_relative "openreceive/rates"
require_relative "openreceive/swap_address"
