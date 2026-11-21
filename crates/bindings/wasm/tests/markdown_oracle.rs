//! The markdown entry of `layout_spatial_canvas` against the recorded
//! TypeScript answers.
//!
//! canvas-render's `layout-markdown-recorded-oracle.test.ts` writes one file
//! per surface a root lays a markdown body out on,
//! `packages/canvas-render/src/oracle/layout-markdown.<surface>.jsonl`: a meta
//! line holding the reference wire, the fragment table and the tag library,
//! then per record the body and the options the surface hands, and the scene
//! the TypeScript laid out, as text or, past a length, as its length and FNV
//! digest. This builds each record's request as a root would, answers the
//! fences the core asks for from `layout-markdown-fences.jsonl` as the shim
//! answers them from its highlighter, and holds the core's scene to the
//! recorded one: a text compared as JSON values, a digest byte for byte.
//!
//! A body past the markdown parser's bounds is drawn by the core as its literal
//! text (owner decision q81, D7a), where the TypeScript drew remark's reading of
//! it; those records are a tolerated class, listed in `TOLERATED`: each must be
//! answered with a scene AND differ from the recording, so the list cannot
//! outlive its cause.

use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use serde_json::{Value as Json, json};
use whiteboard_model::Value;
use whiteboard_wasm::json_canvas_wire::value_json;
use whiteboard_wasm::spatial_layout::layout_spatial_canvas;

/// The bodies the parser refuses, by name: a nesting or delimiter-run bound
/// past which the core draws the literal text rather than read the body
/// differently. Every record of these, on every surface, differs from the
/// recording, and no other does.
/// The recorded notes that embed a document the host holds only a name for: the
/// TypeScript drew its placeholder with the reference id, the core with the name,
/// so each must differ from the recording, at that one node's title and nowhere else.
const NAMED_EMBEDS: &[&str] = &[
    "daemon/embed parts#1",
    "daemon/embed parts#2",
    "daemon/embed parts#3",
    "preview/embed parts#0",
    "preview/embed parts#1",
    "thumbnail/embed parts#0",
    "thumbnail/embed parts#1",
];

const TOLERATED: &[&str] = &[
    "quote 33 deep",
    "list 39 deep",
    "list 40 deep",
    "1024 delimiter runs",
    "1100 delimiter runs",
];

/// The body a record's id names: what follows its surface, less its variant.
fn body_name(id: &str) -> &str {
    let named = id.split_once('/').map_or(id, |(_, rest)| rest);
    named.split_once('#').map_or(named, |(name, _)| name)
}

fn oracle_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../packages/canvas-render/src/oracle")
}

fn read(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_default()
}

/// A JSON line read as `JSON.parse` reads it, keys in written order.
fn parse(line: &str) -> Value {
    whiteboard_model::json::parse(line).unwrap_or_default()
}

fn get<'v>(value: &'v Value, key: &str) -> Option<&'v Value> {
    match value {
        Value::Map(entries) => entries.iter().find(|(k, _)| k == key).map(|(_, v)| v),
        _ => None,
    }
}

fn text(value: &Value, key: &str) -> Option<String> {
    match get(value, key)? {
        Value::String(s) => Some(s.clone()),
        _ => None,
    }
}

fn s(value: &str) -> Value {
    Value::String(value.to_owned())
}

