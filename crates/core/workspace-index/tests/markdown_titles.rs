//! The title a markdown body announces, against what the TypeScript's
//! `titleFromMarkdownBody` answered for the same bodies
//! (`fixtures/markdown_titles.json`, `[body, title or null]` pairs): blank
//! lines skipped, the space after the marker required, closing markers and
//! whitespace runs dropped, and the line and title length bounds counted in
//! UTF-16 units.

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_workspace_index::title_from_body::title_from_markdown_body;

const TITLES: &str = include_str!("fixtures/markdown_titles.json");

#[test]
fn every_body_announces_the_title_the_typescript_read() {
    let pairs: Vec<(String, Option<String>)> = serde_json::from_str(TITLES).expect("the pairs");
    assert!(pairs.len() > 30, "{} bodies", pairs.len());
    for (body, title) in pairs {
        assert_eq!(title_from_markdown_body(&body), title, "{body:?}");
    }
}
