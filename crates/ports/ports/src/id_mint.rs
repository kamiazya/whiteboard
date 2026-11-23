//! Identity and randomness are a port: core never draws a random number.

/// Where a peer id and random bytes come from. Synchronous: both read local
/// entropy.
pub trait IdMint {
    /// A CRDT peer id for a new document session.
    fn peer_id(&self) -> u64;

    /// `len` random bytes, for ids and tokens.
    fn random_bytes(&self, len: usize) -> Vec<u8>;
}