/// The fields a note's request takes from its record and the file's meta line.
fn note_fields(record: &Value, meta: &Value, fields: &mut Vec<(String, Value)>) {
    let mut put = |key: &str, value: Value| fields.push((key.to_owned(), value));
    put("mode", s(&text(record, "mode").unwrap_or_else(|| "light".to_owned())));
    let style = if text(record, "surface").as_deref() == Some("daemon") {
        text(record, "style")
    } else {
        Some("document".to_owned())
    };
    if let Some(style) = style {
        put("style", s(&style));
    }
    if let Some(fonts) = get(record, "fonts") {
        put("fontFamilies", fonts.clone());
    }
    if get(record, "references") == Some(&Value::Bool(true)) {
        put("references", get(meta, "references").cloned().unwrap_or_default());
    }
    if get(record, "library") == Some(&Value::Bool(true)) {
        put("tagLibrary", get(meta, "library").cloned().unwrap_or_default());
    }
    match text(record, "fragments").as_deref() {
        Some("full") => put("fragments", get(meta, "fragments").cloned().unwrap_or_default()),
        Some(_) => put("fragments", Value::Seq(Vec::new())),
        None => {}
    }
    if let Some(section) = text(record, "section") {
        put("section", s(&section));
    }
}

/// The request a root sends for a record, as the value wire's JSON.
fn request_of(record: &Value, meta: &Value) -> Json {
    let surface = text(record, "surface").unwrap_or_default();
    let comment = surface == "comment";
    let mut fields = vec![
        ("kind".to_owned(), s(if comment { "comment" } else { "markdown" })),
        ("body".to_owned(), get(record, "body").cloned().unwrap_or_default()),
        ("maxWidth".to_owned(), get(record, "maxWidth").cloned().unwrap_or_default()),
        (
            "measure".to_owned(),
            Value::Map(vec![
                ("kind".to_owned(), s("fake")),
                ("factor".to_owned(), Value::Number(0.6)),
            ]),
        ),
    ];
    if comment {
        let density = text(record, "density").unwrap_or_else(|| "comfortable".to_owned());
        fields.push(("density".to_owned(), s(&density)));
    } else {
        note_fields(record, meta, &mut fields);
    }
    value_json(&Value::Map(fields))
}

/// The request with the recorded tokens of `fences` as its `codeTokens`.
fn with_tokens(mut request: Json, fences: &[Json], table: &[Json]) -> Json {
    let rows = fences.iter().map(|fence| {
        let found =
            table.iter().find(|row| row.get(0) == fence.get(0) && row.get(1) == fence.get(1));
        // A fence the table lacks is sent plain, and the scene then differs.
        let tokens = found.map_or(Value::Null, |row| parse(&row[2].to_string()));
        value_json(&Value::Seq(vec![
            s(fence[0].as_str().unwrap_or_default()),
            s(fence[1].as_str().unwrap_or_default()),
            tokens,
        ]))
    });
    let mut rows: Vec<Json> = rows.collect();
    rows.insert(0, json!("s"));
    if let Json::Array(items) = &mut request {
        items.extend([json!("codeTokens"), Json::Array(rows)]);
    }
    request
}

/// The core's answer as text, a second call sending the fences it asked for.
fn answer(record: &Value, meta: &Value, table: &[Json]) -> String {
    let request = request_of(record, meta);
    let first = layout_spatial_canvas(&request.to_string(), None);
    let asked: Json = serde_json::from_str(&first).unwrap_or(Json::Null);
    if asked.get(0) != Some(&json!("needs")) {
        return first;
    }
    let fences = asked[1]["code"].as_array().cloned().unwrap_or_default();
    let again = with_tokens(request, &fences, table);
    layout_spatial_canvas(&again.to_string(), None)
}

/// The scene's own text in an `ok` answer, which the block lines (bare
/// numbers, where a canvas answers its anchors) follow.
fn scene_text(answer: &str) -> &str {
    let lines_follow = |rest: &str| {
        rest.split_once("],[")
            .is_some_and(|(lines, _)| lines.bytes().all(|b| b.is_ascii_digit() || b == b','))
    };
    let end = answer
        .rmatch_indices("},[")
        .map(|(at, _)| at)
        .find(|&at| lines_follow(answer.get(at + 3..).unwrap_or_default()))
        .map_or(0, |at| at + 1);
    answer.get(6..end).unwrap_or_default()
}

