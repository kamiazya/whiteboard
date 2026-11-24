//! What every operation is, and the row that describes it.

use std::future::Future;

use whiteboard_api_contracts::Refusal;
use whiteboard_ports::MaybeSend;

use crate::Ports;

/// One operation: a typed input, a typed output, and `execute` over ports.
pub trait Operation {
    type Input;
    type Output;

    /// What the table says of it.
    const ROW: Row;

    fn execute<P: Ports>(
        ports: &P,
        input: Self::Input,
    ) -> impl Future<Output = Result<Self::Output, Refusal>> + MaybeSend;
}

/// An operation as the table holds it: what reaches it, and the contracts of
/// what goes in and comes out.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Row {
    /// The operation's name, as server-core exports it.
    pub name: &'static str,
    /// The MCP tool that calls it, if one does.
    pub tool: Option<&'static str>,
    /// The `/api/v1` route that calls it, if one does.
    pub route: Option<Route>,
    pub input: Contract,
    pub output: Contract,
}

/// An HTTP route: its method and its path pattern, `:name` for a parameter.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Route {
    pub method: Method,
    pub path: &'static str,
}

/// The methods the table's routes use.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Get,
}

/// A contract the operation's input or output is held to, named by the
/// server-core schema it mirrors.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Contract {
    pub schema: &'static str,
}
