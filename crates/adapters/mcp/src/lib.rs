//! The MCP protocol as a transport-agnostic JSON-RPC dispatcher (ADR-0054,
//! the `adapters` layer): a stdio loop or an HTTP handler hands
//! [`Server::handle`] one parsed message and writes back the answer, if any.
//! The oracle is the `@modelcontextprotocol/server` `McpServer` that
//! `packages/mcp-server` builds, as it answers over a connection.
//!
//! What it is, and where its edges are:
//!
//! - **The 2025-era protocol, one server per connection.** `initialize`
//!   negotiates from [`SUPPORTED_PROTOCOL_VERSIONS`] (a version not listed is
//!   answered with the first, `2026-07-28` included: the SDK negotiates the
//!   modern revision through `server/discover` on a separately constructed
//!   instance, which its stdio and HTTP entries choose per connection). The
//!   SDK gates nothing on the handshake, so neither does this: every method
//!   is served before `initialize` and after a second one.
//! - **Only requests are answered.** The SDK holds an inbound message to a
//!   union of strict schemas and drops what no member takes (a batch, an id
//!   that is not a string or a safe integer, an unknown top-level key,
//!   params that are not an object) without a word on the wire; a
//!   notification is never answered. Bytes that are not JSON never reach
//!   the dispatcher: the stdio transport drops such a line and the HTTP one
//!   answers `-32700` itself, so parsing is the transport's.
//! - **A request's params are judged as Zod judges them** (`schema`,
//!   `params`): every issue, in the schema's key order, in Zod's own
//!   message. A record's keys are visited in `serde_json`'s order, which is
//!   sorted, where Zod visits them in the client's (integer-like keys
//!   first): a record with several faulty members lists them in another
//!   order than the TypeScript does.
//! - **Tools are a seam** ([`ToolCatalogue`]): `tools/list` answers its
//!   list whole (the SDK never paginates), and `tools/call` routes to it. An
//!   unknown tool is a JSON-RPC error; a [`Refusal`](whiteboard_api_contracts::Refusal)
//!   is a result with `isError`, its text the refusal's sentence, which is
//!   how the TypeScript's tool wrapper answers a throw. [`OpsCatalogue`]
//!   is the catalogue over the ops table: the ported tools as
//!   `contracts/tools` publishes them, each call judged, its workspace
//!   address resolved, run and answered as the TypeScript's wrapper answers
//!   it; [`PENDING_TOOLS`] names the rest, of which [`PARTLY_BOUND_TOOLS`]
//!   are reached by a call and answer what their operation ports.
//! - **What is served**: `initialize`, `ping`, `logging/setLevel` (its level
//!   kept for the notifier, [`Server::log_level`]), `tools/list` and
//!   `tools/call`, and `Method not found` for anything else. The prompt and
//!   the MCP Apps resource (`prompts/*`, `resources/*`) and the capabilities
//!   announcing them belong to later slices. A cancelled request is the
//!   driver's: it holds each in-flight [`Server::handle`] future by id and
//!   drops the one `notifications/cancelled` names, which the SDK answers by
//!   never answering.
//! - `handle` is `async` over the catalogue and `MaybeSend`; no executor is
//!   named here. The session state is behind a lock held only between
//!   awaits.

mod catalogue;
mod dispatch;
mod jsonrpc;
mod params;
mod schema;
mod tools;

pub use catalogue::{ToolCatalogue, ToolError};
pub use dispatch::{Identity, LogLevel, Server};
pub use jsonrpc::{SUPPORTED_PROTOCOL_VERSIONS, code};
pub use tools::{OpsCatalogue, PARTLY_BOUND_TOOLS, PENDING_TOOLS};
