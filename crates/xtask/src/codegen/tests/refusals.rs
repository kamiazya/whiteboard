//! The refusals generator: what the contract's template language means, every
//! rule that refuses an entry, and what each language is given.

use super::*;

const CONTRACT: &str = r#"{
  "$comment": "c",
  "surfaces": { "api-v1": "the api", "sync-write": "sync" },
  "refusals": [
    {
      "name": "Greeted",
      "code": "greeted_thing",
      "status": 404,
      "family": "sync-write",
      "description": "Says hi.",
      "message": "Hi {name|json}, {count} item{count|s}: {items|list} {{ok}}",
      "params": { "name": "string", "count": "integer", "items": "string[]" },
      "example": { "name": "x", "count": 2, "items": ["a", "b"] },
      "exampleText": "Hi \"x\", 2 items: a, b {ok}",
      "surfaces": ["api-v1"],
      "source": "S"
    },
    {
      "name": "Plain",
      "code": "plain_thing",
      "status": 500,
      "description": "Plain.",
      "message": "It's plain {{.",
      "exampleText": "It's plain {.",
      "surfaces": ["api-v1", "sync-write"],
      "source": "S"
    },
    {
      "name": "Echo",
      "code": "greeted_thing",
      "status": 409,
      "family": "sync-write",
      "description": "Echoes.",
      "message": "{reason}",
      "params": { "reason": "string" },
      "example": { "reason": "because" },
      "exampleText": "because",
      "surfaces": ["api-v1"],
      "source": "S"
    }
  ]
}"#;

fn files(text: &str) -> Result<(String, String), Vec<String>> {
    let mut out = generate(text)?;
    let rust = out.remove(1).1;
    Ok((out.remove(0).1, rust))
}

fn mutated(from: &str, to: &str) -> String {
    let text = CONTRACT.replacen(from, to, 1);
    assert_ne!(text, CONTRACT, "{from} did not match");
    text
}

fn refused(from: &str, to: &str, expect: &str) {
    let errors = files(&mutated(from, to)).unwrap_err();
    assert!(errors.iter().any(|e| e.contains(expect)), "{expect}: {errors:?}");
}

#[test]
fn the_checked_in_contract_generates_both_halves() {
    let text = include_str!("../../../../../contracts/api/refusals.json");
    let (ts, rust) = files(text).unwrap();
    assert!(ts.contains("export const REFUSALS = {"));
    assert!(rust.contains("pub enum Refusal {"));
}

#[test]
fn the_typescript_half_carries_the_table_the_params_and_the_codes() {
    let (ts, _) = files(CONTRACT).unwrap();
    for wanted in [
        "/** Says hi. */\n  Greeted: {\n    code: 'greeted_thing',\n    status: 404,\n",
        "    message: 'Hi {name|json}, {count} item{count|s}: {items|list} {{ok}}',\n",
        "    message: \"It's plain {{.\",\n",
        "export type RefusalName = keyof typeof REFUSALS\n",
        "  Greeted: {\n    readonly count: number\n    readonly items: readonly string[]\n    readonly name: string\n  }\n",
        "  Plain: Record<never, never>\n",
        "export const REFUSAL_CODES = {\n  greetedThing: 'greeted_thing',\n  plainThing: 'plain_thing',\n} as const\n",
        "export type RefusalCode = (typeof REFUSAL_CODES)[keyof typeof REFUSAL_CODES]\n",
        "export const SYNC_WRITE_REFUSAL_CODES = ['greeted_thing'] as const\n",
        "export const VERSION_REFUSAL_CODES = [] as const\n",
    ] {
        assert!(ts.contains(wanted), "{wanted}\n{ts}");
    }
}

