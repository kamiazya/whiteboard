//! The OKF envelope by example: the fence, the routing, the schema's refusals
//! and the writer's order, each pinned to what the TypeScript does.

use whiteboard_codec::frontmatter::{Fault, Refusal, Unwritable, Value};
use whiteboard_codec::okf::{
    Code, Detail, Document, Failure, Issue, OkfMarkdownFrontmatter, OkfTrustEvent, Step,
    has_frontmatter, parse, parse_marked, serialize,
};
// On wasm32 the same tests run under Node (QR-21 layer 3).
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

fn read(text: &str) -> Document {
    let read = parse(text);
    assert!(read.is_ok(), "{text:?} is refused: {read:?}");
    read.unwrap_or_else(|_| unreachable!())
}

fn refusal(text: &str) -> Failure {
    let Err(why) = parse(text) else { unreachable!("{text:?} is read") };
    why
}

fn issues(text: &str) -> Vec<(String, Code)> {
    let Failure::Schema(found) = refusal(text) else {
        unreachable!("{text:?} is no schema refusal")
    };
    found.iter().map(|Issue { path, code, .. }| (path_text(path), *code)).collect()
}

fn path_text(path: &[Step]) -> String {
    let steps: Vec<String> = path
        .iter()
        .map(|step| match step {
            Step::Key(name) => name.clone(),
            Step::Index(at) => at.to_string(),
        })
        .collect();
    steps.join(".")
}

