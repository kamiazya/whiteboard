use std::sync::atomic::{AtomicU64, Ordering};

use whiteboard_ports::Clock;

/// A clock that reads what a test set and moves only when told to.
#[derive(Debug)]
pub struct FixedClock {
    // The bits of an f64, so the clock is Sync without a lock.
    bits: AtomicU64,
}

impl FixedClock {
    /// A clock reading `ms`.
    #[must_use]
    pub fn new(ms: f64) -> Self {
        Self { bits: AtomicU64::new(ms.to_bits()) }
    }

    /// Moves the clock to `ms`.
    pub fn set(&self, ms: f64) {
        self.bits.store(ms.to_bits(), Ordering::SeqCst);
    }

    /// Moves the clock forward by `ms`, which may be negative.
    pub fn advance(&self, ms: f64) {
        self.set(self.now_ms() + ms);
    }
}

impl Clock for FixedClock {
    fn now_ms(&self) -> f64 {
        f64::from_bits(self.bits.load(Ordering::SeqCst))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use whiteboard_ports::PortError;

    #[test]
    fn it_reads_what_was_set_and_moves_only_when_told() {
        let clock = FixedClock::new(1_700_000_000_123.0);
        assert!((clock.now_ms() - 1_700_000_000_123.0).abs() < f64::EPSILON);
        assert!((clock.now_ms() - 1_700_000_000_123.0).abs() < f64::EPSILON);
        clock.advance(877.0);
        assert!((clock.now_ms() - 1_700_000_001_000.0).abs() < f64::EPSILON);
        clock.advance(-1_000.0);
        assert!((clock.now_ms() - 1_700_000_000_000.0).abs() < f64::EPSILON);
        clock.set(0.5);
        assert!((clock.now_ms() - 0.5).abs() < f64::EPSILON);
    }

    #[test]
    fn it_formats_through_the_port_and_refuses_an_unrepresentable_time() {
        let clock = FixedClock::new(1_700_000_000_123.0);
        assert_eq!(clock.now_iso().as_deref(), Ok("2023-11-14T22:13:20.123Z"));
        clock.advance(1.0);
        assert_eq!(clock.now_iso().as_deref(), Ok("2023-11-14T22:13:20.124Z"));
        clock.set(f64::NAN);
        assert_eq!(clock.now_iso(), Err(PortError::InvalidTime));
    }
}