/// One JSON value of the core's text, its numbers kept as spelled.
enum Raw {
    Atom(String),
    Text(String),
    List(Vec<Raw>),
    Object(Vec<(String, Raw)>),
}

/// The value at the front of `text`, and the rest.
fn raw(text: &str) -> (Raw, &str) {
    let text = text.trim_start();
    match text.as_bytes().first() {
        Some(b'"') => {
            let mut de = serde_json::Deserializer::from_str(text).into_iter::<String>();
            let value = de.next().and_then(Result::ok).unwrap_or_default();
            (Raw::Text(value), &text[de.byte_offset()..])
        }
        Some(b'[') => {
            let (mut items, mut rest) = (Vec::new(), &text[1..]);
            while !rest.trim_start().is_empty() && !rest.trim_start().starts_with(']') {
                let (item, after) = raw(rest.trim_start().trim_start_matches(','));
                items.push(item);
                rest = after.trim_start();
            }
            (Raw::List(items), rest.trim_start().get(1..).unwrap_or_default())
        }
        Some(b'{') => {
            let (mut fields, mut rest) = (Vec::new(), &text[1..]);
            while !rest.trim_start().is_empty() && !rest.trim_start().starts_with('}') {
                let (Raw::Text(key), after) = raw(rest.trim_start().trim_start_matches(',')) else {
                    break;
                };
                let (item, after) = raw(after.trim_start().trim_start_matches(':'));
                fields.push((key, item));
                rest = after.trim_start();
            }
            (Raw::Object(fields), rest.trim_start().get(1..).unwrap_or_default())
        }
        _ => {
            let end = text.find([',', ']', '}']).unwrap_or(text.len());
            (Raw::Atom(text[..end].to_owned()), &text[end..])
        }
    }
}

/// A string as `JSON.stringify` writes it.
fn js_string(value: &str, out: &mut String) {
    out.push('"');
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            c if u32::from(c) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", u32::from(c));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// `value` written with every object's keys sorted, as the digests are taken.
fn sorted(value: &Raw, out: &mut String) {
    match value {
        Raw::Atom(atom) => out.push_str(atom),
        Raw::Text(text) => js_string(text, out),
        Raw::List(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                sorted(item, out);
            }
            out.push(']');
        }
        Raw::Object(fields) => {
            let mut fields: Vec<&(String, Raw)> = fields.iter().collect();
            fields.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
            out.push('{');
            for (i, (key, item)) in fields.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                js_string(key, out);
                out.push(':');
                sorted(item, out);
            }
            out.push('}');
        }
    }
}

fn fnv(text: &str) -> u32 {
    text.encode_utf16()
        .fold(0x811c_9dc5_u32, |state, unit| (state ^ u32::from(unit)).wrapping_mul(16_777_619))
}

/// The first place two values part, as a JSON pointer.
fn first_difference(a: &Json, b: &Json, at: &str) -> Option<String> {
    match (a, b) {
        (Json::Array(x), Json::Array(y)) if x.len() == y.len() => x
            .iter()
            .zip(y)
            .enumerate()
            .find_map(|(i, (p, q))| first_difference(p, q, &format!("{at}/{i}"))),
        (Json::Object(x), Json::Object(y)) if x.len() == y.len() => x.iter().find_map(|(k, p)| {
            y.get(k).map_or_else(
                || Some(format!("{at}/{k}")),
                |q| first_difference(p, q, &format!("{at}/{k}")),
            )
        }),
        _ => (a != b).then(|| at.to_owned()),
    }
}

