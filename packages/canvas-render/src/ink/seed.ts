// The style-randomness primitive (decision #10): every "random" choice a
// render style makes must be a pure function of stable node identity —
// never ambient RNG, never geometry. That is what keeps a styled canvas
// rendering byte-identically twice, invariant under translate/scale (the
// seed has no positional input by construction), and immune to edits of
// unrelated nodes. The seed itself is the core's (`seed_from_id` in
// `crates/core/canvas-render`); this is the stream drawn from it, and the
// package's ONLY randomness — nothing here touches Math.random.

/**
 * A deterministic stream of floats in [0, 1) from a seed — mulberry32. A
 * seed is the core's hash of a node's identity, and is what a scene node carries
 * (`SceneInk.seed`), so the SVG backend and every other consumer of the ink
 * decomposition draw from the identical sequence without knowing the id. Each
 * call site takes its own stream, so consuming one node's stream can never
 * shift another's.
 */
export function styleRandomFromSeed(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
