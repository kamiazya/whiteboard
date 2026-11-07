//! The logging facade core code writes through.
//!
//! Levels are RFC 5424's eight, by name, so a record can be forwarded
//! unchanged as an MCP `notifications/message` and written in the same JSON
//! line shape the TypeScript server's logger writes. `tracing`'s five levels
//! would lose `notice`, `critical`, `alert` and `emergency`.

// Core is total: an out-of-bounds index or an overflowing integer is a
// panic, and a panic poisons the wasm instance. A justified exception is an
// `#[expect(..., reason = "...")]` on the one expression, never a blanket
// allow. Test builds are exempt; clippy's non-test pass still checks every
// line of production code.
#![cfg_attr(not(test), deny(clippy::indexing_slicing, clippy::arithmetic_side_effects))]

/// An RFC 5424 severity. Ordered from least to most severe, so a threshold
/// reads `level >= minimum`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Level {
    Debug,
    Info,
    Notice,
    Warning,
    Error,
    Critical,
    Alert,
    Emergency,
}

impl Level {
    /// Every level, least severe first.
    pub const ALL: [Level; 8] = [
        Level::Debug,
        Level::Info,
        Level::Notice,
        Level::Warning,
        Level::Error,
        Level::Critical,
        Level::Alert,
        Level::Emergency,
    ];

    /// The RFC 5424 numeric severity: 0 is `emergency`, 7 is `debug`.
    #[must_use]
    pub fn severity(self) -> u8 {
        match self {
            Level::Emergency => 0,
            Level::Alert => 1,
            Level::Critical => 2,
            Level::Error => 3,
            Level::Warning => 4,
            Level::Notice => 5,
            Level::Info => 6,
            Level::Debug => 7,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Level;
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    #[test]
    fn order_runs_from_least_to_most_severe() {
        let mut sorted = Level::ALL;
        sorted.sort();
        assert_eq!(sorted, Level::ALL);
        assert!(Level::Warning >= Level::Notice);
        assert!(Level::Debug < Level::Info);
    }

    #[test]
    fn order_is_the_inverse_of_rfc_5424_severity() {
        let severities: Vec<u8> = Level::ALL.iter().map(|l| l.severity()).collect();
        assert_eq!(severities, vec![7, 6, 5, 4, 3, 2, 1, 0]);
    }
}
