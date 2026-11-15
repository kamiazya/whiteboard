//! The two shortcode scans against the recorded answers of the TypeScript.
//!
//! `packages/plugin-visual/src/oracle/shortcode-recorded-oracle.test.ts`
//! writes `shortcode.jsonl`: per text, what `expandEmojiShortcodes` made of it
//! and the `[from, to, name]` ranges `iconShortcodeRanges` answered, in UTF-16
//! code units. This replays every line exactly.

use serde_json::{Value as Json, json};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_plugin_visual::shortcode::{expand_emoji_shortcodes, icon_shortcode_ranges};

const RECORDING: &str =
    include_str!("../../../../packages/plugin-visual/src/oracle/shortcode.jsonl");

#[test]
fn every_recorded_text_is_scanned_as_the_typescript_scanned_it() {
    let mut replayed = 0;
    let mut failures = Vec::new();
    for line in RECORDING.lines() {
        let line: Json = serde_json::from_str(line).expect("a recorded line");
        let text = line["in"].as_str().expect("a text");
        let icons: Vec<Json> = icon_shortcode_ranges(text)
            .into_iter()
            .map(|range| json!([range.from, range.to, range.name]))
            .collect();
        let got = json!({"in": text, "emoji": expand_emoji_shortcodes(text), "icons": icons});
        if got != line {
            failures.push(format!("got {got}\nrecorded {line}"));
        }
        replayed += 1;
    }
    assert!(failures.is_empty(), "{} differ:\n{}", failures.len(), failures.join("\n"));
    assert_eq!(replayed, 1539, "every recorded line replayed");
}
