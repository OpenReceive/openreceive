<!-- First PR from a fork? Its CI run waits for a maintainer to click
     "Approve and run". A run marked as awaiting approval is expected, not a
     failure. -->

## What changed

## Why

## Checks

- [ ] `npm run test:ci:core` passes locally
- [ ] `npm run test:ruby` passes locally, or the change touches no Ruby surface
- [ ] Behavior changes carry tests; shared behavior carries a `spec/test-vectors/` entry
