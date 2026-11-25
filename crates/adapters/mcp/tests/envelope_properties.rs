//! The envelope as a property: a message is answered exactly when every part
//! of it is what `JSONRPCRequestSchema` takes, and the answer carries the
//! request's id and one of `result` or `error`. The oracle is the parts the
//! generator chose, never the dispatcher's own reading.

use std::future::{Future, ready};

use serde_json::{Map, Value, json};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_mcp::{Identity, Server, ToolCatalogue, ToolError};
use whiteboard_port_fakes::block_on;
use whiteboard_proptest::proptest::prelude::{
    Just, Strategy, prop, prop_assert, prop_assert_eq, prop_oneof,
};
use whiteboard_proptest::{Floor, check};

struct NoTools;

impl ToolCatalogue for NoTools {
    fn tools(&self) -> Vec<Value> {
        Vec::new()
    }

    fn call(
        &self,
        _: &str,
        _: Option<&Map<String, Value>>,
    ) -> impl Future<Output = Result<Value, ToolError>> {
        ready(Err(ToolError::NotFound))
    }
}

/// One part of a message: the value to write (`None`: leave the key out) and
/// whether the schema takes it.
type Part = (Option<Value>, bool);

fn valid(value: impl Strategy<Value = Value>) -> impl Strategy<Value = Part> {
    value.prop_map(|value| (Some(value), true))
}

fn invalid(value: impl Strategy<Value = Value>) -> impl Strategy<Value = Part> {
    value.prop_map(|value| (Some(value), false))
}

fn jsonrpc() -> impl Strategy<Value = Part> {
    prop_oneof![
        8 => valid(Just(json!("2.0"))),
        1 => invalid(prop_oneof![Just(json!("1.0")), Just(json!(2)), Just(json!(null))]),
        1 => Just((None, false)),
    ]
}

const MAX_SAFE: i64 = 9_007_199_254_740_991;

fn id() -> impl Strategy<Value = Part> {
    prop_oneof![
        4 => valid("[a-z0-9]{0,4}".prop_map(Value::from)),
        4 => valid((-MAX_SAFE..=MAX_SAFE).prop_map(Value::from)),
        1 => invalid(prop_oneof![
            Just(json!(null)),
            Just(json!(true)),
            Just(json!([])),
            Just(json!({})),
            (1_u32..1000).prop_map(|n| json!(f64::from(n) + 0.5)),
            (MAX_SAFE + 2..i64::MAX).prop_map(Value::from),
        ]),
        1 => Just((None, false)),
    ]
}

fn method() -> impl Strategy<Value = Part> {
    let names =
        ["ping", "initialize", "tools/list", "tools/call", "logging/setLevel", "no/such", ""];
    prop_oneof![
        8 => valid(prop::sample::select(names.to_vec()).prop_map(Value::from)),
        1 => invalid(prop_oneof![Just(json!(1)), Just(json!(null)), Just(json!(["ping"]))]),
        1 => Just((None, false)),
    ]
}

fn params() -> impl Strategy<Value = Part> {
    prop_oneof![
        3 => Just((None, true)),
        3 => valid(prop_oneof![
            Just(json!({})),
            Just(json!({ "level": "info", "name": "x" })),
            Just(json!({ "_meta": { "progressToken": 3, "x": [] } })),
        ]),
        1 => invalid(prop_oneof![
            Just(json!([])),
            Just(json!("p")),
            Just(json!(null)),
            Just(json!({ "_meta": [] })),
            Just(json!({ "_meta": { "progressToken": 0.5 } })),
            Just(json!({ "_meta": { "io.modelcontextprotocol/related-task": { "taskId": 1 } } })),
        ]),
    ]
}

fn extra() -> impl Strategy<Value = Part> {
    prop_oneof![8 => Just((None, true)), 1 => invalid(Just(json!(0)))]
}

/// Each part is weighted so a whole message is a request on about two draws
/// in five (0.8 x 0.8 x 0.8 x 6/7 x 8/9), about 78 of 200, far above the floor
/// of 20; at one draw in six the floor failed about once in three hundred runs.
#[test]
fn a_message_is_answered_exactly_when_it_is_a_request() {
    let server = Server::new(
        Identity { name: "n".into(), version: "v".into(), instructions: String::new() },
        NoTools,
    );
    let floor = Floor::new("requests");
    let parts = (jsonrpc(), id(), method(), params(), extra());
    check(parts, None, |parts| {
        let (jsonrpc, id, method, params, extra) = parts;
        let mut message = Map::new();
        let keys = ["jsonrpc", "id", "method", "params", "extra"];
        let all = [&jsonrpc, &id, &method, &params, &extra];
        for (key, (value, _)) in keys.into_iter().zip(all) {
            if let Some(value) = value {
                message.insert(key.into(), value.clone());
            }
        }
        let is_request = all.iter().all(|(_, takes)| *takes);
        floor.draw(is_request);
        let answer = block_on(server.handle(&Value::Object(message)));
        prop_assert_eq!(answer.is_some(), is_request);
        if let Some(answer) = answer {
            prop_assert_eq!(&answer["id"], id.0.as_ref().expect("an id"));
            prop_assert_eq!(&answer["jsonrpc"], &json!("2.0"));
            prop_assert!(answer.get("result").is_some() != answer.get("error").is_some());
        }
        Ok(())
    });
    floor.assert(20);
}
