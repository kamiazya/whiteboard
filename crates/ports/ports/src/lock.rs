//! One writer at a time per workspace.

use std::future::Future;

use crate::MaybeSend;

/// Serialises writers to one workspace. Natively an async mutex per workspace;
/// on Workers the Durable Object itself, which is why this is a port.
///
/// The lock is a guard, not a callback: it is held until the guard drops, so a
/// writer that returns early, fails or is cancelled releases it without any
/// cooperation, and no operation has to be shaped as a closure the lock calls.
///
/// Not reentrant: an operation that locks the workspace it already holds waits
/// for itself.
pub trait WorkspaceLock {
    /// What holds the lock; dropping it releases.
    type Guard: MaybeSend;

    /// Resolves once every earlier caller for `workspace` has dropped its
    /// guard, in the order the calls were made. Different workspaces never
    /// wait for one another.
    fn lock(&self, workspace: &str) -> impl Future<Output = Self::Guard> + MaybeSend;
}
