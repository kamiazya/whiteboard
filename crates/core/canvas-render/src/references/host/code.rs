//! The code tokenizer over the wire: the core gates a fence as the default
//! highlighter does and colours it from the tokens the caller sent; the
//! highlighter itself is the caller's.

use super::WireHost;
use crate::highlight::would_colour;
use crate::typeset::{CodeTokenLines, CodeTokenizer, NestedLayoutBudget};

impl CodeTokenizer for WireHost<'_> {
    fn tokenize(
        &self,
        lang: &str,
        value: &str,
        budget: Option<&NestedLayoutBudget>,
    ) -> Option<CodeTokenLines> {
        if !would_colour(lang, value, budget) {
            return None;
        }
        let sent = self.code.iter().rev().find(|fence| fence.lang == lang && fence.value == value);
        if let Some(fence) = sent {
            return fence.lines.clone();
        }
        let mut needs = self.needs.borrow_mut();
        if !needs.iter().any(|(l, v)| l == lang && v == value) {
            needs.push((lang.to_owned(), value.to_owned()));
        }
        // The body drawn plain for want of these tokens is this call's alone,
        // so a content cache must not keep it.
        budget.inspect(|budget| budget.refuse());
        None
    }
}
