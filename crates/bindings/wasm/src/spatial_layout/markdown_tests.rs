//! The markdown entry's own rules, which the recorded corpus cannot reach:
//! what a note resolves with no references, the path and account an embedded
//! board shares with the note, the section, the caps and the decoder.

use serde_json::{Value as Json, json};
use whiteboard_model::spatial::SpatialCanvas;

use super::cache::resident;
use super::tests::{fake, m, s, text_node};
use super::{
    MAX_BODY_BYTES, MAX_ELEMENTS, MAX_REFERENCED_ELEMENTS, layout_with_host, release_layout_cache,
};

/// The most one body may hold and still be parsed (`whiteboard_markdown::limits::MAX_BYTES`).
const MAX_PARSE_BYTES: usize = 786_432;
use crate::json_canvas_wire::canvas_json;

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

fn note(body: &str, extra: &[(&str, Json)]) -> String {
    let mut fields = vec![
        ("kind", json!("markdown")),
        ("body", json!(body)),
        ("maxWidth", json!(480)),
        ("measure", fake()),
        ("mode", json!("light")),
    ];
    for (key, value) in extra {
        fields.retain(|(name, _)| name != key);
        fields.push((key, value.clone()));
    }
    m(&fields).to_string()
}

fn answer(request: &str) -> Json {
    serde_json::from_str(&layout_with_host(request, None)).unwrap_or(Json::Null)
}

/// A wire whose one entry is a board, `b`, of text nodes holding `bodies`.
fn board_wire(bodies: &[&str]) -> Json {
    let nodes = bodies
        .iter()
        .enumerate()
        .map(|(i, body)| {
            let mut node = text_node(&format!("t{i}"), body);
            node.x = 240.0 * f64::from(u32::try_from(i).unwrap_or(0));
            node
        })
        .collect();
    let canvas = canvas_json(&SpatialCanvas { nodes, ..SpatialCanvas::default() });
    let entry = m(&[("documentId", json!("B")), ("canvas", canvas)]);
    m(&[
        ("entries", s(vec![s(vec![json!("b"), entry])])),
        ("aliases", s(vec![])),
        ("titles", s(vec![])),
        ("extras", s(vec![])),
    ])
}

fn count(answer: &Json, part: &str) -> usize {
    answer.to_string().matches(part).count()
}

/// A paragraph that is only an embed of a document id is set as prose when
/// the surface handed no references, as a note with no `resolveEmbed` is.
#[test]
fn with_no_references_an_embed_of_an_id_is_set_as_prose() {
    let id = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    let bare = answer(&note(&format!("![[{id}]]"), &[]));
    assert_eq!(bare.get(0), Some(&json!("ok")), "{bare}");
    assert_eq!(count(&bare, "embedPlaceholder"), 0, "{bare}");
    assert_eq!(count(&bare, "\"kind\":\"paragraph\""), 1, "{bare}");
    let wired = answer(&note(&format!("![[{id}]]"), &[("references", board_wire(&[]))]));
    assert_eq!(count(&wired, "\"reason\":\"unresolvable\""), 1, "{wired}");
}

/// A board drawn in a note is laid out on the embed's path, so a text node
/// of the board embedding the board again is a cycle there, not one level on.
#[test]
fn a_board_in_a_note_is_laid_out_on_the_path_that_embeds_it() {
    let laid = answer(&note("![[b]]", &[("references", board_wire(&["![[b]]"]))]));
    assert_eq!(laid.get(0), Some(&json!("ok")), "{laid}");
    assert_eq!(count(&laid, "\"reason\":\"cycle\""), 1, "{laid}");
    // The note's embed and its title link, then the cycle under it, name the
    // board; one level on would name it twice more.
    assert_eq!(count(&laid, "\"documentId\":\"B\""), 3, "{laid}");
}

/// The fences of a note and of the boards it embeds spend one tokenizer
/// account: four priced at the per-fence cap spend it, and the board's
/// fence is then drawn plain rather than asked for.
#[test]
fn a_board_in_a_note_spends_from_the_note_account() {
    let run = "a".repeat(4096);
    let fences = format!("```ts\n{run}\n```\n\n").repeat(4);
    let wire = board_wire(&["```ts\nconst x = 1\n```"]);
    let asked = answer(&note(&format!("{fences}![[b]]"), &[("references", wire.clone())]));
    assert_eq!(asked.get(0), Some(&json!("needs")), "{asked}");
    let code = asked[1]["code"].as_array().cloned().unwrap_or_default();
    assert_eq!(code.len(), 1, "the note's one fence alone: {asked}");
    let alone = answer(&note("![[b]]", &[("references", wire)]));
    assert_eq!(alone[1]["code"], json!([["ts", "const x = 1"]]), "{alone}");
}

#[test]
fn a_section_the_note_does_not_hold_is_missing() {
    let body = "# One\n\ntext\n\n## Two\n\nmore";
    let missing = answer(&note(body, &[("section", json!("Nonesuch"))]));
    assert_eq!(missing, json!(["missing", "section"]));
    let two = answer(&note(body, &[("section", json!("Two"))]));
    assert_eq!(count(&two, "\"text\":\"One\""), 0, "{two}");
    assert_eq!(count(&two, "\"text\":\"Two\""), 1, "{two}");
}

