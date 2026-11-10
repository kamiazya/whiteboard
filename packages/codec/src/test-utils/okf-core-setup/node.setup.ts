import { installOkfCoreForTests } from './install.js'

// Every Node-hosted test realm answers OKF through the Rust core, which has no
// TypeScript twin to fall back to; a missing artifact fails here, by name.
await installOkfCoreForTests()
