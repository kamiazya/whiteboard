//! The `[[…]]`/`![[…]]` reference syntax (`packages/codec/src/references`):
//! the grammar's one scanner ([`find_next_reference`], `scan.ts`), and the pass
//! that turns what it finds in a parsed body's text into wiki links and embeds
//! ([`resolve_references`], `resolve.ts`).

mod resolve;
mod scan;

pub use resolve::resolve_references;
pub use scan::{ReferenceMatch, find_next_reference};
