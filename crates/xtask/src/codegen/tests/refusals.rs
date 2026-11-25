//! The refusals generator: what the contract's template language means, every
//! rule that refuses an entry, and what each language is given.

use super::super::refusal_template::apply;
use super::rust_emit::{rust_doc, rust_literal};
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

/// The TypeScript the contract generates, every file in order as one text,
/// and the Rust, its files likewise.
fn files(text: &str) -> Result<(String, String), Vec<String>> {
    let mut out = generate(text)?;
    let rust_from = out.iter().position(|file| file.2).unwrap_or(out.len());
    let rust = out.drain(rust_from..).map(|file| file.1).collect();
    Ok((out.into_iter().map(|file| file.1).collect(), rust))
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
    assert!(ts.contains("export const REFUSAL_CODES = {"));
    assert!(rust.contains("pub enum Refusal {"));
    assert!(rust.contains("\nrefusals! {\n"));
}

#[test]
fn the_codes_are_a_file_of_their_own_that_the_sentences_re_export() {
    let all = generate(CONTRACT).unwrap();
    let paths: Vec<&str> = all.iter().map(|(path, _, _)| path.as_str()).collect();
    assert_eq!(
        paths,
        [
            "packages/model/src/generated/refusals.ts",
            "packages/model/src/generated/refusal-codes.ts",
            "crates/ops/api-contracts/src/generated/refusals.rs",
            "crates/ops/api-contracts/src/generated/refusal_codes.rs",
        ]
    );
    let (sentences, codes) = (&all[0].1, &all[1].1);
    let (rust, rust_codes) = (&all[2].1, &all[3].1);
    assert!(rust.contains("use crate::refusal_codes::code;"), "{rust}");
    assert!(!rust.contains("pub mod code"), "{rust}");
    assert!(rust_codes.starts_with("// @generated"), "{rust_codes}");
    assert!(rust_codes.contains("pub const PLAIN_THING: &str = \"plain_thing\";"), "{rust_codes}");
    assert!(rust_codes.contains("pub const CODES: &[&str]"), "{rust_codes}");
    assert!(!rust_codes.contains("Refusal"), "{rust_codes}");
    assert!(sentences.ends_with("\nexport * from './refusal-codes.js'\n"), "{sentences}");
    assert!(!sentences.contains("REFUSAL_CODE"), "{sentences}");
    assert!(codes.starts_with("// @generated"), "{codes}");
    assert!(codes.contains("export const REFUSAL_CODE_PLAIN_THING = 'plain_thing'\n"), "{codes}");
    assert!(!codes.contains("export const Plain = "), "{codes}");
}

#[test]
fn the_typescript_half_carries_the_table_the_params_and_the_codes() {
    let (ts, _) = files(CONTRACT).unwrap();
    for wanted in [
        "/** Says hi. */\nexport const Greeted = (name: string, count: number, items: readonly string[]) =>\n  `Hi ${JSON.stringify(name)}, ${count} item${count === 1 ? '' : 's'}: ${items.join(', ')} {ok}`\n",
        "export const Plain = () => \"It's plain {.\"\n",
        "export const Echo = (reason: string) => `${reason}`\n",
        "export const REFUSAL_CODE_GREETED_THING = 'greeted_thing'\nexport const REFUSAL_CODE_PLAIN_THING = 'plain_thing'\n",
        "export const REFUSAL_CODES = {\n  greetedThing: REFUSAL_CODE_GREETED_THING,\n  plainThing: REFUSAL_CODE_PLAIN_THING,\n} as const\n",
        "export type RefusalCode = (typeof REFUSAL_CODES)[keyof typeof REFUSAL_CODES]\n",
        "export const SYNC_WRITE_REFUSAL_CODES = ['greeted_thing'] as const\n",
        "export const VERSION_REFUSAL_CODES = [] as const\n",
    ] {
        assert!(ts.contains(wanted), "{wanted}\n{ts}");
    }
}

