//! The interpreter as properties, over the contracts the engine ships and
//! inputs drawn from what Zod was recorded answering (so a draw is often one
//! the schema accepts), then damaged: whatever the input, the interpreter
//! answers with a value or with issues whose paths lead into the input; a
//! value it accepts is a fixed point of it; and an unknown key is stripped
//! by a stripping object and named by a refusing one, whatever else the
//! object holds.

#[path = "common/contract.rs"]
mod contract;
#[path = "common/value.rs"]
mod value;

use std::sync::OnceLock;

use contract::from_json;
use serde_json::Value as Json;
use value::decode;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_facet_engine::checks;
use whiteboard_facet_engine::schema::{Code, Contracts, DefId, Detail, Host, Issue, PathStep};
use whiteboard_model::Value;
use whiteboard_proptest::proptest::prelude::{
    Just, Strategy, any, prop, prop_assert, prop_assert_eq, prop_oneof,
};
use whiteboard_proptest::{Floor, check};

const RECORDING: &str =
    include_str!("../../../../packages/facet-engine/src/oracle/contract-schemas.jsonl");
const ENGINE: &str = include_str!("../../../../contracts/facets/engine/engine.schema.json");
const MANIFEST: &str = include_str!("../../../../contracts/plugin/plugin-manifest.schema.json");
const NAMES: [&str; 4] = ["ThemeTokens", "IconAsset", "StencilAsset", "PluginManifest"];
const UNKNOWN: &str = "zzUnknownKey";

struct Case {
    name: &'static str,
    input: Value,
    accepted: bool,
}

fn contracts() -> Option<&'static Contracts> {
    static SET: OnceLock<Option<Contracts>> = OnceLock::new();
    SET.get_or_init(|| {
        let engine = from_json(ENGINE)?;
        let manifest = from_json(MANIFEST)?;
        let host = Host {
            matchers: &[
                ("namespaced_id", checks::namespaced_id),
                ("facet_key", checks::facet_key),
                ("hex_color", checks::hex_color),
                ("facet_segment", checks::facet_segment),
                ("version_tag", checks::version_tag),
                ("schema_ref", checks::schema_ref),
            ],
            checks: &[],
            externals: &[],
        };
        let loaded = [("e.json", &engine), ("m.json", &manifest)];
        Contracts::load(&loaded, &host).ok()
    })
    .as_ref()
}

fn def(name: &str) -> Option<DefId> {
    let file = if name == "PluginManifest" { "m.json" } else { "e.json" };
    contracts()?.resolve(&format!("{file}#/$defs/{name}"))
}

fn judge(name: &str, input: &Value) -> Option<Result<Value, Vec<Issue>>> {
    Some(contracts()?.validate(def(name)?, input))
}

fn corpus() -> &'static [Case] {
    static CASES: OnceLock<Vec<Case>> = OnceLock::new();
    CASES.get_or_init(|| {
        let parse = |line: &str| -> Option<Case> {
            let json: Json = serde_json::from_str(line).ok()?;
            let name = NAMES.into_iter().find(|n| json["s"] == *n)?;
            Some(Case { name, input: decode(&json["in"])?, accepted: json.get("ok").is_some() })
        };
        RECORDING.lines().filter_map(parse).collect()
    })
}

/// One damage to the top level of an input.
fn damaged(input: &Value, op: u8, at: usize) -> Value {
    let Value::Map(entries) = input else {
        return if op == 0 { input.clone() } else { Value::Null };
    };
    let mut entries = entries.clone();
    match op {
        1 => entries.push((UNKNOWN.to_owned(), Value::Null)),
        2 if !entries.is_empty() => {
            entries.remove(at % entries.len());
        }
        3 if !entries.is_empty() => {
            let index = at % entries.len();
            if let Some(entry) = entries.get_mut(index) {
                entry.1 = Value::Seq(vec![Value::Number(f64::NAN)]);
            }
        }
        _ => {}
    }
    Value::Map(entries)
}

fn leaf() -> impl Strategy<Value = Value> {
    prop_oneof![
        Just(Value::Null),
        any::<bool>().prop_map(Value::Bool),
        any::<f64>().prop_map(Value::Number),
        "[ -~]{0,6}".prop_map(Value::String),
    ]
}

fn anything() -> impl Strategy<Value = Value> {
    leaf().prop_recursive(3, 24, 4, |inner| {
        prop_oneof![
            prop::collection::vec(inner.clone(), 0..4).prop_map(Value::Seq),
            prop::collection::vec(("[a-z]{1,3}", inner), 0..4).prop_map(Value::Map),
        ]
    })
}