#[test]
fn the_rust_half_compiles_each_template_into_its_own_formatting() {
    let (_, rust) = files(CONTRACT).unwrap();
    for wanted in [
        "    /// Says hi.\n    Greeted {\n        count: u64,\n        items: Vec<String>,\n        name: String,\n    },\n",
        "    Plain,\n",
        "pub const GREETED_THING: &str = \"greeted_thing\";",
        "pub const CODES: &[&str] = &[code::GREETED_THING, code::PLAIN_THING];",
        "pub const SYNC_WRITE_CODES: &[&str] = &[code::GREETED_THING];",
        "pub const VERSION_CODES: &[&str] = &[];",
        "Self::Greeted { .. } | Self::Echo { .. } => code::GREETED_THING,",
        "Self::Plain => code::PLAIN_THING,",
        "Self::Greeted { .. } => 404,",
        "Self::Plain => \"It's plain {.\".to_owned(),",
        "Self::Echo { reason } => reason.clone(),",
        "{items_list} {{ok}}\", name_json = json(name), count_s = plural_s(*count), items_list = list(items))",
        "(\"Greeted\", Refusal::Greeted { count: 2, items: vec![\"a\".to_owned(), \"b\".to_owned()], name: \"x\".to_owned() }),",
        "(\"Plain\", Refusal::Plain),",
        "f.write_str(&self.message())",
    ] {
        assert!(rust.contains(wanted), "{wanted}\n{rust}");
    }
}

#[test]
fn a_filter_applied_twice_to_one_param_is_bound_once() {
    let text = mutated("{count} item{count|s}", "{count|s}{count|s}{count}")
        .replace("Hi \\\"x\\\", 2 items", "Hi \\\"x\\\", ss2");
    let (_, rust) = files(&text).unwrap();
    assert_eq!(rust.matches("count_s = plural_s(*count)").count(), 1, "{rust}");
}

