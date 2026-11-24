//! The JSON-RPC 2.0 envelope as the SDK reads it: which inbound messages are
//! requests, and the two answers a request can draw.
//!
//! The SDK holds every inbound message to `JSONRPCMessageSchema`, a union of
//! STRICT objects, and answers only a request; anything else — a
//! notification, a response, a batch, or a message no member of the union
//! takes — draws no answer on the wire, whatever is wrong with it. So the
//! one question asked here is whether a message is a request.

use serde_json::{Map, Value};

/// The protocol versions `initialize` accepts, preferred first: the SDK's
/// `SUPPORTED_PROTOCOL_VERSIONS`. A version not listed is answered with the
/// first.
pub const SUPPORTED_PROTOCOL_VERSIONS: [&str; 5] =
    ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"];

/// The JSON-RPC error codes the dispatcher answers with.
pub mod code {
    /// A request whose method the server does not serve.
    pub const METHOD_NOT_FOUND: i64 = -32601;
    /// `tools/call`'s refusals of its own params and of an unknown tool.
    pub const INVALID_PARAMS: i64 = -32602;
    /// Every other request whose params its schema refuses: the SDK throws
    /// those as plain errors, which carry no code of their own.
    pub const INTERNAL_ERROR: i64 = -32603;
}

/// `Number.MAX_SAFE_INTEGER`: Zod's `int()` takes no integer past it.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// The `_meta` key a task-related request carries.
const RELATED_TASK: &str = "io.modelcontextprotocol/related-task";

/// A request: the id to answer it with, its method and its params.
pub(crate) struct Request<'a> {
    pub(crate) id: Value,
    pub(crate) method: &'a str,
    pub(crate) params: Option<&'a Value>,
}

/// The message as a request, or `None` when it is not one.
pub(crate) fn request(message: &Value) -> Option<Request<'_>> {
    let object = message.as_object()?;
    let only_request_keys =
        object.keys().all(|key| matches!(key.as_str(), "jsonrpc" | "id" | "method" | "params"));
    let params = object.get("params");
    let valid = only_request_keys
        && object.get("jsonrpc").and_then(Value::as_str) == Some("2.0")
        && params.is_none_or(params_are_valid);
    let id = request_id(object.get("id")?)?;
    let method = object.get("method")?.as_str()?;
    valid.then_some(Request { id, method, params })
}

/// `BaseRequestParamsSchema.loose()`: any object whose `_meta`, if present,
/// is `RequestMetaSchema`'s.
fn params_are_valid(params: &Value) -> bool {
    params.as_object().is_some_and(|params| params.get("_meta").is_none_or(meta_is_valid))
}

fn meta_is_valid(meta: &Value) -> bool {
    let Some(meta) = meta.as_object() else { return false };
    let token =
        meta.get("progressToken").is_none_or(|token| token.is_string() || is_integer(token));
    let task =
        meta.get(RELATED_TASK).is_none_or(|task| task.get("taskId").is_some_and(Value::is_string));
    token && task
}

fn is_integer(value: &Value) -> bool {
    value.as_f64().and_then(safe_integer).is_some()
}

/// A request id: a string, or a safe integer, written back as the integer
/// JavaScript reads (`1.0` and `1e0` are both `1`).
fn request_id(id: &Value) -> Option<Value> {
    match id {
        Value::String(_) => Some(id.clone()),
        Value::Number(number) => number.as_f64().and_then(safe_integer).map(Value::from),
        _ => None,
    }
}

/// `x` as an integer when `Number.isSafeInteger(x)`. A JSON integer past
/// 2^53 reads as the double JavaScript would round it to, so one the double
/// cannot hold exactly is refused here as it is there.
fn safe_integer(x: f64) -> Option<i64> {
    let whole = x.trunc().to_bits() == x.to_bits();
    #[expect(
        clippy::cast_possible_truncation,
        reason = "whole and within 2^53 by the check beside it, so exact in an i64"
    )]
    let integer = x as i64;
    (whole && x.abs() <= MAX_SAFE_INTEGER).then_some(integer)
}

/// The answer to request `id` that carries `result`.
pub(crate) fn result(id: Value, result: Value) -> Value {
    answer(id, "result", result)
}

/// The answer to request `id` that refuses it.
pub(crate) fn error(id: Value, code: i64, message: String) -> Value {
    let mut error = Map::new();
    error.insert("code".into(), code.into());
    error.insert("message".into(), message.into());
    answer(id, "error", Value::Object(error))
}

fn answer(id: Value, key: &str, value: Value) -> Value {
    let mut answer = Map::new();
    answer.insert("jsonrpc".into(), "2.0".into());
    answer.insert("id".into(), id);
    answer.insert(key.into(), value);
    Value::Object(answer)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    fn id_of(text: &str) -> Option<Value> {
        let message: Value =
            serde_json::from_str(&format!(r#"{{"jsonrpc":"2.0","id":{text},"method":"ping"}}"#))
                .unwrap();
        request(&message).map(|request| request.id)
    }

    /// The recording cannot hold these: JSON.stringify writes each as the
    /// integer, so the SDK saw the integer.
    #[test]
    fn an_integral_id_written_as_a_double_is_answered_as_the_integer() {
        assert_eq!(id_of("1.0"), Some(json!(1)));
        assert_eq!(id_of("1e2"), Some(json!(100)));
        assert_eq!(id_of("-0"), Some(json!(0)));
        assert_eq!(id_of("-0.0"), Some(json!(0)));
        assert_eq!(id_of("-4096.0"), Some(json!(-4096)));
        assert_eq!(id_of("-9007199254740991"), Some(json!(-9_007_199_254_740_991_i64)));
    }

    #[test]
    fn an_id_past_the_safe_range_is_no_request() {
        assert_eq!(id_of("9007199254740993"), None);
        assert_eq!(id_of("-9007199254740992"), None);
        assert_eq!(id_of("18446744073709551615"), None);
        assert_eq!(id_of("1.5"), None);
        assert_eq!(id_of("0.0000001"), None);
    }

    #[test]
    fn a_progress_token_is_a_string_or_a_safe_integer() {
        let with = |token: Value| {
            let message = json!({ "jsonrpc": "2.0", "id": 1, "method": "ping",
                "params": { "_meta": { "progressToken": token } } });
            request(&message).is_some()
        };
        assert!(with(json!("t")));
        assert!(with(json!(-3)));
        assert!(!with(json!(2.5)));
        assert!(!with(json!(true)));
    }

    #[test]
    fn an_error_answer_carries_its_code_and_message() {
        assert_eq!(
            error(json!("a"), code::METHOD_NOT_FOUND, "m".into()),
            json!({ "jsonrpc": "2.0", "id": "a", "error": { "code": -32601, "message": "m" } })
        );
    }
}
