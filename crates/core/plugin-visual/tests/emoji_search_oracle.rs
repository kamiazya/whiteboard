//! `emoji_search_text` against the recorded answers of the TypeScript's
//! `emojiSearchText`.
//!
//! `packages/plugin-visual/src/oracle/emoji-search-recorded-oracle.test.ts`
//! writes `emoji-search.jsonl`: per text, the terms it lends a search index.
//! This replays every line exactly.

#![cfg(feature = "emoji-search")]

use serde_json::Value as Json;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_plugin_visual::emoji_search::emoji_search_text;

const RECORDING: &str =
    include_str!("../../../../packages/plugin-visual/src/oracle/emoji-search.jsonl");

#[test]
fn every_recorded_text_lends_what_the_typescript_lent() {
    let (mut replayed, mut lent) = (0, 0);
    let mut failures = Vec::new();
    for line in RECORDING.lines() {
        let line: Json = serde_json::from_str(line).expect("a recorded line");
        let text = line["in"].as_str().expect("a text");
        let held = line["out"].as_str().expect("the terms");
        let got = emoji_search_text(text);
        if got != held {
            failures.push(format!("{text:?}: got {got:?}, recorded {held:?}"));
        }
        replayed += 1;
        lent += usize::from(!held.is_empty());
    }
    assert!(failures.is_empty(), "{} differ:\n{}", failures.len(), failures.join("\n"));
    assert_eq!(replayed, 3565, "every recorded line replayed");
    assert!(lent > 1900, "texts that lend a row: {lent}");
}
