//! Every crash input a fuzzer ever found, replayed on the stable toolchain.
//!
//! `pnpm rust:fuzz:*` copies each crash, timeout and out-of-memory input into
//! `regressions/<target>/`, so this test is red from the moment a finding
//! exists until the fix lands with the input committed beside it.

use std::path::Path;

fn root() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
}

#[test]
fn every_committed_regression_input_passes_its_target() {
    let mut replayed = 0usize;
    for dir in std::fs::read_dir(root().join("regressions")).unwrap() {
        let dir = dir.unwrap().path();
        let name = dir.file_name().unwrap().to_string_lossy().into_owned();
        let target = whiteboard_fuzz::TARGETS
            .iter()
            .find(|(n, _)| *n == name)
            .unwrap_or_else(|| panic!("regressions/{name} names no fuzz target"))
            .1;
        for input in std::fs::read_dir(&dir).unwrap() {
            let input = input.unwrap().path();
            if input.file_name().is_some_and(|f| f == ".gitkeep") {
                continue;
            }
            target(&std::fs::read(&input).unwrap());
            replayed += 1;
        }
    }
    // A replay over nothing passes for any target; the committed template
    // input is what proves this walk reaches a target at all.
    assert!(replayed > 0, "no regression input was replayed");
}

#[test]
fn every_target_has_a_binary_and_every_binary_a_target() {
    let manifest = std::fs::read_to_string(root().join("Cargo.toml")).unwrap();
    let mut bins: Vec<&str> = manifest
        .split("[[bin]]")
        .skip(1)
        .filter_map(|block| {
            block.lines().find_map(|l| l.trim().strip_prefix("name = \"")?.strip_suffix('"'))
        })
        .collect();
    bins.sort_unstable();
    let mut targets: Vec<&str> = whiteboard_fuzz::TARGETS.iter().map(|(n, _)| *n).collect();
    targets.sort_unstable();
    assert_eq!(bins, targets);
    assert!(!targets.is_empty());
}

#[test]
fn every_seed_input_passes_its_target_and_every_seed_dir_names_one() {
    let mut replayed = 0usize;
    for dir in std::fs::read_dir(root().join("seeds")).unwrap() {
        let dir = dir.unwrap().path();
        let name = dir.file_name().unwrap().to_string_lossy().into_owned();
        let target = whiteboard_fuzz::TARGETS
            .iter()
            .find(|(n, _)| *n == name)
            .unwrap_or_else(|| panic!("seeds/{name} names no fuzz target"))
            .1;
        for input in std::fs::read_dir(&dir).unwrap() {
            target(&std::fs::read(input.unwrap().path()).unwrap());
            replayed += 1;
        }
    }
    assert!(replayed > 0, "no seed input was replayed");
}

#[test]
fn the_routing_seeds_are_wires_the_export_answers() {
    // A seed the decoder refuses is a seed that taught the fuzzer nothing,
    // which is what a wire-format change leaves behind when it forgets them.
    let mut answered = 0usize;
    for input in std::fs::read_dir(root().join("seeds").join("edge_route_layout")).unwrap() {
        let bytes = std::fs::read(input.unwrap().path()).unwrap();
        let wire: Vec<f64> = bytes
            .chunks_exact(8)
            .map(|c| <[u8; 8]>::try_from(c).map_or(0.0, f64::from_le_bytes))
            .collect();
        assert!(!whiteboard_wasm::spatial_edges::edge_route_layout(&wire).is_empty());
        answered += 1;
    }
    assert!(answered >= 10, "only {answered} routing seeds");
}

#[test]
fn the_canvas_seeds_are_wires_the_export_decodes() {
    // A seed that is no canvas wire is refused before the writer runs, so it
    // reaches nothing past the decode; only the one named so may be.
    let mut decoded = 0usize;
    for input in std::fs::read_dir(root().join("seeds").join("json_canvas_wasm_serialize")).unwrap()
    {
        let input = input.unwrap().path();
        let wire = std::fs::read_to_string(&input).unwrap();
        let answer = whiteboard_wasm::json_canvas::json_canvas_serialize(&wire, false);
        let refused = answer.starts_with("[\"refused\",\"malformed\",\"wire\"]");
        assert_eq!(refused, input.file_name().is_some_and(|f| f == "unnamed-key"), "{input:?}");
        decoded += usize::from(!refused);
    }
    assert!(decoded >= 5, "only {decoded} canvas seeds decode");
}

