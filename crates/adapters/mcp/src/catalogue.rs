//! The seam `tools/list` and `tools/call` are routed to: the tool table the
//! ops layer will implement, and what a call can answer.

use std::future::Future;

use serde_json::{Map, Value};
use whiteboard_api_contracts::Refusal;
use whiteboard_ports::{MaybeSend, MaybeSync};

/// The tools a server offers, and the calling of one.
pub trait ToolCatalogue: MaybeSync {
    /// The `tools` `tools/list` answers with, in order. The list is never
    /// paginated: the SDK's server ignores a cursor and answers every tool.
    fn tools(&self) -> Vec<Value>;

    /// Calls the tool `name` with the `arguments` the request carried. A
    /// tool's result is the `CallToolResult` it answers, as it answers it.
    fn call(
        &self,
        name: &str,
        arguments: Option<&Map<String, Value>>,
    ) -> impl Future<Output = Result<Value, ToolError>> + MaybeSend;
}

/// Why a call has no result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolError {
    /// No tool of that name: a JSON-RPC error, `Tool <name> not found`.
    NotFound,
    /// The tool refused: answered as a result with `isError`, its text the
    /// refusal's sentence, as the TypeScript's tool wrapper answers a throw.
    Refused(Refusal),
    /// The tool failed with a text of its own, such as the SDK's input
    /// validation error: answered as a refusal is.
    Failed(String),
}
