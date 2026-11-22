//! Fakes of the ports, for a test of an operation to run it over (ADR-0054
//! decision 1: an operation sees only ports, so a test supplies them).
//!
//! A dev-dependency only, and std only: no executor and no random source, so
//! the same fakes serve a native test and a wasm32 one. Each is deterministic,
//! which is what makes a test over them repeatable.

mod block_on;
mod fixed_clock;
mod keyed_lock;
mod seq_id_mint;
#[cfg(test)]
mod within;

pub use block_on::block_on;
pub use fixed_clock::FixedClock;
pub use keyed_lock::{Acquire, KeyedGuard, KeyedLock};
pub use seq_id_mint::SeqIdMint;
