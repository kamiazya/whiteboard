//! The code tokenizer over the wire: the highlighter is not in the core.

use super::{Refused, WireHost};
use crate::typeset::{CodeTokenLines, CodeTokenizer};

impl CodeTokenizer for WireHost<'_> {
    /// A fence with no language is plain to the TypeScript's highlighter too;
    /// any other is the highlighter's to colour.
    fn tokenize(&self, lang: &str, _: &str) -> Option<CodeTokenLines> {
        if !lang.is_empty() {
            self.refuse(Refused::Highlight);
        }
        None
    }
}