fn plain(r#type: &str) -> OkfMarkdownFrontmatter {
    OkfMarkdownFrontmatter { r#type: r#type.to_string(), ..OkfMarkdownFrontmatter::default() }
}

fn written(frontmatter: OkfMarkdownFrontmatter, body: &str) -> String {
    let out = serialize(&Document { frontmatter, body: body.to_string() });
    assert!(out.is_ok(), "{out:?}");
    out.unwrap_or_default()
}

fn text(s: &str) -> Value {
    Value::String(s.to_string())
}

#[test]
fn a_minimal_document_is_a_type_and_a_body() {
    let doc = read("---\ntype: note\n---\nbody");
    assert_eq!(doc, Document { frontmatter: plain("note"), body: "body".to_string() });
}

#[test]
fn the_first_dashes_after_a_line_break_close_the_block() {
    assert_eq!(read("---\ntype: a\n---body").body, "body");
    assert_eq!(read("---\ntype: a\n----\nbody").body, "-\nbody");
    assert_eq!(read("---\ntype: a\n---\n---\nx").body, "---\nx");
}

#[test]
fn one_carriage_return_and_one_line_feed_after_the_closing_dashes_are_dropped() {
    assert_eq!(read("---\ntype: a\n---\r\nbody").body, "body");
    assert_eq!(read("---\ntype: a\n---\rbody").body, "body");
    assert_eq!(read("---\ntype: a\n---\n\nbody").body, "\nbody");
    assert_eq!(read("---\ntype: a\n---\r\n\r\nbody").body, "\r\nbody");
}

#[test]
fn an_opening_fence_is_dashes_then_a_line_break() {
    assert_eq!(refusal("--\ntype: a\n---\nx"), Failure::NoFence);
    assert_eq!(refusal("---\rtype: a\n---\nx"), Failure::NoFence);
    assert_eq!(refusal(" ---\ntype: a\n---\nx"), Failure::NoFence);
    assert_eq!(read("---\r\ntype: a\r\n---\r\nx").body, "x");
}

#[test]
fn a_block_with_nothing_in_it_needs_a_blank_line_between_the_fences() {
    assert_eq!(refusal("---\n---\n"), Failure::NoFence);
    assert_eq!(issues("---\n\n---\n"), [(String::new(), Code::InvalidType)]);
    assert_eq!(refusal("---\ntype: a"), Failure::NoFence);
}

#[test]
fn has_frontmatter_answers_for_a_block_that_opens_whatever_it_holds() {
    assert!(has_frontmatter("---\ntype: a\n---\n"));
    assert!(has_frontmatter("---\n[unclosed\n---\n"));
    assert!(!has_frontmatter("type: a\n---\n"));
    assert!(!has_frontmatter(""));
}

#[test]
fn a_yaml_refusal_names_the_readers_class() {
    assert!(matches!(refusal("---\ntype: [open\n---\n"), Failure::Yaml(Refusal::Syntax(_))));
    assert_eq!(refusal("---\ntype: &a x\n---\n"), Failure::Yaml(Refusal::Anchor));
    assert!(matches!(refusal("---\ntype: !!str x\n---\n"), Failure::Yaml(Refusal::Subset(_))));
}

#[test]
fn a_reserved_key_at_any_depth_is_refused_before_the_schema() {
    for text in [
        "---\n__proto__: 1\n---\n",
        "---\ntype: a\nx:\n  __proto__: 1\n---\n",
        "---\ntype: a\nx: [{__proto__: 1}]\n---\n",
        "---\ntype: a\nx: {\"__proto__\": 1}\n---\n",
    ] {
        assert_eq!(refusal(text), Failure::ReservedKey, "{text:?}");
    }
    assert!(parse("---\ntype: a\n__proto__x: 1\n---\n").is_ok());
}

#[test]
fn keys_the_schema_does_not_model_are_kept_in_facets_raw() {
    let doc = read("---\nstatus: draft\ntype: a\nfacetsRaw: 1\n---\n");
    let raw = doc.frontmatter.facets_raw.expect("the unknown keys are kept");
    assert_eq!(
        raw,
        [("status".to_string(), text("draft")), ("facetsRaw".to_string(), Value::Number(1.0))]
    );
    assert_eq!(read("---\ntype: a\n---\n").frontmatter.facets_raw, None);
}

#[test]
fn keys_come_in_the_order_javascript_enumerates_them() {
    let doc =
        read("---\ntype: a\nb: 1\n10: 2\n2: 3\n\"01\": 4\n4294967295: 5\n4294967294: 6\n---\n");
    let keys: Vec<String> =
        doc.frontmatter.facets_raw.unwrap_or_default().into_iter().map(|(k, _)| k).collect();
    assert_eq!(keys, ["2", "10", "4294967294", "b", "01", "4294967295"]);
}

#[test]
fn a_bare_verified_mapping_is_a_list_of_one() {
    let bare = read("---\ntype: a\nverified:\n  by: human:a\n  at: 2026-01-02T03:04:05Z\n---\n");
    let listed =
        read("---\ntype: a\nverified:\n  - by: human:a\n    at: 2026-01-02T03:04:05Z\n---\n");
    assert_eq!(bare, listed);
    let events = bare.frontmatter.verified.expect("a list of one");
    assert_eq!(events.len(), 1);
    assert_eq!(
        issues("---\ntype: a\nverified: 5\n---\n"),
        [("verified".to_string(), Code::InvalidType)]
    );
}

#[test]
fn a_trust_event_keeps_what_else_its_producer_wrote() {
    let doc = read(
        "---\ntype: a\ngenerated:\n  tool: x\n  by: agent/1\n  at: 2026-01-02T03:04:05Z\n  2: two\n---\n",
    );
    let event = doc.frontmatter.generated.expect("a generated event");
    assert_eq!(event.by, "agent/1");
    let kept: Vec<&str> = event.extra.iter().map(|(k, _)| k.as_str()).collect();
    assert_eq!(kept, ["2", "tool"]);
}

#[test]
fn the_schema_reports_every_field_it_refuses_in_its_own_order() {
    let found = issues("---\ntags: x\nview: 1\ntype: 5\ntitle: []\nfacets: 2\n---\n");
    let wanted: Vec<(String, Code)> = ["type", "title", "tags", "view", "facets"]
        .iter()
        .map(|k| (k.to_string(), Code::InvalidType))
        .collect();
    assert_eq!(found, wanted);
}

#[test]
fn a_type_that_is_missing_or_empty_is_refused() {
    assert_eq!(issues("---\ntitle: t\n---\n"), [("type".to_string(), Code::InvalidType)]);
    assert_eq!(issues("---\ntype: \"\"\n---\n"), [("type".to_string(), Code::TooSmall)]);
    assert_eq!(issues("---\ntype: null\n---\n"), [("type".to_string(), Code::InvalidType)]);
}

#[test]
fn a_value_with_a_length_is_measured_beside_the_type_error() {
    let both = [("type".to_string(), Code::InvalidType), ("type".to_string(), Code::TooSmall)];
    let one = [("type".to_string(), Code::InvalidType)];
    for (text, wanted) in [
        ("type: []", &both[..]),
        ("type: [a]", &one[..]),
        ("type: {}", &one[..]),
        ("type: {length: 0}", &both[..]),
        ("type: {length: 1}", &one[..]),
        ("type: {length: ' 0x10 '}", &one[..]),
        ("type: {length: abc}", &both[..]),
        ("type: {length: [[0]]}", &both[..]),
        ("type: {length: [1, 2]}", &both[..]),
        ("type: {length: [7]}", &one[..]),
        ("type: {length: null}", &both[..]),
        ("type: {length: .5}", &both[..]),
        ("type: {length: true}", &one[..]),
        ("type: {length: -9007199254740993}", &both[..]),
        ("type: {length: 9007199254740993}", &one[..]),
        ("type: {length: Infinity}", &one[..]),
        ("type: {length: '-Infinity'}", &both[..]),
        ("type: {length: '0b10'}", &one[..]),
        ("type: {length: '0o7'}", &one[..]),
        ("type: 5", &one[..]),
    ] {
        assert_eq!(issues(&format!("---\n{text}\n---\n")), wanted, "{text}");
    }
}

#[test]
fn an_actor_is_a_single_line_without_surrounding_white_space() {
    let at = "at: 2026-01-02T03:04:05Z";
    let by =
        |actor: &str| issues(&format!("---\ntype: a\ngenerated:\n  by: {actor}\n  {at}\n---\n"));
    let custom = [("generated.by".to_string(), Code::Custom)];
    assert_eq!(by("\" x\""), custom);
    assert_eq!(by("\"x\\u00a0\""), custom);
    assert_eq!(by("\"x\\u3000\""), custom);
    assert_eq!(by("\"\\ufeffx\""), custom);
    assert_eq!(by("\"a\\nb\""), custom);
    assert_eq!(by("\"\""), [("generated.by".to_string(), Code::TooSmall)]);
    assert_eq!(
        by("[]"),
        [
            ("generated.by".to_string(), Code::InvalidType),
            ("generated.by".to_string(), Code::TooSmall)
        ]
    );
    // U+0085 and U+180E are not white space to `trim`.
    assert!(parse(&format!("---\ntype: a\ngenerated:\n  by: \"\\u0085x\"\n  {at}\n---\n")).is_ok());
    assert!(parse(&format!("---\ntype: a\ngenerated:\n  by: \"x\\u180e\"\n  {at}\n---\n")).is_ok());
}

/// Whether a document whose `generated.by` is `actor` (an escaped double-quoted scalar) is read.
fn actor_is_read(actor: &str) -> bool {
    let at = "at: 2026-01-02T03:04:05Z";
    parse(&format!("---\ntype: a\ngenerated:\n  by: \"{actor}\"\n  {at}\n---\n")).is_ok()
}

#[test]
fn an_actor_is_trimmed_by_exactly_the_characters_javascript_trims() {
    let trimmed = [
        '\u{9}', '\u{b}', '\u{c}', '\u{d}', ' ', '\u{a0}', '\u{1680}', '\u{2000}', '\u{2005}',
        '\u{200a}', '\u{2028}', '\u{2029}', '\u{202f}', '\u{205f}', '\u{3000}', '\u{feff}',
    ];
    let kept = [
        '\u{8}', '\u{e}', '\u{1f}', '!', '\u{85}', '\u{a1}', '\u{167f}', '\u{1681}', '\u{180e}',
        '\u{1fff}', '\u{200b}', '\u{2027}', '\u{202a}', '\u{2030}', '\u{205e}', '\u{2060}',
        '\u{2fff}', '\u{3001}', '\u{fefe}', '\u{ff00}',
    ];
    let escaped = |c: char| format!("\\u{:04x}", u32::from(c));
    for c in trimmed {
        assert!(!actor_is_read(&format!("x{}", escaped(c))), "{c:?} trailing");
        assert!(!actor_is_read(&format!("{}x", escaped(c))), "{c:?} leading");
        // Inside, only a carriage return makes it two lines.
        assert_eq!(actor_is_read(&format!("x{}y", escaped(c))), c != '\u{d}', "{c:?} inside");
    }
    for c in kept {
        assert!(actor_is_read(&format!("x{}", escaped(c))), "{c:?} trailing");
        assert!(actor_is_read(&format!("{}x", escaped(c))), "{c:?} leading");
    }
}

#[test]
fn a_timestamp_has_an_explicit_utc_offset() {
    let stamp = |at: &str| {
        parse(&format!("---\ntype: a\ngenerated:\n  by: x\n  at: \"{at}\"\n---\n")).is_ok()
    };
    for good in [
        "2026-01-02T03:04:05Z",
        "2026-01-02T03:04:05.1Z",
        "2026-01-02T03:04:05-00:30",
        "2026-01-02T03:04:05.123456+09:00",
    ] {
        assert!(stamp(good), "{good}");
    }
    for bad in [
        "2026-01-02T03:04:05",
        "2026-01-02T03:04:05z",
        "2026-01-02T03:04:05.Z",
        "2026-01-02T03:04:05+0900",
        "2026-01-02T03:04:05Z ",
        "2026-01-02 03:04:05Z",
        "2026-01-02T03:04:05.1.2Z",
        "2026-01-02T03:04:0",
        "２026-01-02T03:04:05Z",
        "2026-01-02T03:04:05+0a:00",
    ] {
        assert!(!stamp(bad), "{bad:?}");
    }
}

#[test]
fn an_extension_facet_key_is_namespace_dot_name_slash_version() {
    let key = |k: &str| parse(&format!("---\ntype: a\nfacets:\n  \"{k}\": 1\n---\n")).is_ok();
    for good in ["visual.shape/v0", "a.b/v12", "x-y.z9/v1"] {
        assert!(key(good), "{good}");
    }
    for bad in [
        "plain",
        "Visual.shape/v0",
        "a.b/v",
        "a.b/vx",
        "a.b/v1x",
        "1a.b/v0",
        "a..b/v0",
        ".b/v0",
        "a./v0",
        "a.b/v0/v1",
        "é.b/v0",
        "a.b/v٣",
    ] {
        assert!(!key(bad), "{bad:?}");
    }
    assert_eq!(
        issues("---\ntype: a\nfacets:\n  Bad: 1\n  also: 2\n  ok.key/v1: 3\n---\n"),
        [("facets.Bad".to_string(), Code::Custom), ("facets.also".to_string(), Code::Custom)]
    );
}

#[test]
fn the_writer_puts_the_modelled_keys_first_then_preserved_keys_then_facets() {
    let mut fm = plain("note");
    fm.title = Some("t".to_string());
    fm.facets_raw = Some(vec![("z".to_string(), text("1")), ("a".to_string(), Value::Number(2.0))]);
    fm.facets = Some(vec![("b.c/v1".to_string(), text("y")), ("a.b/v0".to_string(), text("x"))]);
    let out = written(fm, "body\n");
    assert_eq!(
        out,
        "---\ntype: note\ntitle: t\na: 2\nz: \"1\"\nfacets:\n  a.b/v0: x\n  b.c/v1: y\n---\nbody\n"
    );
}

#[test]
fn the_writer_sorts_keys_by_utf16_code_unit_and_enumerates_indices_first() {
    let mut fm = plain("n");
    // U+FF5E is one unit above the surrogates; U+1F600 is two units that start below it.
    let keys = ["\u{ff5e}", "\u{1f600}", "b", "10", "2"];
    fm.facets_raw = Some(keys.iter().map(|k| ((*k).to_string(), Value::Null)).collect());
    let out = written(fm, "");
    assert_eq!(
        out,
        "---\n\"2\": null\n\"10\": null\ntype: n\nb: null\n\u{1f600}: null\n\u{ff5e}: null\n---\n"
    );
}

#[test]
fn a_preserved_key_that_is_modelled_takes_the_value_in_the_first_position() {
    let mut fm = plain("one");
    fm.title = Some("t".to_string());
    fm.facets_raw =
        Some(vec![("type".to_string(), text("two")), ("facets".to_string(), text("raw"))]);
    fm.facets = Some(vec![]);
    assert_eq!(written(fm, ""), "---\ntype: two\ntitle: t\nfacets: {}\n---\n");
}

#[test]
fn the_writer_keeps_a_trust_event_in_by_at_then_the_rest_with_indices_first() {
    let mut fm = plain("n");
    let extra = vec![("tool".to_string(), text("x")), ("1".to_string(), Value::Bool(true))];
    fm.verified = Some(vec![OkfTrustEvent {
        by: "human:a".to_string(),
        at: "2026-01-02T03:04:05Z".to_string(),
        extra,
    }]);
    assert_eq!(
        written(fm, ""),
        "---\ntype: n\nverified:\n  - \"1\": true\n    by: human:a\n    at: 2026-01-02T03:04:05Z\n    tool: x\n---\n"
    );
}

#[test]
fn the_body_is_written_as_it_was_given() {
    for body in ["", "\n", "a\r\nb\r\n", "---\nx\n---\n", "\u{feff}é😀"] {
        assert!(written(plain("n"), body).ends_with(&format!("\n---\n{body}")), "{body:?}");
    }
}

#[test]
fn a_frontmatter_with_no_spelling_is_refused_not_written_wrong() {
    let with = |value: Value| {
        let mut fm = plain("n");
        fm.facets_raw = Some(vec![("k".to_string(), value)]);
        serialize(&Document { frontmatter: fm, body: String::new() })
    };
    let at_k = |why| Err(vec![Fault { path: vec![Step::Key("k".to_string())], why }]);
    assert_eq!(with(Value::Number(f64::NAN)), at_k(Unwritable::Nan));
    assert_eq!(with(text("a\u{feff}")), at_k(Unwritable::ByteOrderMark));
    assert_eq!(with(Value::BigInt("9007199254740993".to_string())), at_k(Unwritable::BigInt));
    assert_eq!(
        with(Value::Map(vec![("__proto__".to_string(), Value::Null)])),
        Err(vec![Fault { path: vec![], why: Unwritable::ReservedKey }])
    );
    // Preserved keys are spread at the root and `facets` nests, as the paths show.
    let mut fm = plain("n");
    fm.facets = Some(vec![("k\u{feff}".to_string(), Value::Number(f64::INFINITY))]);
    let path = vec![Step::Key("facets".to_string())];
    assert_eq!(
        serialize(&Document { frontmatter: fm, body: String::new() }),
        Err(vec![
            Fault { path: path.clone(), why: Unwritable::ByteOrderMark },
            Fault {
                path: [path, vec![Step::Key("k\u{feff}".to_string())]].concat(),
                why: Unwritable::Infinity
            },
        ])
    );
}

#[test]
fn a_mark_in_a_string_or_a_key_is_the_refusal_of_a_lone_surrogate() {
    let subset = Err(Failure::Yaml(Refusal::Subset("a lone UTF-16 surrogate")));
    for text in [
        "---\ntype: a\u{e000}b\n---\n",
        "---\ntype: x\nk\u{e000}: 1\n---\n",
        "---\ntype: x\nfacets: {a.b/v1: [\"\u{e000}\"]}\n---\n",
        "---\ntype: x\nk: |\n  one\u{e000}\n---\n",
        // The YAML is read before the schema and the reserved key are asked.
        "---\ntype: 1\ntitle: \u{e000}\n---\n",
        "---\ntype: x\n__proto__: \u{e000}\n---\n",
    ] {
        assert_eq!(parse_marked(text, Some('\u{e000}')).map(|_| ()), subset.clone(), "{text:?}");
    }
}

#[test]
fn a_mark_in_a_comment_or_the_body_is_nothing() {
    for text in [
        "---\ntype: x # a\u{e000}\n---\nbody",
        "---\n# \u{e000}\ntype: x\n---\n",
        "---\ntype: x\n---\nthe \u{e000} body",
    ] {
        assert!(parse_marked(text, Some('\u{e000}')).is_ok(), "{text:?}");
    }
    // Without a mark the same character is just text, as it is in the TypeScript.
    assert!(parse_marked("---\ntype: a\u{e000}b\n---\n", None).is_ok());
}

#[test]
fn another_yaml_fault_is_named_before_the_mark_is_looked_for() {
    let read = parse_marked("---\na: [\u{e000}\n---\n", Some('\u{e000}'));
    assert!(matches!(read, Err(Failure::Yaml(Refusal::Syntax(_)))), "{read:?}");
}

#[test]
fn an_invalid_type_names_what_was_expected_and_what_came() {
    let received = |value: &str| {
        let Failure::Schema(found) = refusal(&format!("---\ntype: x\ntitle: {value}\n---\n"))
        else {
            unreachable!("{value} is no schema refusal")
        };
        match found[0].detail {
            Detail::Type { expected: "string", received } => received,
            other => unreachable!("{other:?}"),
        }
    };
    for (value, named) in [
        ("true", "boolean"),
        ("~", "null"),
        ("[a]", "array"),
        ("{a: b}", "object"),
        (".nan", "NaN"),
        (".inf", "Infinity"),
        ("-.inf", "-Infinity"),
        ("99999999999999999999", "bigint"),
        ("1.5", "number"),
    ] {
        assert_eq!(received(value), named, "{value}");
    }
}
