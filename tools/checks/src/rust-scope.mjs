/**
 * The Cargo workspace's files at the root and the trees under it, and the
 * TypeScript the Rust jobs load: the det differential, the edge suites
 * canvas-render-rust re-runs against the Rust router, and since ADR-0054
 * step 7's S18h every layout scoreboard and recorded replay, with the
 * TypeScript that builds the core's request (the switches, the measurer's
 * spec, the reference wire, the theme) and the instruments that score its
 * answer. A change here is attributed to the Rust jobs; one under a pnpm
 * package also selects that package's own jobs as usual. Its own module so
 * the list can grow with the migration without growing affected.mjs, which
 * reads it as PATH_JOBS' scope. The Rust CI scripts
 * (tools/checks/src/rust-*.mjs) are not listed: tools/checks selects
 * everything, the Rust jobs with it.
 *
 * The canvas-render half is held by `tools/arch-lint`'s
 * rust-scope-closure.test.ts: every canvas-render file in the value-import
 * closure of what canvas-render-rust includes must be listed here, as a file
 * or under a tree, so a rust test that starts importing an unscoped module
 * fails there instead of leaving a PR that changes it unscored.
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
    'packages/canvas-render/src/scene-diff-quality.rust.test.ts',
    // The package-root modules the layout scoreboards and replays load.
    'packages/canvas-render/src/comment-geometry.ts',
    'packages/canvas-render/src/containment.ts',
    'packages/canvas-render/src/edge-arrows.ts',
    'packages/canvas-render/src/finite-box.ts',
    'packages/canvas-render/src/measure.ts',
    'packages/canvas-render/src/refusal.ts',
    'packages/canvas-render/src/scene-bounds.ts',
    'packages/canvas-render/src/scene-children.ts',
    'packages/canvas-render/src/scene-entry-keys.ts',
    'packages/canvas-render/src/tidy.ts',
    'packages/canvas-render/src/tidy-axis.ts',
    'packages/canvas-render/src/tidy-bands.ts',
    'packages/canvas-render/src/tidy-units.ts',
    // The bundled plugin's manifest, which the Rust crate embeds and loads.
    'packages/plugin-visual/src/visual.manifest.json',
  ],
  trees: [
    '.cargo',
    'crates',
    'contracts',
    'packages/canvas-render/src/generated',
    // What builds the core's request and reads its answer back (the canvas,
    // markdown and query switches, the fitted height, the layout options), the
    // scoreboards beside them, and the edge suites canvas-render-rust re-runs
    // against the Rust router.
    'packages/canvas-render/src/layout',
    // The reference wire a request carries, and its replay.
    'packages/canvas-render/src/references',
    // The theme and geometry a request carries.
    'packages/canvas-render/src/theme',
    // The highlighter that answers the fences the core asks for.
    'packages/canvas-render/src/highlight',
    // What the drawing scoreboard reads of a scene: the edge path, the ink, the legend's box.
    'packages/canvas-render/src/edge-path',
    'packages/canvas-render/src/ink',
    'packages/canvas-render/src/legend',
    'packages/canvas-render/src/test-utils/wasm',
    // The layout scoreboards judge the core in canvas-render-rust (S18h): the
    // instruments they score with, the corpora they read, and the recordings
    // the core is replayed against.
    'packages/canvas-render/src/quality',
    'packages/canvas-render/src/oracle',
    'packages/canvas-render/src/test-utils',
    // The shim over the artifact, tested in the rust job (core-wasm-rust).
    'packages/core-wasm',
    // The Rust codec replays the OKF recordings that live beside the codec's
    // own suites, which run on the core.
    'packages/codec/src/okf',
    'packages/codec/src/test-utils/okf-oracle',
    'packages/codec/src/test-utils/frontmatter-oracle',
    // The JSON Canvas codec's recording, replayed by the Rust crate and by codec-node.
    'packages/codec/src/spatial/oracle',
    'packages/codec/src/test-utils/json-canvas-oracle',
    // The bundled plugin's asset tables, which the Rust crate embeds, and the
    // facet-write recording it replays.
    'packages/plugin-visual/src/assets',
    'packages/plugin-visual/src/oracle',
  ],
}