fn comment(body: &str, density: &str) -> String {
    let fields = [
        ("kind", json!("comment")),
        ("body", json!(body)),
        ("maxWidth", json!(200)),
        ("measure", fake()),
        ("density", json!(density)),
    ];
    m(&fields).to_string()
}

#[test]
fn a_comment_past_the_parser_bounds_is_declined_and_one_within_is_drawn() {
    let deep = format!("{}deep", "> ".repeat(40));
    assert_eq!(answer(&comment(&deep, "compact")), json!(["declined", "body"]));
    let drawn = answer(&comment("**bold** and :rocket:", "compact"));
    assert_eq!(drawn.get(0), Some(&json!("ok")), "{drawn}");
    assert_eq!(count(&drawn, "🚀"), 1, "{drawn}");
    let note_deep = answer(&note(&deep, &[]));
    assert_eq!(note_deep, json!(["declined", "body"]));
}

#[test]
fn a_markdown_request_past_its_caps_is_refused() {
    let long = "a".repeat(MAX_BODY_BYTES + 1);
    let refused = |what: &str| json!(["refused", "input-too-large", what]);
    assert_eq!(answer(&comment(&long, "comfortable")), refused("bodies"));
    assert_eq!(answer(&note(&long, &[])), refused("bodies"));
    // At the cap is within it, and one body that large is past the parser's own
    // bound, which declines it (D7a's, held behind the switch's retirement).
    let full = "\n".repeat(MAX_BODY_BYTES);
    assert_eq!(answer(&comment(&full, "comfortable")), json!(["declined", "body"]));
    assert_eq!(answer(&note(&full, &[])), json!(["declined", "body"]));
    // Blank lines parse to nothing, so a body at the parser's bound costs no layout.
    let parsed = "\n".repeat(MAX_PARSE_BYTES);
    assert_eq!(answer(&comment(&parsed, "comfortable")).get(0), Some(&json!("ok")));
    assert_eq!(answer(&note(&parsed, &[])).get(0), Some(&json!("ok")));
    let half = "a".repeat(MAX_BODY_BYTES / 2 + 1);
    assert_eq!(answer(&note(&half, &[("references", board_wire(&[&half]))])), refused("bodies"));
    let at_cap: Vec<&str> = vec![""; MAX_ELEMENTS];
    let within = answer(&note("x", &[("references", board_wire(&at_cap))]));
    assert_eq!(within.get(0), Some(&json!("ok")));
    let row = s(vec![json!("math:x"), m(&[("svg", json!("<g/>"))])]);
    let table = s(vec![row; super::MAX_FRAGMENTS]);
    assert_eq!(answer(&note("x", &[("fragments", table)])).get(0), Some(&json!("ok")));
    let many: Vec<&str> = vec![""; MAX_REFERENCED_ELEMENTS + 1];
    let elements = answer(&note("x", &[("references", board_wire(&many))]));
    assert_eq!(elements, refused("referenced-elements"));
    let row = s(vec![json!("math:x"), m(&[("svg", json!("<g/>"))])]);
    let table = s(vec![row; super::MAX_FRAGMENTS + 1]);
    assert_eq!(answer(&note("x", &[("fragments", table)])), refused("fragments"));
    let families = s(vec![json!("Yomogi"); 64]);
    assert_eq!(answer(&note("x", &[("fontFamilies", families)])), refused("font-families"));
}

#[test]
fn a_markdown_request_is_read_strictly_by_its_kind() {
    let malformed = json!(["refused", "malformed", "request"]);
    assert_eq!(answer(&note("x", &[("kind", json!("canvas"))])), malformed);
    assert_eq!(answer(&note("x", &[("density", json!("compact"))])), malformed);
    let fields = [
        ("kind", json!("comment")),
        ("body", json!("x")),
        ("maxWidth", json!(200)),
        ("measure", fake()),
        ("density", json!("roomy")),
    ];
    assert_eq!(answer(&m(&fields).to_string()), malformed);
    let mut moded = fields.to_vec();
    moded[4] = ("density", json!("compact"));
    moded.push(("mode", json!("light")));
    assert_eq!(answer(&m(&moded).to_string()), malformed);
    let host = note("x", &[("measure", m(&[("kind", json!("host"))]))]);
    assert_eq!(answer(&host), json!(["refused", "malformed", "host-measure"]));
}

/// A note naming a surface keeps the bodies of the boards it embeds there.
#[test]
fn a_note_naming_a_surface_keeps_its_boards_bodies() {
    let surface = 0x5150_0018;
    let request =
        note("![[b]]", &[("references", board_wire(&["# Hi"])), ("cache", json!(surface))]);
    let first = answer(&request);
    assert_eq!(first.get(0), Some(&json!("ok")), "{first}");
    assert_eq!(resident().kept_by(surface), 1);
    assert_eq!(answer(&request), first);
    assert!(release_layout_cache(surface));
}
