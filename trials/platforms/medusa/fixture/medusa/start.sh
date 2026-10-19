#!/bin/sh
# As Medusa's Docker guide starts a server: migrate, seed (the seed leaves a
# store it already filled alone), then serve.
set -e
npx medusa db:migrate
npx medusa exec ./src/scripts/seed.ts
exec npx medusa start
