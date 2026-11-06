//! The same words as `comment-violations.rs`, in literals only: a comment rule
//! reads comments, and a string is not one.

pub const A: &str = "// Raised in this PR to cover the empty board.";
pub const B: &str = r#"/// Kept for a "paired" browser"#;
pub const C: &str = "/* Moved here from `gone_module.rs` */";
pub const D: &[u8] = b"/// Mirrors `GONE_CONSTANT_NAME`";
pub const E: &str = r##"the document's slug, "# and #1234"##;
pub const F: &str = r#"
/// Kept for a paired browser, on a line of its own inside a raw string.
// Raised in this PR, and so is #1234.
"#;