#[test]
fn the_comment_seeds_are_layouts_the_export_draws_a_comment_layer_for() {
    // Taken from the recorded comment-layer layouts, so a wire change that
    // leaves them refused would leave the fuzzer starting from nothing it reads.
    let seeds = root().join("seeds").join("layout_spatial_canvas_wasm");
    for name in ["comments", "comment-passages"] {
        let request = std::fs::read_to_string(seeds.join(name)).unwrap();
        let answer = whiteboard_wasm::spatial_layout::layout_spatial_canvas(&request, None);
        assert!(
            answer.starts_with("[\"ok\"") && answer.contains("/pin\""),
            "{name}: {answer:.120}"
        );
    }
}

#[test]
fn the_fragment_seeds_are_layouts_the_export_draws_a_table_for() {
    // Taken from the recorded fragment-table layouts: one drawing rows of its
    // table and asking for the rest, one whose empty table asks for every source.
    let seeds = root().join("seeds").join("layout_spatial_canvas_wasm");
    for (name, drawn) in [("fragments", "<g data-sum/>"), ("fragments-asked", "\"kind\":\"math\"")]
    {
        let request = std::fs::read_to_string(seeds.join(name)).unwrap();
        let answer = whiteboard_wasm::spatial_layout::layout_spatial_canvas(&request, None);
        assert!(
            answer.starts_with("[\"ok\"")
                && answer.contains(drawn)
                && answer.contains("\"diagram\""),
            "{name}: {answer:.120}"
        );
    }
}

#[test]
fn the_font_seeds_are_faces_the_export_registers() {
    // A seed refused at its wire or its faces teaches the fuzzer nothing about
    // the measurer a handle builds; only the ones named for a refusal may be.
    let mut held = 0usize;
    for input in std::fs::read_dir(root().join("seeds").join("register_layout_fonts_wasm")).unwrap()
    {
        let input = input.unwrap().path();
        let bytes = std::fs::read(&input).unwrap();
        let at = bytes.iter().position(|&b| b == 0).unwrap();
        let faces = std::str::from_utf8(&bytes[..at]).unwrap();
        let answer =
            whiteboard_wasm::spatial_layout::register_layout_fonts(&bytes[at + 1..], faces);
        let handle = answer.strip_prefix("[\"ok\",").and_then(|h| h.strip_suffix(']'));
        let refused = handle.is_none();
        assert_eq!(
            refused,
            input.file_name().is_some_and(|f| f == "outside"),
            "{input:?}: {answer}"
        );
        if let Some(handle) = handle.and_then(|h| h.parse().ok()) {
            assert!(whiteboard_wasm::spatial_layout::release_layout_fonts(handle));
            held += 1;
        }
    }
    assert!(held >= 5, "only {held} font seeds register");
}

#[test]
fn the_proposal_seeds_are_layouts_the_export_draws_a_proposal_layer_for() {
    // Taken from the recorded proposal-layer layouts, so a wire change that
    // leaves them refused would leave the fuzzer starting from nothing it reads.
    let seeds = root().join("seeds").join("layout_spatial_canvas_wasm");
    for name in ["proposals", "proposal-priors"] {
        let request = std::fs::read_to_string(seeds.join(name)).unwrap();
        let answer = whiteboard_wasm::spatial_layout::layout_spatial_canvas(&request, None);
        assert!(
            answer.starts_with("[\"ok\"") && answer.contains("/outline\""),
            "{name}: {answer:.120}"
        );
    }
}

#[test]
fn the_host_seed_is_a_layout_the_stand_in_measures() {
    // The fuzzer reaches the host's measurer only through the stand-in, so a
    // seed the stand-in cannot answer would leave that path unexplored.
    use whiteboard_fuzz::targets::StandInHost;
    use whiteboard_wasm::spatial_layout::layout_with_host;
    let seed = root().join("seeds").join("layout_spatial_canvas_wasm").join("host-measure");
    let request = std::fs::read_to_string(seed).unwrap();
    let answer = layout_with_host(&request, Some(&StandInHost));
    assert!(answer.starts_with("[\"ok\""), "{answer:.120}");
    let unmeasured = layout_with_host(&request, None);
    assert_eq!(unmeasured, "[\"declined\",\"host-measure\"]");
}

#[test]
fn the_content_cache_seed_is_a_layout_a_warm_cache_answers_the_same() {
    // The fragment seed with a plain body beside it, naming a surface, so the
    // fuzzer starts from a request whose bodies are kept and read back.
    let seeds = root().join("seeds").join("layout_spatial_canvas_wasm");
    let request = std::fs::read_to_string(seeds.join("content-cache")).unwrap();
    let first = whiteboard_wasm::spatial_layout::layout_spatial_canvas(&request, None);
    assert!(first.starts_with("[\"ok\""), "{first:.120}");
    let again = whiteboard_wasm::spatial_layout::layout_spatial_canvas(&request, None);
    assert_eq!(again, first);
    assert!(whiteboard_wasm::spatial_layout::release_layout_cache(7));
}
