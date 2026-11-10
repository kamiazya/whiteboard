import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'codec-node',
    environment: 'node',
    // Installs the Rust OKF core when WHITEBOARD_CORE_OKF asks for it, so this realm's plain
    // parseOkf/serializeOkf run the differential (codec's okf-core-setup).
    setupFiles: ['../../packages/codec/src/test-utils/okf-core-setup/node.setup.ts'],
    include: ['src/**/*.test.ts'],
    // Reads the artifact `pnpm rust:build:wasm` writes; the `rust` job runs it as codec-rust.
    exclude: ['src/**/*.rust.test.ts'],
  },
})
