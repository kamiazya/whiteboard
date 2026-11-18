import { installSearchCoreForTests } from './install.js'

// A Node test realm that reaches search answers it through the Rust core; a missing artifact
// fails here, by name.
await installSearchCoreForTests()
