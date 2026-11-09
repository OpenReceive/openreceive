#!/usr/bin/env bash
# Starts one Rails instance for tests/deployment/two-instances.test.mjs, from
# the ortrial-edge-ruby image (Rails plus the pg, mysql2 and puma gems).
set -euo pipefail
cd /repo
exec ruby tests/deployment/instances/rails_instance.rb "$@"
