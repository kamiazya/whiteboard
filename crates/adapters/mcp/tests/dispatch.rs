//! What the recording cannot show: the state a server keeps for its driver,
//! the identity it is configured with, and a catalogue's own answers.

use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll};

use serde_json::{Map, Value, json};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_mcp::{Identity, LogLevel, Server, ToolCatalogue, ToolError};
use whiteboard_port_fakes::block_on;

/// Pending once before it answers, as a catalogue over a real port would be.
struct Later(Option<Result<Value, ToolError>>);

impl Future for Later {
    type Output = Result<Value, ToolError>;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        if let Some(answer) = self.0.take() {
            return Poll::Ready(answer);
        }
        self.0 = Some(Ok(json!({ "content": [], "late": true })));
        cx.waker().wake_by_ref();
        Poll::Pending
    }
}

/// Answers each tool by its name: `echo` its arguments, `failing` a text,
/// `late` after a pending poll.
struct Catalogue;

impl ToolCatalogue for Catalogue {
    fn tools(&self) -> Vec<Value> {
        vec![json!({ "name": "echo" }), json!({ "name": "failing" })]
    }

    fn call(
        &self,
        name: &str,
        arguments: Option<&Map<String, Value>>,
    ) -> impl Future<Output = Result<Value, ToolError>> {
        let answer = match name {
            "echo" => Some(Ok(json!({ "content": [], "structuredContent": arguments }))),
            "failing" => Some(Err(ToolError::Failed("it failed".into()))),
            "late" => None,
            _ => Some(Err(ToolError::NotFound)),
        };
        Later(answer)
    }
}

fn server(instructions: &str) -> Server<Catalogue> {
    let identity =
        Identity { name: "wb".into(), version: "9.9.9".into(), instructions: instructions.into() };
    Server::new(identity, Catalogue)
}

#[cfg(test)]
fn ask(server: &Server<Catalogue>, method: &str, params: &Value) -> Value {
    let message = json!({ "jsonrpc": "2.0", "id": 7, "method": method, "params": params });
    block_on(server.handle(&message)).expect("a request is answered")
}

fn initialize(version: &str) -> Value {
    json!({ "protocolVersion": version, "capabilities": {},
        "clientInfo": { "name": "c", "version": "1" } })
}

#[test]
fn initialize_answers_the_configured_identity() {
    let answer = ask(&server("Use the tools."), "initialize", &initialize("2024-11-05"));
    assert_eq!(
        answer["result"],
        json!({ "protocolVersion": "2024-11-05",
            "capabilities": { "logging": {}, "tools": { "listChanged": true } },
            "serverInfo": { "name": "wb", "version": "9.9.9" },
            "instructions": "Use the tools." })
    );
}

#[test]
fn empty_instructions_are_left_out() {
    let answer = ask(&server(""), "initialize", &initialize("2025-11-25"));
    assert!(answer["result"].get("instructions").is_none(), "{answer}");
}

#[test]
fn the_server_keeps_the_negotiated_version() {
    let server = server("");
    assert_eq!(server.protocol_version(), None);
    ask(&server, "initialize", &initialize("2025-03-26"));
    assert_eq!(server.protocol_version(), Some("2025-03-26"));
    ask(&server, "initialize", &initialize("1999-01-01"));
    assert_eq!(server.protocol_version(), Some("2025-11-25"));
    ask(&server, "initialize", &json!({}));
    assert_eq!(
        server.protocol_version(),
        Some("2025-11-25"),
        "a refused initialize changes nothing"
    );
}

#[test]
fn the_server_keeps_the_log_level_last_set() {
    let server = server("");
    assert_eq!(server.log_level(), None);
    let names = ["debug", "info", "notice", "warning", "error", "critical", "alert", "emergency"];
    let mut previous = None;
    for name in names {
        ask(&server, "logging/setLevel", &json!({ "level": name }));
        let level = server.log_level().expect("a level");
        assert_eq!(level.name(), name);
        assert!(previous < Some(level), "{name} is more severe than the level before it");
        previous = Some(level);
    }
    ask(&server, "logging/setLevel", &json!({ "level": "loud" }));
    assert_eq!(server.log_level(), Some(LogLevel::Emergency), "a refused level changes nothing");
}

#[test]
fn a_tool_result_is_answered_as_the_catalogue_answers_it() {
    let server = server("");
    let echo = ask(&server, "tools/call", &json!({ "name": "echo", "arguments": { "a": [1] } }));
    assert_eq!(echo["result"], json!({ "content": [], "structuredContent": { "a": [1] } }));
    let bare = ask(&server, "tools/call", &json!({ "name": "echo" }));
    assert_eq!(bare["result"], json!({ "content": [], "structuredContent": null }));
    let late = ask(&server, "tools/call", &json!({ "name": "late" }));
    assert_eq!(late["result"], json!({ "content": [], "late": true }));
}

#[test]
fn a_tool_failure_is_a_result_carrying_its_text() {
    let answer = ask(&server(""), "tools/call", &json!({ "name": "failing" }));
    assert_eq!(
        answer["result"],
        json!({ "content": [{ "type": "text", "text": "it failed" }], "isError": true })
    );
}

#[test]
fn tools_list_answers_the_catalogue_in_order() {
    let answer = ask(&server(""), "tools/list", &json!({ "cursor": "ignored" }));
    assert_eq!(answer["result"], json!({ "tools": [{ "name": "echo" }, { "name": "failing" }] }));
}

#[test]
#[cfg(not(target_arch = "wasm32"))]
fn handling_a_message_can_move_between_threads() {
    fn sends<T: Send>(_: &T) {}
    let server = server("");
    let message = json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" });
    let future = server.handle(&message);
    sends(&future);
    assert_eq!(block_on(future), Some(json!({ "jsonrpc": "2.0", "id": 1, "result": {} })));
}
