//! The OKF envelope against the recorded TypeScript answers.
//!
//! `packages/codec/src/okf/oracle/okf-recorded-oracle.test.ts` writes
//! `okf.jsonl` from `parseOkf` and `serializeOkf` and fails when the file no
//! longer equals what the TypeScript answers; this replays it natively. One
//! JSON object per line. A reader case is the document text, `"t"` (with
//! `"lone"` listing the `[index, unit]` of each lone surrogate, which `"t"`
//! holds as U+FFFD), and `"ok"`, the document encoded as `common` encodes a
//! value, or `"err"`: the `stage`, a `class` and for `schema` each issue as
//! `[path, code]`. A writer case is `"d"`, the encoded document, and `"y"`,
//! the text, or `"err":"unsafe"`.
//!
//! Refusal messages are not recorded, so agreement is on the stage, the class
//! and where and why the schema refused. A text or a document that holds a
//! lone surrogate cannot be handed to Rust at all; the TypeScript refuses
//! one in the frontmatter, and the caller of the wasm export must too.

mod common;

use common::{decode, encode};
use serde_json::{Value as Json, json};
use whiteboard_codec::frontmatter::{Refusal, Unwritable, Value};
use whiteboard_codec::okf::{
    Code, Document, Failure, Frontmatter, Issue, Step, TrustEvent, parse, serialize,
};
// On wasm32 the same tests run under Node (QR-21 layer 3).
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

fn recording() -> Vec<Json> {
    let text = include_str!("../../../../packages/codec/src/okf/oracle/okf.jsonl");
    let lines: Result<Vec<Json>, _> = text.lines().map(serde_json::from_str).collect();
    assert!(
        lines.is_ok(),
        "the recording is not one JSON value per line: {:?}",
        lines.as_ref().err()
    );
    lines.unwrap_or_default()
}

fn text_of(entries: &[(&str, &Option<String>)]) -> Vec<(String, Value)> {
    entries
        .iter()
        .filter_map(|(name, held)| Some((name.to_string(), Value::String((*held).clone()?))))
        .collect()
}

fn event_value(event: &TrustEvent) -> Value {
    let named = [("by", &event.by), ("at", &event.at)]
        .map(|(name, held)| (name.to_string(), Value::String(held.clone())));
    Value::Map(named.into_iter().chain(event.extra.iter().cloned()).collect())
}

