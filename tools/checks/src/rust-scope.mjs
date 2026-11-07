/**
 * The Cargo workspace's files at the root and the trees under it, and the
 * TypeScript the Rust jobs hold their ports to (the det differential, the
 * edge suites canvas-render-rust re-runs against the Rust router). A change
 * here is attributed to the Rust jobs; one under a pnpm package also selects
 * that package's own jobs as usual. Its own module so the list can grow with
 * the migration without growing affected.mjs, which reads it as PATH_JOBS'
 * scope. The Rust CI scripts
 * (tools/checks/src/rust-*.mjs) are not listed: tools/checks selects
 * everything, the Rust jobs with it.
 */
export const RUST_SCOPE = {
  files: [
    'Cargo.toml',
    'Cargo.lock',
    'rust-toolchain.toml',
    'rustfmt.toml',
    'deny.toml',
    'packages/canvas-render/src/det-math.ts',
    'packages/canvas-render/src/det-math.rust.test.ts',
    'packages/canvas-render/vitest.rust.config.ts',
  ],
  trees: [
    '.cargo',
    'crates',
    'contracts',
    'packages/canvas-render/src/generated',
    // canvas-render-rust re-runs the edge suites against the Rust router.
    'packages/canvas-render/src/layout/edges',
    'packages/canvas-render/src/test-utils/wasm',
  ],
}