#[test]
fn the_rust_half_writes_one_row_per_refusal_into_the_table() {
    let (_, rust) = files(CONTRACT).unwrap();
    for wanted in [
        "    /// Says hi.\n    Greeted { count: u64, items: Vec<String>, name: String }\n        => code::GREETED_THING, 404, format!(\"Hi {0}, {count} item{1}: {2} {{ok}}\", crate::refusal_text::json(name), crate::refusal_text::plural_s(*count), crate::refusal_text::list(items));\n    example { count: 2, items: vec![\"a\".to_owned(), \"b\".to_owned()], name: \"x\".to_owned() };\n",
        "    /// Plain.\n    Plain\n        => code::PLAIN_THING, 500, \"It's plain {.\".to_owned();\n    example;\n",
        "    Echo { reason: String }\n        => code::GREETED_THING, 409, reason.clone();\n    example { reason: \"because\".to_owned() };\n",
        "pub const GREETED_THING: &str = \"greeted_thing\";",
        "pub const CODES: &[&str] = &[code::GREETED_THING, code::PLAIN_THING];",
        "pub const SYNC_WRITE_CODES: &[&str] = &[code::GREETED_THING];",
        "pub const VERSION_CODES: &[&str] = &[];",
        "f.write_str(&self.message())",
    ] {
        assert!(rust.contains(wanted), "{wanted}\n{rust}");
    }
}

#[test]
fn every_accessor_is_written_once_over_the_rows_and_no_function_grows_with_them() {
    let (_, small) = files(CONTRACT).unwrap();
    let text = include_str!("../../../../../contracts/api/refusals.json");
    let (_, whole) = files(text).unwrap();
    let macro_of = |rust: &str| rust[..rust.find("\nrefusals! {").unwrap()].to_owned();
    assert_eq!(macro_of(&small), macro_of(&whole), "the macro does not depend on the rows");
    for accessor in [
        "pub const fn code(&self)",
        "pub const fn status(&self)",
        "pub fn message(&self)",
        "pub(crate) fn examples()",
        "pub enum Refusal {",
    ] {
        assert_eq!(whole.matches(accessor).count(), 1, "{accessor}");
    }
    assert!(!whole.contains("too_many_lines"), "no function needs the long-function lint");
}

#[test]
fn a_filter_applied_twice_to_one_param_is_bound_once() {
    let text = mutated("{count} item{count|s}", "{count|s}{count|s}{count}")
        .replace("Hi \\\"x\\\", 2 items", "Hi \\\"x\\\", ss2");
    let (_, rust) = files(&text).unwrap();
    assert_eq!(rust.matches("crate::refusal_text::plural_s(*count)").count(), 1, "{rust}");
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
    ] {
        refused(from, to, expect);
    }
}

#[test]
fn every_rule_that_refuses_a_status_surface_or_param_names_it() {
    for (from, to, expect) in [
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
    ] {
        refused(from, to, expect);
    }
}