/// The object `parseOkf` hands back, field by field in the schema's order.
fn frontmatter_value(fm: &Frontmatter) -> Value {
    let mut entries = vec![("type".to_string(), Value::String(fm.r#type.clone()))];
    entries.extend(text_of(&[
        ("title", &fm.title),
        ("description", &fm.description),
        ("resource", &fm.resource),
    ]));
    if let Some(tags) = &fm.tags {
        let tags = tags.iter().cloned().map(Value::String).collect();
        entries.push(("tags".to_string(), Value::Seq(tags)));
    }
    entries.extend(text_of(&[("view", &fm.view)]));
    if let Some(event) = &fm.generated {
        entries.push(("generated".to_string(), event_value(event)));
    }
    if let Some(list) = &fm.verified {
        entries.push(("verified".to_string(), Value::Seq(list.iter().map(event_value).collect())));
    }
    if let Some(facets) = &fm.facets {
        entries.push(("facets".to_string(), Value::Map(facets.clone())));
    }
    if let Some(raw) = &fm.facets_raw {
        entries.push(("facetsRaw".to_string(), Value::Map(raw.clone())));
    }
    Value::Map(entries)
}

fn document_json(doc: &Document) -> Json {
    let body = Value::String(doc.body.clone());
    let both = vec![
        ("frontmatter".to_string(), frontmatter_value(&doc.frontmatter)),
        ("body".to_string(), body),
    ];
    encode(&Value::Map(both))
}

fn yaml_class(refusal: Refusal) -> &'static str {
    match refusal {
        Refusal::Syntax(_) | Refusal::TooLarge => "syntax",
        Refusal::Anchor => "anchor",
        Refusal::Depth => "depth",
        Refusal::Subset(_) => "subset",
    }
}

fn issue_json(issue: &Issue) -> Json {
    let path: Vec<Json> = issue
        .path
        .iter()
        .map(|step| match step {
            Step::Key(name) => json!(name),
            Step::Index(at) => json!(at),
        })
        .collect();
    let code = match issue.code {
        Code::InvalidType => "invalid_type",
        Code::TooSmall => "too_small",
        Code::InvalidFormat => "invalid_format",
        Code::Custom => "custom",
    };
    json!([path, code])
}

fn failure_json(failure: &Failure) -> Json {
    let schema = |class: &str| json!({"stage": "frontmatter-schema", "class": class});
    match failure {
        Failure::Yaml(refusal) => json!({"stage": "yaml", "class": yaml_class(*refusal)}),
        Failure::NoFence => schema("nofence"),
        Failure::ReservedKey => schema("reserved"),
        Failure::Schema(issues) => json!({
            "stage": "frontmatter-schema",
            "class": "schema",
            "issues": issues.iter().map(issue_json).collect::<Vec<_>>(),
        }),
    }
}

/// The recorded text, or `None` when it holds a lone surrogate.
fn text_of_case(case: &Json) -> Option<&str> {
    if case.get("lone").is_some() { None } else { case["t"].as_str() }
}

/// How Rust's answer for a recorded text stands against the recorded one.
fn reader_verdict(case: &Json, text: &str) -> String {
    match (parse(text), case.get("ok"), case.get("err")) {
        (Ok(doc), Some(ok), _) if &document_json(&doc) == ok => "value".to_string(),
        (Ok(_), Some(_), _) => format!("a different document: {text:?}"),
        (Ok(_), None, err) => format!("accepted, refused by the TypeScript as {err:?}: {text:?}"),
        (Err(why), None, Some(err)) if &failure_json(&why) == err => {
            format!("refusal as {}", class_name(err))
        }
        (Err(why), None, err) => {
            format!("refused as {why:?}, by the TypeScript as {err:?}: {text:?}")
        }
        (Err(why), Some(_), _) => format!("refused ({why:?}), read by the TypeScript: {text:?}"),
    }
}

fn class_name(err: &Json) -> String {
    format!(
        "{}/{}",
        err["stage"].as_str().unwrap_or_default(),
        err["class"].as_str().unwrap_or_default()
    )
}

#[test]
fn every_recorded_document_is_read_as_the_typescript_read_it() {
    let recording = recording();
    let cases: Vec<&Json> = recording.iter().filter(|c| c["k"] == "r").collect();
    let held: Vec<(&Json, &str)> =
        cases.iter().filter_map(|c| Some((*c, text_of_case(c)?))).collect();
    let verdicts: Vec<String> =
        held.iter().map(|(case, text)| reader_verdict(case, text)).collect();
    let agreed = |v: &String| v == "value" || v.starts_with("refusal as ");
    let disagreements: Vec<&String> = verdicts.iter().filter(|v| !agreed(v)).collect();
    assert!(
        disagreements.is_empty(),
        "{} of {} texts disagree, the first: {:#?}",
        disagreements.len(),
        held.len(),
        &disagreements[..disagreements.len().min(10)]
    );
    // An agreement over nothing passes, so say what the recording reached.
    let count = |what: &str| verdicts.iter().filter(|v| v.as_str() == what).count();
    assert!(held.len() > 1100, "{} replayed texts", held.len());
    assert!(
        cases.len() - held.len() > 20,
        "{} texts held a lone surrogate",
        cases.len() - held.len()
    );
    assert!(count("value") > 250, "{} texts read to a document", count("value"));
    for class in ["anchor", "depth", "subset", "syntax"] {
        let refused = count(&format!("refusal as yaml/{class}"));
        assert!(refused > 3, "{refused} texts refused as yaml/{class}");
    }
    for class in ["nofence", "reserved", "schema"] {
        let refused = count(&format!("refusal as frontmatter-schema/{class}"));
        assert!(refused > 8, "{refused} texts refused as {class}");
    }
}

#[test]
fn every_recorded_refusal_names_the_codes_the_schema_raises() {
    let recording = recording();
    let issues: Vec<&Json> = recording
        .iter()
        .filter(|c| c["k"] == "r")
        .filter_map(|c| c["err"]["issues"].as_array())
        .flatten()
        .collect();
    for code in ["invalid_type", "too_small", "invalid_format", "custom"] {
        let raised = issues.iter().filter(|i| i[1] == code).count();
        assert!(raised > 3, "{raised} issues coded {code}");
    }
}

fn text_field(object: &[(String, Value)], name: &str) -> Option<String> {
    match object.iter().find(|(k, _)| k == name)?.1 {
        Value::String(ref s) => Some(s.clone()),
        _ => None,
    }
}

fn field<'a>(object: &'a [(String, Value)], name: &str) -> Option<&'a Value> {
    object.iter().find(|(k, _)| k == name).map(|(_, v)| v)
}

