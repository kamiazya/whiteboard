import { installFacetWriteCoreForTests } from './core-setup.js'

// Every Node-hosted test realm judges a facet write through the Rust core, which
// has no TypeScript twin to fall back to; a missing artifact fails here, by name.
await installFacetWriteCoreForTests()
