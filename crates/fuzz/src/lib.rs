//! The bodies of the fuzz targets, one per entry of `crates/input-caps.json`.
//!
//! Each `fuzz_targets/<name>.rs` is a one-line libFuzzer shell around the
//! function of the same name here, so the same body replays the committed
//! crash inputs under `regressions/<name>/` on the stable toolchain
//! (`tests/regressions.rs`). A target reports a finding by panicking: that is
//! what libFuzzer records as a crash.

pub mod targets;

/// A target body: one input, a panic for a finding.
pub type Target = fn(&[u8]);

/// Every target, by the name its binary and its registry entry carry.
pub const TARGETS: &[(&str, Target)] = &[
    ("det_utf16_len", targets::det_utf16_len),
    ("edge_route_layout", targets::edge_route_layout),
    ("facet_wasm_bucket_check", targets::facet_wasm_bucket_check),
    ("frontmatter_parse", targets::frontmatter_parse),
    ("json_canvas_parse", targets::json_canvas_parse),
    ("json_canvas_wasm_parse", targets::json_canvas_wasm_parse),
    ("json_canvas_wasm_serialize", targets::json_canvas_wasm_serialize),
    ("okf_parse", targets::okf_parse),
    ("okf_wasm_parse", targets::okf_wasm_parse),
    ("okf_wasm_serialize", targets::okf_wasm_serialize),
];
