#!/bin/sh
# The order's status column, for the trial harness: `order-status <id>`.
echo "select status from public.orders where id::text = :'id'" |
  psql -U postgres -d postgres -tA -v id="$1"
