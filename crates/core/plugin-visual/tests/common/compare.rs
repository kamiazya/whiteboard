//! What the replays compare an answer with: bit-exact values, and the issues
//! as the recording writes them: `[path, code, detail]`.

use serde_json::{Value as Json, json};
use whiteboard_facet_engine::schema::{Code, Detail, Issue, PathStep};
use whiteboard_model::Value;

/// Whether two values are the same bit for bit, a mapping's keys in order.
pub(crate) fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.to_bits() == y.to_bits(),
        (Value::Seq(x), Value::Seq(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(p, q)| same(p, q))
        }
        (Value::Map(x), Value::Map(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(p, q)| p.0 == q.0 && same(&p.1, &q.1))
        }
        _ => a == b,
    }
}

fn code_name(code: Code) -> &'static str {
    match code {
        Code::InvalidType => "invalid_type",
        Code::TooSmall => "too_small",
        Code::TooBig => "too_big",
        Code::InvalidFormat => "invalid_format",
        Code::InvalidValue => "invalid_value",
        Code::UnrecognizedKeys => "unrecognized_keys",
        Code::InvalidUnion => "invalid_union",
        Code::InvalidKey => "invalid_key",
        Code::Custom => "custom",
    }
}

/// An issue as the recording writes it: where, why and what the code carries.
pub(crate) fn issues_json(issues: &[Issue]) -> Json {
    Json::Array(
        issues
            .iter()
            .map(|issue| {
                let path: Vec<Json> = issue
                    .path
                    .iter()
                    .map(|step| match step {
                        PathStep::Key(name) => json!(name),
                        PathStep::Index(at) => json!(at),
                    })
                    .collect();
                let detail = match &issue.detail {
                    Detail::None | Detail::Message(_) => Json::Null,
                    Detail::Keys(keys) => json!({ "keys": keys }),
                    Detail::Arms(arms) => {
                        json!({ "arms": arms.iter().map(|arm| issues_json(arm)).collect::<Vec<_>>() })
                    }
                    Detail::Key(inner) => json!({ "key": issues_json(inner) }),
                };
                json!([path, code_name(issue.code), detail])
            })
            .collect(),
    )
}
