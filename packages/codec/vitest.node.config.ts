import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'codec-node',
    environment: 'node',
    // Installs the Rust OKF core, which this realm's parseOkf/serializeOkf answer through
    // (codec's okf-core-setup); a missing artifact fails the project by name.
    setupFiles: ['../../packages/codec/src/test-utils/okf-core-setup/node.setup.ts'],
    include: ['src/**/*.test.ts'],
    // Needs the artifact `pnpm rust:build:wasm` writes; the spatial live differential runs as codec-rust.
    exclude: ['src/**/*.rust.test.ts'],
  },
})
