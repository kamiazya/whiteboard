//! The interpreter's own cases: every construct the dialect has, each
//! refusal a compile gives by name, and the semantics the recorded oracles
//! reach only in aggregate. Contracts are written inline as JSON.

use serde_json::{Value as Json, json};
use whiteboard_model::Value;

use super::*;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

pub(super) fn val(json: &Json) -> Value {
    match json {
        Json::Null => Value::Null,
        Json::Bool(b) => Value::Bool(*b),
        Json::String(s) => Value::String(s.clone()),
        Json::Number(n) => Value::Number(n.as_f64().unwrap_or(f64::NAN)),
        Json::Array(items) => Value::Seq(items.iter().map(val).collect()),
        Json::Object(object) => {
            Value::Map(object.iter().map(|(k, v)| (k.clone(), val(v))).collect())
        }
    }
}

/// A mapping in the order written, which `json!` does not keep.
pub(super) fn ordered(entries: &[(&str, Value)]) -> Value {
    Value::Map(entries.iter().map(|(k, v)| ((*k).to_owned(), v.clone())).collect())
}

pub(super) fn text(value: &str) -> Value {
    Value::String(value.to_owned())
}

pub(super) fn lower(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|b| b.is_ascii_lowercase())
}

pub(super) fn even(text: &str) -> bool {
    text.chars().count().is_multiple_of(2)
}

pub(super) fn shout(value: &Value) -> Result<Value, Vec<Issue>> {
    match value {
        Value::String(text) => Ok(Value::String(text.to_uppercase())),
        _ => Err(vec![Issue {
            path: Vec::new(),
            code: Code::Custom,
            detail: Detail::None,
            continues: true,
        }]),
    }
}

pub(super) fn host() -> Host<'static> {
    Host {
        matchers: &[("lower", lower)],
        checks: &[("even", even)],
        externals: &[("Loud", External::Validator(shout)), ("Plain", External::AsWritten)],
    }
}

pub(super) fn load(defs: &Json) -> Result<Contracts, CompileError> {
    let contract = val(&json!({ "$schema": "x", "title": "t", "$defs": defs }));
    Contracts::load(&[("c.json", &contract)], &host())
}

pub(super) fn compiled(defs: &Json) -> Contracts {
    load(defs).expect("the contract compiles")
}

pub(super) fn answer(defs: &Json, name: &str, input: &Json) -> Result<Value, Vec<Issue>> {
    let contracts = compiled(defs);
    let def = contracts.resolve(&format!("c.json#/$defs/{name}")).expect("the definition");
    contracts.validate(def, &val(input))
}

pub(super) fn refusal(defs: &Json) -> Refusal {
    load(defs).err().expect("the contract is refused").refusal
}

/// The path, code and flag of each issue, which is what the oracle compares.
pub(super) fn shape(answer: &Result<Value, Vec<Issue>>) -> Vec<(String, Code, bool)> {
    let render = |path: &[PathStep]| {
        path.iter()
            .map(|step| match step {
                PathStep::Key(name) => name.clone(),
                PathStep::Index(at) => at.to_string(),
            })
            .collect::<Vec<_>>()
            .join("/")
    };
    answer.as_ref().err().map_or_else(Vec::new, |issues| {
        issues.iter().map(|i| (render(&i.path), i.code, i.continues)).collect()
    })
}

pub(super) fn issue(path: &str, code: Code, continues: bool) -> (String, Code, bool) {
    (path.to_owned(), code, continues)
}

mod compile;
mod run;
