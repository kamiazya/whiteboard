use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::task::{Context, Poll, Waker};

use whiteboard_ports::{MaybeSend, WorkspaceLock};

/// Who is queued for one key. The front owns it: it holds the lock once its
/// future has been polled, and is next to when the one before it lets go.
#[derive(Default)]
struct Queue {
    tickets: VecDeque<u64>,
    wakers: HashMap<u64, Waker>,
}

#[derive(Default)]
struct State {
    next_ticket: u64,
    queues: HashMap<String, Queue>,
}

/// A poisoned lock is still a consistent one: every critical section here
/// leaves the queues valid before it can panic.
fn locked(state: &Mutex<State>) -> MutexGuard<'_, State> {
    state.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Hands the key to the next in line, and forgets the key once nobody is.
fn release(state: &Mutex<State>, key: &str, ticket: u64) {
    let next = {
        let mut state = locked(state);
        let Some(queue) = state.queues.get_mut(key) else {
            return;
        };
        queue.tickets.retain(|t| *t != ticket);
        queue.wakers.remove(&ticket);
        let next = queue.tickets.front().and_then(|front| queue.wakers.get(front)).cloned();
        if queue.tickets.is_empty() {
            state.queues.remove(key);
        }
        next
    };
    // Outside the lock, so a waker that polls at once cannot deadlock on it.
    if let Some(waker) = next {
        waker.wake();
    }
}

/// An exclusive lock per key: callers for one key hold it one at a time, in the
/// order they asked, and a different key never waits on it. The in-memory twin
/// of `KeyedSerializer` and `withWriteLock`, as a guard.
///
/// A holder that returns early, fails or panics releases by dropping its guard,
/// and a caller that gives up before it was granted the lock leaves the queue
/// without stalling those behind it. Not reentrant.
///
/// The place in line is taken when the lock is asked for, not when its future
/// is first polled, so submission order is call order as it is in the
/// TypeScript.
#[derive(Clone, Default)]
pub struct KeyedLock {
    state: Arc<Mutex<State>>,
}

impl KeyedLock {
    /// A lock nobody holds.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Keys with a holder or a waiter: the map's size is the work in flight,
    /// not every key ever seen.
    #[must_use]
    pub fn pending_keys(&self) -> usize {
        locked(&self.state).queues.len()
    }

    /// Takes a place in line for `key` now; the future resolves when it is
    /// reached.
    #[must_use]
    pub fn acquire(&self, key: &str) -> Acquire {
        let mut state = locked(&self.state);
        let ticket = state.next_ticket;
        state.next_ticket += 1;
        state.queues.entry(key.to_owned()).or_default().tickets.push_back(ticket);
        Acquire { state: Arc::clone(&self.state), key: key.to_owned(), ticket, granted: false }
    }
}

impl WorkspaceLock for KeyedLock {
    type Guard = KeyedGuard;

    fn lock(&self, workspace: &str) -> impl Future<Output = KeyedGuard> + MaybeSend {
        self.acquire(workspace)
    }
}

/// A place in line. Dropping it before it resolves gives the place up.
pub struct Acquire {
    state: Arc<Mutex<State>>,
    key: String,
    ticket: u64,
    granted: bool,
}

impl Future for Acquire {
    type Output = KeyedGuard;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<KeyedGuard> {
        let this = self.get_mut();
        let mut state = locked(&this.state);
        let queue = state.queues.entry(this.key.clone()).or_default();
        if queue.tickets.front() == Some(&this.ticket) {
            queue.wakers.remove(&this.ticket);
            this.granted = true;
            return Poll::Ready(KeyedGuard {
                state: Arc::clone(&this.state),
                key: this.key.clone(),
                ticket: this.ticket,
            });
        }
        queue.wakers.insert(this.ticket, cx.waker().clone());
        Poll::Pending
    }
}

impl Drop for Acquire {
    fn drop(&mut self) {
        // A granted place belongs to its guard now.
        if !self.granted {
            release(&self.state, &self.key, self.ticket);
        }
    }
}

/// The lock on one key, held until this drops.
pub struct KeyedGuard {
    state: Arc<Mutex<State>>,
    key: String,
    ticket: u64,
}

impl Drop for KeyedGuard {
    fn drop(&mut self) {
        release(&self.state, &self.key, self.ticket);
    }
}

#[cfg(test)]
mod tests;
