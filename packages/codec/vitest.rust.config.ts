import { defineProject } from 'vitest/config'

// The OKF envelope held to its Rust twin through the staged wasm artifact
// (ADR-0054, QR-21 layer 2). CI runs it in the `rust` job after the wasm build
// and `stage:wasm`, and fails there when the artifact is absent.
export default defineProject({
  test: {
    name: 'codec-rust',
    environment: 'node',
    include: ['src/**/*.rust.test.ts'],
    testTimeout: 30_000,
  },
})
