# Release Process

OpenReceive starts with a small v0.1 release surface:

- OpenReceive `0.1.0`
- `@openreceive/core`
- `@openreceive/node`
- `@openreceive/express`
- `@openreceive/browser`
- `@openreceive/provider-data`
- `@openreceive/testkit`
- `@openreceive/elements`
- `@openreceive/react`

Packages remain private in this repository until publishing is explicitly
approved.

## Release Gate

Before tagging a release:

```sh
npm run test:ci
```

The release owner also checks:

- Changelog updated.
- Package versions match the intended tag.
- JSON schemas and test vectors pass.
- OpenAPI and AsyncAPI validation passes through `npm run validate`.
- Secret scan passes.
- Local package artifact smoke passes.
- Demo build passes.
- Live wallet smoke passes when a trusted `OPENRECEIVE_NWC` is available.

## Suggested Tags

- `v0.1.0`
- `js-core-v0.1.0`
- `js-node-v0.1.0`
- `js-express-v0.1.0`
- `js-browser-v0.1.0`
- `js-provider-data-v0.1.0`
- `js-testkit-v0.1.0`
- `js-elements-v0.1.0`
- `js-react-v0.1.0`

Use independent package versions later, after the contract is stable enough to
avoid confusing SDK consumers.

## Notes

Release notes should name which demos were rebuilt, which package versions they
run, and whether the live wallet smoke was skipped or paid manually.

Do not publish new SDKs, framework adapters, React default UI, provider-data
variants, or generated models unless the shared contract and conformance gate
cover the behavior they expose.
