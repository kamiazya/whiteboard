//! The `[[…]]`/`![[…]]` reference syntax (`packages/codec/src/references`):
//! the grammar's one scanner ([`find_next_reference`], held to the TypeScript
//! scanner `scan.ts` the shared packages still call), and the pass that turns
//! what it finds in a parsed body's text into wiki links and embeds
//! ([`resolve_references`]), which has no TypeScript twin.

mod resolve;
mod scan;

pub use resolve::resolve_references;
pub use scan::{ReferenceMatch, find_next_reference};
