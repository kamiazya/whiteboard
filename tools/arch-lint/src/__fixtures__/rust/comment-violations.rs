//! Each comment here breaks one comment rule, and the guard tests read each
//! one back by line.

// Raised in this PR to cover the empty board.
pub const A: u32 = 1;

/// Kept for a paired browser that still holds a token.
pub const B: u32 = 2;

/* Moved here from `gone_module.rs`, which no longer exists. */
pub const C: u32 = 3;

/// Mirrors `GONE_CONSTANT_NAME` on the TypeScript side.
pub const D: u32 = 4;

/// The document's slug, as a path segment.
pub const E: u32 = 5; // and a trailing comment on #1234