/// What a draw is judged as, and whether the recording says Zod accepted it.
fn draw() -> impl Strategy<Value = (&'static str, Value)> {
    let from_corpus = (0..corpus().len(), 0_u8..5, any::<usize>()).prop_map(|(index, op, at)| {
        let case = &corpus()[index % corpus().len()];
        (case.name, damaged(&case.input, op, at))
    });
    let free =
        (0..NAMES.len(), anything()).prop_map(|(index, value)| (NAMES[index % NAMES.len()], value));
    prop_oneof![4 => from_corpus, 1 => free]
}

/// Whether `path` leads into `input`, or leads to the one key a map lacks.
fn leads_into(input: &Value, path: &[PathStep]) -> bool {
    let mut here = input;
    for (depth, step) in path.iter().enumerate() {
        let next = match (here, step) {
            (Value::Map(entries), PathStep::Key(key)) => {
                entries.iter().find(|(name, _)| name == key).map(|(_, v)| v)
            }
            (Value::Seq(items), PathStep::Index(at)) => items.get(*at),
            _ => None,
        };
        match next {
            Some(found) => here = found,
            None => {
                return depth.saturating_add(1) == path.len()
                    && matches!(step, PathStep::Key(_))
                    && matches!(here, Value::Map(_));
            }
        }
    }
    true
}

#[test]
fn whatever_the_input_the_answer_is_a_value_or_issues_that_lead_into_it() {
    let accepted = Floor::new("an input the interpreter accepts");
    let refused = Floor::new("an input the interpreter refuses");
    check(draw(), None, |(name, input)| {
        let answer = judge(name, &input);
        prop_assert!(answer.is_some(), "{name} is not a definition of the contracts");
        match answer {
            Some(Ok(_)) => accepted.draw(true),
            Some(Err(issues)) => {
                refused.draw(true);
                prop_assert!(!issues.is_empty(), "a refusal with no issue");
                for issue in &issues {
                    prop_assert!(
                        leads_into(&input, &issue.path),
                        "{:?} leads nowhere in {input:?}",
                        issue.path
                    );
                }
            }
            None => {}
        }
        Ok(())
    });
    accepted.assert(30);
    refused.assert(30);
}

#[test]
fn a_value_the_interpreter_accepts_is_a_fixed_point_of_it() {
    let reached = Floor::new("an accepted input that the schema changed");
    check(prop_oneof![1 => draw(), 1 => stripped_inputs()], None, |(name, input)| {
        let Some(Ok(parsed)) = judge(name, &input) else { return Ok(()) };
        reached.draw(parsed != input);
        prop_assert_eq!(judge(name, &parsed), Some(Ok(parsed.clone())));
        Ok(())
    });
    reached.assert(10);
}

fn accepted_inputs() -> impl Strategy<Value = (&'static str, Value)> {
    let ok: Vec<(&'static str, Value)> = corpus()
        .iter()
        .filter(|case| case.accepted)
        .map(|case| (case.name, case.input.clone()))
        .collect();
    prop::sample::select(ok)
}

/// An accepted input of a stripping object with a key it does not declare: the
/// schema answers it changed, so a fixed-point property always meets the case
/// it is about rather than waiting for a free draw to land on a default.
fn stripped_inputs() -> impl Strategy<Value = (&'static str, Value)> {
    accepted_inputs()
        .prop_filter("a stripping object", |(name, input)| {
            matches!(*name, "ThemeTokens" | "IconAsset") && matches!(input, Value::Map(_))
        })
        .prop_map(|(name, input)| {
            let Value::Map(mut entries) = input else { return (name, input) };
            entries.push((UNKNOWN.to_owned(), Value::Bool(true)));
            (name, Value::Map(entries))
        })
}

#[test]
fn an_unknown_key_is_stripped_by_a_stripping_object_and_named_by_a_refusing_one() {
    let stripped = Floor::new("an input a stripping object held");
    let named = Floor::new("an input a refusing object held");
    check(accepted_inputs(), None, |(name, input)| {
        let Value::Map(entries) = &input else { return Ok(()) };
        let mut extra = entries.clone();
        extra.push((UNKNOWN.to_owned(), Value::Bool(true)));
        let (Some(Ok(before)), Some(after)) =
            (judge(name, &input), judge(name, &Value::Map(extra)))
        else {
            return Ok(());
        };
        if name == "ThemeTokens" || name == "IconAsset" {
            stripped.draw(true);
            prop_assert_eq!(after, Ok(before));
        } else {
            named.draw(true);
            let issues = after.err().unwrap_or_default();
            prop_assert_eq!(issues.len(), 1);
            let issue = issues.first();
            prop_assert_eq!(issue.map(|i| i.code), Some(Code::UnrecognizedKeys));
            prop_assert_eq!(
                issue.map(|i| i.detail.clone()),
                Some(Detail::Keys(vec![UNKNOWN.to_owned()]))
            );
            prop_assert!(issue.is_some_and(|i| i.path.is_empty() && i.continues));
        }
        Ok(())
    });
    stripped.assert(20);
    named.assert(20);
}