/// How the core's answer, `raw`, differs from the recorded `line`, if it
/// does; a digest record is held to its row of `digests`.
fn judge(line: &str, raw: &str, digests: &[Json]) -> Option<String> {
    let got: Json = serde_json::from_str(raw).unwrap_or(Json::Null);
    let recorded: Json = serde_json::from_str(line).unwrap_or(Json::Null);
    if recorded.get("refused").is_some() {
        return (got != json!(["missing", "section"])).then(|| format!("answered {got}"));
    }
    if got.get(0) != Some(&json!("ok")) {
        return Some(format!("answered {}", raw.chars().take(200).collect::<String>()));
    }
    let asked = recorded.get("asked");
    if asked != got.get(4) {
        return Some(format!("asked {:?}, recorded {asked:?}", got.get(4)));
    }
    if let Some(scene) = recorded.get("scene").and_then(Json::as_str) {
        let want: Json = serde_json::from_str(scene).unwrap_or(Json::Null);
        let at = first_difference(&got[1], &want, "")?;
        let part = |v: &Json| v.pointer(&at).map(ToString::to_string).unwrap_or_default();
        return Some(format!("at {at}: got {} recorded {}", part(&got[1]), part(&want)));
    }
    let row = digests.iter().find(|row| row.get("id") == recorded.get("id"));
    let mut text = String::new();
    sorted(&self::raw(scene_text(raw)).0, &mut text);
    let mine = (json!(text.encode_utf16().count()), json!(fnv(&text)));
    let held = row.map(|row| (row["n"].clone(), row["h"].clone()));
    // Sorting moves no character, so the length is the recorded one too.
    (held != Some(mine.clone()) || recorded["n"] != mine.0)
        .then(|| format!("digest {mine:?}, recorded {held:?} and n {}", recorded["n"]))
}

fn jsonl(path: &Path) -> Vec<Json> {
    read(path).lines().map(|line| serde_json::from_str(line).unwrap_or(Json::Null)).collect()
}

#[test]
fn every_recorded_markdown_layout_is_answered_as_the_typescript_answered_it() {
    let dir = oracle_dir();
    let table = jsonl(&dir.join("layout-markdown-fences.jsonl"));
    let digests = jsonl(&dir.join("layout-markdown-digests.jsonl"));
    let mut failures = Vec::new();
    let mut by_surface = Vec::new();
    let (mut total, mut literal, mut named) = (0_usize, 0_usize, 0_usize);
    for surface in ["comment", "daemon", "outline", "preview", "thumbnail"] {
        let file = read(&dir.join(format!("layout-markdown.{surface}.jsonl")));
        let mut lines = file.lines();
        let meta = parse(lines.next().unwrap_or_default());
        let (mut answered, mut tolerated) = (0_usize, 0_usize);
        for line in lines {
            let record = parse(line);
            let id = text(&record, "id").unwrap_or_default();
            let got = answer(&record, &meta, &table);
            if NAMED_EMBEDS.contains(&id.as_str()) {
                match judge(line, &got, &digests) {
                    Some(why) if why.starts_with("at /nodes/2/title:") => named += 1,
                    other => failures
                        .push(format!("{id}: expected a renamed placeholder, got {other:?}")),
                }
                continue;
            }
            if TOLERATED.contains(&body_name(&id)) {
                if !got.starts_with(r#"["ok","#) {
                    failures.push(format!("{id}: not drawn as its literal text: {got:.80}"));
                } else if judge(line, &got, &digests).is_none() {
                    failures
                        .push(format!("{id}: draws as the TypeScript did; drop it from TOLERATED"));
                } else {
                    tolerated += 1;
                }
                continue;
            }
            match judge(line, &got, &digests) {
                Some(why) => failures.push(format!("{id}: {why}")),
                None => answered += 1,
            }
        }
        by_surface.push(format!("{surface}: {answered} answered, {tolerated} tolerated"));
        total += answered;
        literal += tolerated;
    }
    // Every surface's hand and boundary bodies, and the repository's documents.
    assert_eq!(named, NAMED_EMBEDS.len(), "every renamed placeholder is answered");
    assert!(total >= 400 && literal == 50, "{}", by_surface.join("\n"));
    assert!(failures.is_empty(), "{} differ:\n{}", failures.len(), failures.join("\n"));
}
