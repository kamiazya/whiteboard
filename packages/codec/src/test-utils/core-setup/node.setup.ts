import { installCoreForTests } from './install.js'

// Every Node-hosted test realm answers OKF and JSON Canvas through the Rust core, which have no
// TypeScript twin to fall back to; a missing artifact fails here, by name.
await installCoreForTests()
