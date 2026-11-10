// The reader's limits as `crates/input-caps.json` states them for
// `whiteboard-codec::json_canvas::parse`: a text past `MAX_BYTES` and a nesting
// past `MAX_DEPTH` are declined. `json_canvas.rs`'s tests hold the registry's
// numbers equal to the codec's own; these are the same numbers for a test that
// judges a decline without asking the core.
export const MAX_BYTES = 4 * 1024 * 1024
export const MAX_DEPTH = 64