#[test]
fn every_rule_that_refuses_a_template_or_an_example_names_it() {
    for (from, to, expect) in [
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
fn an_array_stays_on_one_line_while_it_fits_and_otherwise_takes_a_line_each() {
    let items = |names: &[&str]| names.iter().map(|n| (*n).to_owned()).collect::<Vec<_>>();
    let mut out = String::new();
    ts_array(&mut out, "export const A = ", &items(&["a", "b"]));
    assert_eq!(out, "export const A = [a, b] as const\n");
    let long = "x".repeat(90);
    let mut out = String::new();
    ts_array(&mut out, "export const A = ", &items(&[&long, "b"]));
    assert_eq!(out, format!("export const A = [\n  {long},\n  b,\n] as const\n"));
    let mut out = String::new();
    let exact = "x".repeat(100 - "export const A = [".len() - "] as const".len());
    ts_array(&mut out, "export const A = ", &items(&[&exact]));
    assert_eq!(out.lines().count(), 1, "{out}");
    let mut out = String::new();
    ts_array(&mut out, "export const A = ", &items(&[&format!("{exact}x")]));
    assert_eq!(out.lines().count(), 3, "{out}");
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
    // The indent comes off the width: 80 columns of text at an indent of 40 take two lines.
    let mut out = String::new();
    ts_doc(&mut out, 40, &"word ".repeat(16));
    assert!(out.lines().count() > 1, "{out}");
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

#[test]
fn each_filter_compiles_to_the_javascript_it_names() {
    let text = CONTRACT
        .replace(
            r#""message": "{reason}""#,
            r#""message": "{reason|trim} {names|and_list} {names|json_list} {names|quoted_list} `{reason|json}` ${{x}}""#,
        )
        .replace(
            r#""params": { "reason": "string" }"#,
            r#""params": { "reason": "string", "names": "string[]" }"#,
        )
        .replace(
            r#""example": { "reason": "because" }"#,
            r#""example": { "reason": " because ", "names": ["a", "b"] }"#,
        )
        .replace(
            r#""exampleText": "because""#,
            r#""exampleText": "because a and b \"a\", \"b\" \"a\", \"b\" `\" because \"` ${x}""#,
        );
    let (ts, _) = files(&text).unwrap();
    for wanted in [
        "${reason.trim()} ${names.join(' and ')}",
        "${names.map((i) => JSON.stringify(i)).join(', ')}",
        "${names.map((i) => `\"${i}\"`).join(', ')}",
        "\\`${JSON.stringify(reason)}\\` \\${x}",
    ] {
        assert!(ts.contains(wanted), "{wanted}\n{ts}");
    }
}

#[test]
fn a_signature_past_the_column_takes_a_param_to_a_line_and_the_body_joins_when_it_fits() {
    let long = "w".repeat(70);
    let text = CONTRACT
        .replace("\"Echo\"", "\"EchoAndAnother\"")
        .replace(r#""message": "{reason}""#, &format!(r#""message": "{{reason}} {{{long}}}""#))
        .replace(
            r#""params": { "reason": "string" }"#,
            &format!(r#""params": {{ "reason": "string", "{long}": "string" }}"#),
        )
        .replace(
            r#""example": { "reason": "because" }"#,
            &format!(r#""example": {{ "reason": "because", "{long}": "x" }}"#),
        )
        .replace(r#""exampleText": "because""#, r#""exampleText": "because x""#);
    let (ts, _) = files(&text).unwrap();
    let wanted = format!(
        "export const EchoAndAnother = (\n  reason: string,\n  {long}: string,\n) => `${{reason}} ${{{long}}}`\n"
    );
    assert!(ts.contains(&wanted), "{wanted}\n{ts}");
}

#[test]
fn a_refusal_named_for_a_global_the_filters_call_is_refused() {
    refused("\"Echo\"", "\"JSON\"", "would shadow a global the filters call");
}

#[test]
fn a_param_a_typescript_function_could_not_name_is_refused() {
    for name in ["new", "i", "this", "debugger", "extends", "instanceof"] {
        let text = CONTRACT
            .replace("\"reason\"", &format!("\"{name}\""))
            .replace("{reason}", &format!("{{{name}}}"));
        let errors = files(&text).unwrap_err();
        assert!(
            errors.iter().any(|e| e.contains("not a name both languages take")),
            "{name}: {errors:?}"
        );
    }
}

#[test]
fn breach_shapes_become_the_tables_the_sync_judge_answers_from() {
    let text = CONTRACT
        .replacen(
            r#""family": "sync-write","#,
            r#""family": "sync-write", "breach": { "table": "text", "shape": "node-text" },"#,
            1,
        )
        .replace(
            r#""code": "greeted_thing",
      "status": 409,
      "family": "sync-write","#,
            r#""code": "greeted_thing",
      "status": 409,
      "family": "sync-write", "breach": { "table": "workspace", "shape": "plain" },"#,
        );
    let (ts, _) = files(&text).unwrap();
    for wanted in [
        "/** The code each text breach shape of a sync write is answered with. */\nexport const SYNC_TEXT_BREACH_CODES = {\n  'node-text': SYNC_WRITE_REFUSAL_CODES[0],\n} as const\n",
        "export const SYNC_WORKSPACE_BREACH_CODES = {\n  plain: SYNC_WRITE_REFUSAL_CODES[0],\n} as const\n",
    ] {
        assert!(ts.contains(wanted), "{wanted}\n{ts}");
    }
}

#[test]
fn a_breach_shape_the_tables_could_not_hold_is_refused() {
    let at = |breach: &str| {
        CONTRACT.replacen(
            r#""family": "sync-write","#,
            &format!(r#""family": "sync-write", "breach": {breach},"#),
            1,
        )
    };
    for (breach, expect) in [
        (r#"{ "table": "nowhere", "shape": "a" }"#, "breach table `nowhere`"),
        (r#"{ "table": "text", "shape": "A" }"#, "not lowercase kebab-case"),
        (r#"{ "table": "text", "shape": "a-" }"#, "not lowercase kebab-case"),
        (r#"{ "table": "text", "shape": "a--b" }"#, "not lowercase kebab-case"),
        (r#"{ "table": "text", "shape": "a_b" }"#, "not lowercase kebab-case"),
        (r#"{ "table": "text", "shape": "" }"#, "not lowercase kebab-case"),
    ] {
        let errors = files(&at(breach)).unwrap_err();
        assert!(errors.iter().any(|e| e.contains(expect)), "{breach}: {errors:?}");
    }
    let unsynced = CONTRACT.replacen(
        r#""source": "S""#,
        r#""breach": { "table": "text", "shape": "a" }, "source": "S""#,
        2,
    );
    let errors = files(&unsynced).unwrap_err();
    assert!(errors.iter().any(|e| e.contains("answered by a sync-write refusal")), "{errors:?}");
    let twice = CONTRACT.replace(
        r#""family": "sync-write","#,
        r#""family": "sync-write", "breach": { "table": "text", "shape": "a" },"#,
    );
    let errors = files(&twice).unwrap_err();
    assert!(errors.iter().any(|e| e.contains("is answered by two entries")), "{errors:?}");
}

#[test]
fn a_refusal_with_a_module_is_generated_into_that_packages_own_file() {
    let text = CONTRACT.replacen(
        r#""family": "sync-write","#,
        r#""family": "sync-write", "module": "loro-adapter","#,
        1,
    );
    let all = generate(&text).unwrap();
    let paths: Vec<&str> = all.iter().map(|(path, _, _)| path.as_str()).collect();
    assert_eq!(
        paths,
        [
            "packages/model/src/generated/refusals.ts",
            "packages/model/src/generated/refusal-codes.ts",
            "packages/loro-adapter/src/generated/refusals.ts",
            "crates/ops/api-contracts/src/generated/refusals.rs",
            "crates/ops/api-contracts/src/generated/refusal_codes.rs",
        ]
    );
    let (main, module) = (&all[0].1, &all[2].1);
    assert!(module.contains("export const Greeted = "), "{module}");
    assert!(!main.contains("export const Greeted = "), "{main}");
    assert!(main.contains("export const Echo = "), "{main}");
    assert!(all[3].1.contains("    Greeted {"), "the Rust table holds every refusal");
    for bad in ["Loro", "a_b", "a-", "-a", "a--b", ""] {
        let text = CONTRACT.replacen(
            r#""family": "sync-write","#,
            &format!(r#""family": "sync-write", "module": "{bad}","#),
            1,
        );
        let errors = files(&text).unwrap_err();
        assert!(
            errors.iter().any(|e| e.contains("is not a package directory name")),
            "{bad}: {errors:?}"
        );
    }
    let text = CONTRACT.replacen(
        r#""family": "sync-write","#,
        r#""family": "sync-write", "module": "model","#,
        1,
    );
    let errors = files(&text).unwrap_err();
    assert!(errors.iter().any(|e| e.contains("would overwrite the main catalog")), "{errors:?}");
}

const AWKWARD: &str = r#"{
  "$comment": "c",
  "surfaces": { "api-v1": "the api" },
  "refusals": [
    {
      "name": "Lone", "code": "lone", "status": 400, "description": "A lone integer.",
      "message": "{count}", "params": { "count": "integer" }, "example": { "count": 7 },
      "exampleText": "7", "surfaces": ["api-v1"], "source": "S"
    },
    {
      "name": "Shadow", "code": "shadow", "status": 400, "description": "A param named for its filter.",
      "message": "{json|json}", "params": { "json": "string" }, "example": { "json": "a\"b" },
      "exampleText": "\"a\\\"b\"", "surfaces": ["api-v1"], "source": "S"
    },
    {
      "name": "Collide", "code": "collide", "status": 400, "description": "A filtered placeholder beside a field its argument could be named for.",
      "message": "{path|json}: {pathJson}", "params": { "path": "string", "pathJson": "string" },
      "example": { "path": "p", "pathJson": "q" }, "exampleText": "\"p\": q",
      "surfaces": ["api-v1"], "source": "S"
    },
    {
      "name": "Lists", "code": "lists", "status": 400, "description": "Two lists whose argument names would meet.",
      "message": "{paths|json_list}|{pathsJson|list}",
      "params": { "paths": "string[]", "pathsJson": "string[]" },
      "example": { "paths": ["a"], "pathsJson": ["b", "c"] }, "exampleText": "\"a\"|b, c",
      "surfaces": ["api-v1"], "source": "S"
    },
    {
      "name": "Plural", "code": "plural", "status": 400, "description": "One filter twice on one param.",
      "message": "{n} item{n|s}{n|s}", "params": { "n": "integer" }, "example": { "n": 1 },
      "exampleText": "1 item", "surfaces": ["api-v1"], "source": "S"
    },
    {
      "name": "CountInt", "code": "count_int", "status": 400, "description": "One body, an integer.",
      "message": "Value: {count}", "params": { "count": "integer" }, "example": { "count": 2 },
      "exampleText": "Value: 2", "surfaces": ["api-v1"], "source": "S"
    },
    {
      "name": "CountStr", "code": "count_str", "status": 400, "description": "The same body, a string.",
      "message": "Value: {count}", "params": { "count": "string" }, "example": { "count": "x" },
      "exampleText": "Value: x", "surfaces": ["api-v1"], "source": "S"
    }
  ]
}"#;

/// The generated Rust of a contract whose placeholders could collide, built
/// into a program with the real filters, run, and its sentences read back.
#[test]
fn the_rust_half_of_an_awkward_contract_compiles_and_says_what_the_contract_pins() {
    let all = generate(AWKWARD).unwrap();
    let [.., (_, rust, _), (_, codes, _)] = all.as_slice() else { panic!("no Rust half") };
    let dir = std::env::temp_dir().join(format!("xtask-refusals-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("generated.rs"), rust).unwrap();
    std::fs::write(dir.join("generated_codes.rs"), codes).unwrap();
    let text = concat!(env!("CARGO_MANIFEST_DIR"), "/../ops/api-contracts/src/refusal_text.rs");
    let text = rust_literal(text);
    let main = format!(
        r#"#[path = {text}]
mod refusal_text;
#[path = "generated_codes.rs"]
mod refusal_codes;
#[path = "generated.rs"]
mod refusals;
use refusals::Refusal;
fn main() {{
    let list = |items: &[&str]| items.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
    println!("{{}}", Refusal::Lone {{ count: 7 }}.message());
    println!("{{}}", Refusal::Shadow {{ json: "a\"b".to_owned() }}.message());
    println!("{{}}", Refusal::Collide {{ path: "p".to_owned(), path_json: "q".to_owned() }}.message());
    println!("{{}}", Refusal::Lists {{ paths: list(&["a"]), paths_json: list(&["b", "c"]) }}.message());
    println!("{{}}", Refusal::Plural {{ n: 1 }}.message());
    println!("{{}}", Refusal::CountInt {{ count: 2 }}.message());
    println!("{{}}", Refusal::CountStr {{ count: "x".to_owned() }}.message());
}}
"#
    );
    std::fs::write(dir.join("main.rs"), main).unwrap();
    let built = std::process::Command::new("rustc")
        .args(["--edition", "2024", "--crate-name", "probe", "-o"])
        .arg(dir.join("probe"))
        .arg(dir.join("main.rs"))
        .output()
        .unwrap();
    assert!(built.status.success(), "{}", String::from_utf8_lossy(&built.stderr));
    let ran = std::process::Command::new(dir.join("probe")).output().unwrap();
    let said = String::from_utf8(ran.stdout).unwrap();
    let wanted = ["7", "\"a\\\"b\"", "\"p\": q", "\"a\"|b, c", "1 item", "Value: 2", "Value: x"];
    assert_eq!(said.lines().collect::<Vec<_>>(), wanted);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_lone_integer_placeholder_is_formatted_not_cloned() {
    let (_, rust) = files(AWKWARD).unwrap();
    assert!(
        rust.contains("Lone { count: u64 }\n        => code::LONE, 400, format!(\"{count}\");"),
        "{rust}"
    );
}

#[test]
fn a_filtered_placeholder_is_positional_and_qualified() {
    let (_, rust) = files(AWKWARD).unwrap();
    for wanted in [
        "format!(\"{0}: {path_json}\", crate::refusal_text::json(path))",
        "format!(\"{0}|{1}\", crate::refusal_text::json_list(paths), crate::refusal_text::list(paths_json))",
        "format!(\"{n} item{0}{0}\", crate::refusal_text::plural_s(*n))",
        "Shadow { json: String }\n        => code::SHADOW, 400, format!(\"{0}\", crate::refusal_text::json(json));",
    ] {
        assert!(rust.contains(wanted), "{wanted}\n{rust}");
    }
}

#[test]
fn a_description_that_would_end_its_doc_comment_and_codes_that_collide_are_refused() {
    let text = mutated("\"Says hi.\"", "\"Matches /api/*/documents.\"");
    let errors = files(&text).unwrap_err();
    assert!(errors.iter().any(|e| e.contains("holds `*/`")), "{errors:?}");
    let clash = CONTRACT.replace("plain_thing", "a1").replacen("greeted_thing", "a_1", 1);
    let errors = files(&clash).unwrap_err();
    assert!(errors.iter().any(|e| e.contains("codes `a_1` and `a1` are both `a1`")), "{errors:?}");
    // One raw code said more than one way is not a collision.
    assert!(files(CONTRACT).is_ok());
}

#[test]
fn only_a_whole_quoted_literal_is_a_line_biome_cannot_break() {
    use super::super::emit::lone_string;
    for line in ["  'abc',", "\"abc\"", "`a b`,"] {
        assert!(lone_string(line), "{line}");
    }
    for line in ["'", "'abc", "abc'", "'a' + b", "x"] {
        assert!(!lone_string(line), "{line}");
    }
}
