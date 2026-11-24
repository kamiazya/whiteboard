//! Fakes of the ports, for a test of an operation to run it over (ADR-0054
//! decision 1: an operation sees only ports, so a test supplies them).
//!
//! A dev-dependency only, and std only: no executor and no random source, so
//! the same fakes serve a native test and a wasm32 one. Each is deterministic,
//! which is what makes a test over them repeatable.

mod block_on;
mod fixed_caller;
mod fixed_clock;
mod keyed_lock;
mod memory_record_store;
mod memory_registry;
mod memory_version_store;
mod recording_notifier;
mod seq_id_mint;
#[cfg(test)]
mod within;

pub use block_on::block_on;
pub use fixed_caller::FixedCaller;
pub use fixed_clock::FixedClock;
pub use keyed_lock::{Acquire, KeyedGuard, KeyedLock};
pub use memory_record_store::MemoryRecordStore;
pub use memory_registry::MemoryRegistry;
pub use memory_version_store::MemoryVersionStore;
pub use recording_notifier::RecordingNotifier;
pub use seq_id_mint::SeqIdMint;
