//! Who a call is served for, as far as an address needs to know.

use std::future::Future;

use crate::{MaybeSend, PortError};

/// The namespace a single-person keeper (the browser, the local daemon) holds
/// every workspace in (ADR-0053 decision 2).
pub const SINGLE_PERSON_NAMESPACE: &str = "me";

/// The caller of one call, as the composition root that admitted it knows
/// them: a tool call carries no request to read them from.
pub trait Caller {
    /// Whose namespace a bare segment means for this caller: `me` on a
    /// single-person keeper, the signed-in person's handle on a keeper many
    /// people share. Asked rather than assumed, because the keeper's own gate
    /// resolved the same address already, and answering in another namespace
    /// would hand the call a workspace nobody authorised it for.
    fn namespace(&self) -> impl Future<Output = Result<String, PortError>> + MaybeSend;

    /// The workspace handles a refusal for an unknown workspace may name, so a
    /// caller that guessed an address learns the right one. `None` says
    /// nothing about which exist, the safe answer for a keeper whose callers
    /// may not see every workspace; only a composition whose caller may
    /// already see them all answers a list.
    fn known_workspace_handles(
        &self,
    ) -> impl Future<Output = Result<Option<Vec<String>>, PortError>> + MaybeSend;
}
