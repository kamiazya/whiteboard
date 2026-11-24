use super::*;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

fn custom(path: Vec<PathStep>, message: &str) -> Issue {
    Issue { path, code: Code::Custom, message: Some(message.to_owned()) }
}

#[test]
fn a_refused_canvas_is_described_as_the_zod_errors_json() {
    let issues = [custom(
        vec![PathStep::Key("edges"), PathStep::Index(0), PathStep::Key("toNode")],
        "edge \"e\" references nonexistent toNode \"b\"",
    )];
    assert_eq!(
        serialize_failed("D", &issues).as_deref(),
        Some(concat!(
            r#"Document D cannot be read as JSON Canvas: {"name":"ZodError","message":"[\n  {\n    "#,
            r#"\"code\": \"custom\",\n    \"path\": [\n      \"edges\",\n      0,\n      \"toNode\"\n"#,
            r#"    ],\n    \"message\": \"edge \\\"e\\\" references nonexistent toNode \\\"b\\\"\"\n  }\n]"}."#,
            " Rewrite it with `wb_workspace_edit`'s `document.set` op to repair it."
        ))
    );
    assert_eq!(serialize_failed("D", &[]), None);
}

#[test]
fn an_issue_at_the_root_with_no_words_takes_the_shims() {
    let issue = Issue { path: Vec::new(), code: Code::TooBig, message: None };
    assert_eq!(
        listed(&[issue.clone(), issue]).as_deref(),
        Some(concat!(
            "[\n  {\n    \"code\": \"too_big\",\n    \"path\": [],\n    \"message\": \"Too big\"\n  },\n",
            "  {\n    \"code\": \"too_big\",\n    \"path\": [],\n    \"message\": \"Too big\"\n  }\n]"
        ))
    );
}

#[test]
fn each_code_zod_words_itself_has_the_shims_text() {
    let worded_as = [
        (Code::InvalidType, "Invalid input: wrong type"),
        (Code::TooSmall, "Too small"),
        (Code::TooBig, "Too big"),
        (Code::InvalidFormat, "Invalid string: wrong format"),
        (Code::InvalidValue, "Invalid option"),
        (Code::InvalidUnion, "Invalid input"),
        (Code::Custom, "Invalid input"),
    ];
    for (code, text) in worded_as {
        assert_eq!(worded(code), text);
    }
}

#[test]
fn a_description_is_cut_at_its_cap_in_utf16_units() {
    let at_cap = "a".repeat(DESCRIBE_THROWN_MAX);
    assert_eq!(described(&at_cap).as_deref(), Some(at_cap.as_str()));
    let over = format!("{}é", "a".repeat(DESCRIBE_THROWN_MAX));
    assert_eq!(described(&over), Some(format!("{at_cap}…")));
    // A pair ending at the cap is kept whole; one across it is no string.
    let pair_at_cap = format!("{}🎨", "a".repeat(DESCRIBE_THROWN_MAX - 2));
    assert_eq!(described(&format!("{pair_at_cap}b")), Some(format!("{pair_at_cap}…")));
    assert_eq!(described(&format!("{}🎨", "a".repeat(DESCRIBE_THROWN_MAX - 1))), None);
}
