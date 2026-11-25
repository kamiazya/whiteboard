use std::sync::atomic::{AtomicU64, Ordering};

use whiteboard_ports::IdMint;

/// An id mint whose answers count up, so a test can name the id it expects.
#[derive(Debug)]
pub struct SeqIdMint {
    next_peer: AtomicU64,
    /// How far each peer id moves the next: 1, or 0 for one replica throughout.
    step: u64,
    next_byte: AtomicU64,
}

impl SeqIdMint {
    /// A mint whose first peer id is `first_peer`, and whose bytes start at 0.
    #[must_use]
    pub fn new(first_peer: u64) -> Self {
        Self { next_peer: AtomicU64::new(first_peer), step: 1, next_byte: AtomicU64::new(0) }
    }

    /// A mint answering `peer` for every peer id, as a keeper whose every
    /// record writes as one replica does.
    #[must_use]
    pub fn one_peer(peer: u64) -> Self {
        Self { next_peer: AtomicU64::new(peer), step: 0, next_byte: AtomicU64::new(0) }
    }

    /// Restarts the bytes at `next`, as a recording that starts each call's
    /// draws at its own position does.
    pub fn draw_from(&self, next: u64) {
        self.next_byte.store(next, Ordering::SeqCst);
    }
}

impl IdMint for SeqIdMint {
    fn peer_id(&self) -> u64 {
        self.next_peer.fetch_add(self.step, Ordering::SeqCst)
    }

    /// The bytes 0, 1, 2, … wrapping at 256, continuing across calls.
    fn random_bytes(&self, len: usize) -> Vec<u8> {
        (0..len).map(|_| self.next_byte.fetch_add(1, Ordering::SeqCst).to_le_bytes()[0]).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn peer_ids_count_up_from_the_first() {
        let mint = SeqIdMint::new(7);
        assert_eq!([mint.peer_id(), mint.peer_id(), mint.peer_id()], [7, 8, 9]);
    }

    #[test]
    fn one_peer_answers_the_same_id_every_time() {
        let mint = SeqIdMint::one_peer(42);
        assert_eq!([mint.peer_id(), mint.peer_id(), mint.peer_id()], [42, 42, 42]);
    }

    #[test]
    fn bytes_restart_where_they_are_told_to() {
        let mint = SeqIdMint::new(0);
        mint.random_bytes(5);
        mint.draw_from(300);
        assert_eq!(mint.random_bytes(2), vec![44, 45]);
    }

    #[test]
    fn bytes_continue_across_calls_and_wrap_at_256() {
        let mint = SeqIdMint::new(0);
        assert_eq!(mint.random_bytes(3), vec![0, 1, 2]);
        assert_eq!(mint.random_bytes(0), Vec::<u8>::new());
        assert_eq!(mint.random_bytes(2), vec![3, 4]);
        let rest = mint.random_bytes(254);
        assert_eq!((rest.first(), rest.last()), (Some(&5), Some(&2)));
        assert_eq!(rest.len(), 254);
    }

    #[test]
    fn peer_ids_and_bytes_do_not_share_a_counter() {
        let mint = SeqIdMint::new(100);
        assert_eq!(mint.random_bytes(2), vec![0, 1]);
        assert_eq!(mint.peer_id(), 100);
    }
}