#[test]
fn every_rule_that_refuses_an_entry_names_it() {
    for (from, to, expect) in [
        (r#""name": "Plain""#, r#""name": "Greeted""#, "Greeted is declared twice"),
        (r#""name": "Plain""#, r#""name": "plain""#, "name is not PascalCase"),
        (r#""name": "Plain""#, r#""name": "Pl_ain""#, "name is not PascalCase"),
        (r#""code": "plain_thing""#, r#""code": "Plain""#, "is not lowercase snake_case"),
        (r#""code": "plain_thing""#, r#""code": "plain_""#, "is not lowercase snake_case"),
        (r#""code": "plain_thing""#, r#""code": "plain__thing""#, "is not lowercase snake_case"),
        (r#""code": "plain_thing""#, r#""code": "plain-thing""#, "is not lowercase snake_case"),
        (r#""code": "plain_thing""#, r#""code": "9plain""#, "is not lowercase snake_case"),
        (r#""status": 500"#, r#""status": 418"#, "status 418"),
        (r#""source": "S""#, r#""source": " ""#, "description and source"),
        (r#""description": "Plain.""#, r#""description": "  ""#, "description and source"),
        (r#""surfaces": ["api-v1", "sync-write"]"#, r#""surfaces": []"#, "surfaces is empty"),
        (
            r#""surfaces": ["api-v1", "sync-write"]"#,
            r#""surfaces": ["api-v1", "api-v1"]"#,
            "names one twice",
        ),
        (
            r#""surfaces": ["api-v1", "sync-write"]"#,
            r#""surfaces": ["nowhere"]"#,
            "`nowhere` is not declared",
        ),
        (
            r#""family": "sync-write",
      "description": "Says"#,
            r#""family": "other",
      "description": "Says"#,
            "family `other`",
        ),
        (
            r#""family": "sync-write",
      "description": "Echoes"#,
            r#""description": "Echoes"#,
            "in a family in one entry only",
        ),
        (r#""name": "string""#, r#""name": "text""#, "no type `text`"),
        ("{items|list}", "{other|list}", "message names `other`"),
        (
            r#""count": "integer", "#,
            r#""count": "integer", "self": "string", "#,
            "not a name both languages take",
        ),
        (
            r#""count": "integer", "#,
            r#""count": "integer", "Bad": "string", "#,
            "not a name both languages take",
        ),
        (r"{items|list}", r"{items}", "`items` is a readonly string[], which `no filter`"),
        (r"{name|json}", r"{name|s}", "which `s` does not take"),
        (r"{name|json}", r"{name|nope}", "`nope` is not a filter"),
        (r"{name|json}", r"{Name}", "`Name` is not a param name"),
        (r"{{ok}}", r"{x", "never closed"),
        (r"{{ok}}", r"{{ok}", "closes nothing"),
        (r"{{ok}}", r"ok}", "closes nothing"),
        (r#""message": "{reason}""#, r#""message": """#, "message is empty"),
        (r"{{ok}}", r"\\n", "backslash or a control"),
        (
            r#""example": { "name": "x", "count": 2, "items": ["a", "b"] }"#,
            r#""example": { "name": "x", "count": 2 }"#,
            "other params",
        ),
        (r#""count": 2"#, r#""count": "2""#, "example `count` is not a number"),
        (r#""count": 2"#, r#""count": -1"#, "example `count`"),
        (r#""count": 2"#, r#""count": 9007199254740992"#, "example `count`"),
        (r#""name": "x""#, r#""name": 3"#, "example `name` is not a string"),
        (r#"["a", "b"]"#, r#"["a", 1]"#, "example `items`"),
        (
            r#""exampleText": "because""#,
            r#""exampleText": "Because""#,
            "exampleText is not what the example renders: because",
        ),
        (r#""exampleText": "It's plain {.""#, r#""exampleText": "x""#, "renders: It's plain {."),
        (r#""name": "Greeted""#, r#""nom": "Greeted""#, "not the refusals contract"),
    ] {
        refused(from, to, expect);
    }
}

#[test]
fn the_exact_boundaries_of_an_example_integer_and_a_status_are_taken() {
    let text = mutated(r#""count": 2"#, r#""count": 9007199254740991"#);
    let said = files(&text).unwrap_err().join(" ");
    assert!(said.contains("exampleText is not what the example renders"), "{said}");
    for status in [400, 404, 409, 413, 500, 503] {
        let text = CONTRACT.replacen(r#""status": 500"#, &format!(r#""status": {status}"#), 1);
        assert!(files(&text).is_ok(), "{status}");
    }
}

#[test]
fn a_family_must_be_one_the_generator_knows() {
    for family in ["sync-write", "version"] {
        let text =
            CONTRACT.replace("\"family\": \"sync-write\"", &format!("\"family\": \"{family}\""));
        assert!(files(&text).is_ok(), "{family}");
    }
}

#[test]
fn the_template_language_reads_braces_filters_and_text() {
    assert_eq!(
        parse_template("a {x|json} {{b}} {y}").unwrap(),
        vec![
            Piece::Text("a ".to_owned()),
            Piece::Param { name: "x".to_owned(), filter: Some(Filter::Json) },
            Piece::Text(" {b} ".to_owned()),
            Piece::Param { name: "y".to_owned(), filter: None },
        ]
    );
    assert_eq!(parse_template("").unwrap(), vec![]);
    for (name, filter) in Filter::ALL {
        assert_eq!(Filter::parse(name), Ok(*filter));
        assert_eq!(filter.name(), *name);
    }
}

fn example(
    pairs: &[(&str, serde_json::Value)],
) -> std::collections::BTreeMap<String, serde_json::Value> {
    pairs.iter().map(|(k, v)| ((*k).to_owned(), v.clone())).collect()
}

#[test]
fn each_filter_does_what_its_javascript_does() {
    use serde_json::json;
    let say = |filter: Filter, value: serde_json::Value| apply(filter, &value).unwrap();
    assert_eq!(
        say(Filter::Json, json!("a\"b\\c\n\u{1}\u{7f}é")),
        "\"a\\\"b\\\\c\\n\\u0001\u{7f}é\""
    );
    assert_eq!(say(Filter::Trim, json!("\u{feff} \u{a0}x y\u{2029}\t")), "x y");
    assert_eq!(say(Filter::Trim, json!("\u{85}x\u{85}")), "\u{85}x\u{85}");
    assert_eq!(say(Filter::S, json!(1)), "");
    assert_eq!(say(Filter::S, json!(0)), "s");
    assert_eq!(say(Filter::S, json!(2)), "s");
    assert_eq!(say(Filter::List, json!(["a", "b"])), "a, b");
    assert_eq!(say(Filter::AndList, json!(["a", "b"])), "a and b");
    assert_eq!(say(Filter::JsonList, json!(["a\"", "b"])), "\"a\\\"\", \"b\"");
    assert_eq!(say(Filter::QuotedList, json!(["a\"", "b"])), "\"a\"\", \"b\"");
    assert!(apply(Filter::Json, &json!(1)).is_err());
    assert!(apply(Filter::List, &json!("a")).is_err());
    assert!(apply(Filter::List, &json!(["a", 1])).is_err());
    let pieces = parse_template("{n} {s}").unwrap();
    assert_eq!(render(&pieces, &example(&[("n", json!(7)), ("s", json!("t"))])).unwrap(), "7 t");
    assert!(render(&pieces, &example(&[("n", json!(7))])).is_err());
}

#[test]
fn names_and_codes_convert_between_their_spellings() {
    assert_eq!(camel_of_code("too_many_open_threads"), "tooManyOpenThreads");
    assert_eq!(camel_of_code("a1_b2"), "a1B2");
    assert_eq!(snake_of_camel("nodeId"), "node_id");
    assert_eq!(snake_of_camel("limit"), "limit");
    assert!(is_camel("a1") && !is_camel("A1") && !is_camel("a_1") && !is_camel(""));
    assert!(is_pascal("A1") && !is_pascal("a1") && !is_pascal("A_1") && !is_pascal(""));
    assert!(is_code("a_1") && !is_code("_a") && !is_code("a_") && !is_code("A"));
}

#[test]
fn literals_are_written_as_the_formatters_of_each_language_write_them() {
    assert_eq!(ts_literal("plain"), "'plain'");
    assert_eq!(ts_literal("it's"), "\"it's\"");
    assert_eq!(ts_literal("say \"hi\""), "'say \"hi\"'");
    assert_eq!(ts_literal("it's \"x\""), "'it\\'s \"x\"'");
    assert_eq!(ts_literal("it's a 'b' \"c\""), "\"it's a 'b' \\\"c\\\"\"");
    assert_eq!(rust_literal("a\"b\\c\nd\u{1}é"), "\"a\\\"b\\\\c\\nd\\u{1}é\"");
}

#[test]
fn a_property_string_moves_under_its_key_only_when_the_line_is_full() {
    let mut out = String::new();
    ts_property(&mut out, 4, "message", &ts_literal(&"x".repeat(100 - 4 - 9 - 2 - 1)));
    assert!(out.starts_with("    message: '"), "{out}");
    let mut out = String::new();
    ts_property(&mut out, 4, "message", &ts_literal(&"x".repeat(100 - 4 - 9 - 2)));
    assert!(out.starts_with("    message:\n      '"), "{out}");
}

#[test]
fn an_array_stays_on_one_line_while_it_fits_and_otherwise_takes_a_line_each() {
    let mut out = String::new();
    ts_array(&mut out, "export const A = ", &["a", "b"]);
    assert_eq!(out, "export const A = ['a', 'b'] as const\n");
    let long = "x".repeat(90);
    let mut out = String::new();
    ts_array(&mut out, "export const A = ", &[&long, "b"]);
    assert_eq!(out, format!("export const A = [\n  '{long}',\n  'b',\n] as const\n"));
    let mut out = String::new();
    let exact = "x".repeat(100 - "export const A = ['".len() - "'] as const".len());
    ts_array(&mut out, "export const A = ", &[&exact]);
    assert_eq!(out.lines().count(), 1, "{out}");
}

#[test]
fn comments_wrap_at_the_column_and_a_short_one_stays_a_line() {
    assert_eq!(wrap("a bb ccc", 4), vec!["a bb", "ccc"]);
    assert_eq!(wrap("a bb", 4), vec!["a bb"]);
    assert_eq!(wrap("", 4), Vec::<String>::new());
    let mut out = String::new();
    ts_doc(&mut out, 2, "short");
    assert_eq!(out, "  /** short */\n");
    let mut out = String::new();
    ts_doc(&mut out, 2, &"word ".repeat(30));
    assert!(out.starts_with("  /**\n   * word word"), "{out}");
    assert!(out.ends_with("   */\n"), "{out}");
    assert!(out.lines().all(|l| l.chars().count() <= 100), "{out}");
    let mut out = String::new();
    rust_doc(&mut out, 4, &"word ".repeat(30));
    assert!(out.lines().count() > 1 && out.lines().all(|l| l.starts_with("    /// ")), "{out}");
}

#[test]
fn a_line_past_biomes_width_is_refused_in_the_typescript_half() {
    let long = "w".repeat(200);
    let text = mutated(r#""description": "Says hi.""#, &format!(r#""description": "{long}""#));
    let errors = files(&text).unwrap_err();
    assert!(errors.iter().any(|e| e.contains("past biome's 100 columns")), "{errors:?}");
}

#[test]
fn a_param_the_message_never_uses_is_refused() {
    let text = mutated(r#""count": "integer", "#, r#""count": "integer", "extra": "string", "#)
        .replace(r#""count": 2,"#, r#""count": 2, "extra": "e","#);
    let errors = files(&text).unwrap_err();
    assert!(errors.iter().any(|e| e.contains("param `extra` is never used")), "{errors:?}");
}
