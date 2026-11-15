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
        if let Some(lines) = self.code.get(&(lang, value)) {
            return (*lines).clone();
        }
        let fence = (lang.to_owned(), value.to_owned());
        let asked = &mut *self.needs.borrow_mut();
        if asked.seen.insert(fence.clone()) {
            asked.order.push(fence);
        }
        // The body drawn plain for want of these tokens is this call's alone,
        // so a content cache must not keep it.
        budget.inspect(|budget| budget.refuse());
        None
    }
}
