//! The server: one request in, its answer out.

use std::sync::{Mutex, MutexGuard, PoisonError};

use serde_json::{Map, Value, json};

use crate::jsonrpc::{self, Request, SUPPORTED_PROTOCOL_VERSIONS, code};
use crate::{ToolCatalogue, ToolError, params, schema};

/// Who the server says it is at `initialize`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Identity {
    pub name: String,
    pub version: String,
    /// The `instructions` a client puts before the model; an empty text is
    /// left out of the answer, as the SDK leaves it out.
    pub instructions: String,
}

/// The RFC 5424 levels `logging/setLevel` names, least severe first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum LogLevel {
    Debug,
    Info,
    Notice,
    Warning,
    Error,
    Critical,
    Alert,
    Emergency,
}

impl LogLevel {
    const ALL: [Self; 8] = [
        Self::Debug,
        Self::Info,
        Self::Notice,
        Self::Warning,
        Self::Error,
        Self::Critical,
        Self::Alert,
        Self::Emergency,
    ];

    /// The level's name on the wire.
    pub const fn name(self) -> &'static str {
        match self {
            Self::Debug => "debug",
            Self::Info => "info",
            Self::Notice => "notice",
            Self::Warning => "warning",
            Self::Error => "error",
            Self::Critical => "critical",
            Self::Alert => "alert",
            Self::Emergency => "emergency",
        }
    }

    fn named(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|level| level.name() == name)
    }
}

/// What a connection has told the server so far.
#[derive(Debug, Default)]
struct Session {
    protocol_version: Option<&'static str>,
    log_level: Option<LogLevel>,
}

/// A refused request: its JSON-RPC error code and message.
struct Refused {
    code: i64,
    message: String,
}

impl Refused {
    fn new(code: i64, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}

/// One connection's server: the 2025-era MCP protocol over `catalogue`.
pub struct Server<C> {
    identity: Identity,
    catalogue: C,
    session: Mutex<Session>,
}

impl<C: ToolCatalogue> Server<C> {
    pub fn new(identity: Identity, catalogue: C) -> Self {
        Self { identity, catalogue, session: Mutex::new(Session::default()) }
    }

    /// The version the last `initialize` settled on, if one has.
    pub fn protocol_version(&self) -> Option<&'static str> {
        self.session().protocol_version
    }

    /// The level the last `logging/setLevel` asked for, if one has: the
    /// threshold below which a log notification is not sent.
    pub fn log_level(&self) -> Option<LogLevel> {
        self.session().log_level
    }

    /// The answer to one inbound message, or `None` when it draws none (a
    /// notification, a response, or a message that is not a request).
    ///
    /// The future is `Send` natively whenever the catalogue's is, so a
    /// daemon may move it between threads; nothing is asked of it on wasm32.
    pub async fn handle(&self, message: &Value) -> Option<Value> {
        let request = jsonrpc::request(message)?;
        let id = request.id.clone();
        Some(match self.answer(request).await {
            Ok(result) => jsonrpc::result(id, result),
            Err(refused) => jsonrpc::error(id, refused.code, refused.message),
        })
    }

    async fn answer(&self, request: Request<'_>) -> Result<Value, Refused> {
        let params = request.params;
        match request.method {
            "initialize" => self.initialize(params),
            "ping" => Ok(json!({})),
            "logging/setLevel" => self.set_level(params),
            "tools/list" => self.list_tools(params),
            "tools/call" => self.call_tool(params).await,
            _ => Err(Refused::new(code::METHOD_NOT_FOUND, "Method not found")),
        }
    }

    fn initialize(&self, params: Option<&Value>) -> Result<Value, Refused> {
        refuse_internal(&params::INITIALIZE, params)?;
        let requested = params.and_then(|p| p.get("protocolVersion")).and_then(Value::as_str);
        let [latest, ..] = SUPPORTED_PROTOCOL_VERSIONS;
        let version = SUPPORTED_PROTOCOL_VERSIONS
            .into_iter()
            .find(|v| Some(*v) == requested)
            .unwrap_or(latest);
        self.session().protocol_version = Some(version);
        let mut result = Map::new();
        result.insert("protocolVersion".into(), version.into());
        result.insert(
            "capabilities".into(),
            json!({ "logging": {}, "tools": { "listChanged": true } }),
        );
        let Identity { name, version, instructions } = &self.identity;
        result.insert("serverInfo".into(), json!({ "name": name, "version": version }));
        if !instructions.is_empty() {
            result.insert("instructions".into(), instructions.as_str().into());
        }
        Ok(Value::Object(result))
    }

    fn set_level(&self, params: Option<&Value>) -> Result<Value, Refused> {
        refuse_internal(&params::SET_LEVEL, params)?;
        let level = params.and_then(|p| p.get("level")).and_then(Value::as_str);
        self.session().log_level = level.and_then(LogLevel::named);
        Ok(json!({}))
    }

    fn list_tools(&self, params: Option<&Value>) -> Result<Value, Refused> {
        if params.is_some() {
            refuse_internal(&params::PAGINATED, params)?;
        }
        Ok(json!({ "tools": self.catalogue.tools() }))
    }

    async fn call_tool(&self, params: Option<&Value>) -> Result<Value, Refused> {
        if let Some(message) = schema::refusal(&params::CALL_TOOL, params) {
            let message = format!("Invalid tools/call request: {message}");
            return Err(Refused::new(code::INVALID_PARAMS, message));
        }
        let name = params.and_then(|p| p.get("name")).and_then(Value::as_str).unwrap_or_default();
        let arguments = params.and_then(|p| p.get("arguments")).and_then(Value::as_object);
        match self.catalogue.call(name, arguments).await {
            Ok(result) => Ok(result),
            Err(ToolError::NotFound) => {
                Err(Refused::new(code::INVALID_PARAMS, format!("Tool {name} not found")))
            }
            Err(ToolError::Refused(refusal)) => Ok(tool_error(&refusal.message())),
            Err(ToolError::Failed(text)) => Ok(tool_error(&text)),
        }
    }

    fn session(&self) -> MutexGuard<'_, Session> {
        // Nothing panics while holding the lock, so it is never poisoned.
        self.session.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// The SDK's own refusal of a request's params: a plain error, so code
/// `-32603` and Zod's message as the whole message.
fn refuse_internal(shape: &schema::Shape, params: Option<&Value>) -> Result<(), Refused> {
    match schema::refusal(shape, params) {
        Some(message) => Err(Refused::new(code::INTERNAL_ERROR, message)),
        None => Ok(()),
    }
}

/// A tool's failure as the result the TypeScript's tool wrapper answers.
fn tool_error(text: &str) -> Value {
    json!({ "content": [{ "type": "text", "text": text }], "isError": true })
}