fn map_of(value: &Value) -> Result<Vec<(String, Value)>, String> {
    match value {
        Value::Map(entries) => Ok(entries.clone()),
        other => Err(format!("{other:?} is no mapping")),
    }
}

fn event_of(value: &Value) -> Result<TrustEvent, String> {
    let entries = map_of(value)?;
    let named = |name: &str| text_field(&entries, name).ok_or(format!("an event without a {name}"));
    Ok(TrustEvent {
        by: named("by")?,
        at: named("at")?,
        extra: entries.iter().filter(|(k, _)| k != "by" && k != "at").cloned().collect(),
    })
}

fn strings_of(value: Option<&Value>) -> Option<Vec<String>> {
    let Some(Value::Seq(items)) = value else { return None };
    Some(
        items
            .iter()
            .map(|i| if let Value::String(s) = i { s.clone() } else { String::new() })
            .collect(),
    )
}

/// The document a recorded writer case stands for: `Ok(None)` when it holds a
/// lone surrogate, `Err` when the recording is not a document at all.
fn document_of(case: &Json) -> Result<Option<Document>, String> {
    let Some(value) = decode(&case["d"]) else { return Ok(None) };
    let whole = map_of(&value)?;
    let fm = map_of(field(&whole, "frontmatter").ok_or("no frontmatter")?)?;
    let verified = match field(&fm, "verified") {
        Some(Value::Seq(items)) => Some(items.iter().map(event_of).collect::<Result<_, _>>()?),
        _ => None,
    };
    let frontmatter = Frontmatter {
        r#type: text_field(&fm, "type").ok_or("no type")?,
        title: text_field(&fm, "title"),
        description: text_field(&fm, "description"),
        resource: text_field(&fm, "resource"),
        tags: strings_of(field(&fm, "tags")),
        view: text_field(&fm, "view"),
        generated: field(&fm, "generated").map(event_of).transpose()?,
        verified,
        facets: field(&fm, "facets").map(map_of).transpose()?,
        facets_raw: field(&fm, "facetsRaw").map(map_of).transpose()?,
    };
    Ok(Some(Document { frontmatter, body: text_field(&whole, "body").ok_or("no body")? }))
}

#[test]
fn every_recorded_document_is_written_as_the_typescript_wrote_it() {
    let recording = recording();
    let cases: Vec<&Json> = recording.iter().filter(|c| c["k"] == "w").collect();
    let mut problems: Vec<String> = Vec::new();
    let (mut written, mut unwritable, mut unrepresentable) = (0usize, 0usize, 0usize);
    for case in &cases {
        let Some(doc) = document_of(case).expect("a recorded document") else {
            unrepresentable += 1;
            assert!(case.get("err").is_some(), "a lone surrogate was written: {case}");
            continue;
        };
        match (serialize(&doc), case.get("y").and_then(Json::as_str), case.get("err")) {
            (Ok(text), Some(y), _) if text == y => written += 1,
            (Err(Unwritable::TooDeep), ..) => problems.push(format!("too deep: {case}")),
            (Err(_), None, Some(_)) => unwritable += 1,
            (answer, y, _) => {
                problems.push(format!("rust {answer:?}, typescript {y:?}, for {}", case["d"]));
            }
        }
    }
    assert!(
        problems.is_empty(),
        "{} of {} documents disagree, the first: {:#?}",
        problems.len(),
        cases.len(),
        &problems[..problems.len().min(5)]
    );
    assert!(written > 350, "{written} documents written");
    assert!(unwritable > 20, "{unwritable} documents refused");
    assert!(unrepresentable > 3, "{unrepresentable} documents held a lone surrogate");
}
