//! The work a parse may do, and the refusal that stops it.

use crate::limits::Refusal;
use core::cell::Cell;

/// Fuel and the first reason a parse was stopped.
///
/// Every loop whose length depends on the text charges it, so a parse is
/// bounded by construction instead of by a timer, and once it is out nothing
/// after it does any more work: each loop and each phase checks
/// [`Budget::refusal`] and returns.
#[derive(Debug)]
pub(crate) struct Budget {
    /// Units left.
    fuel: Cell<usize>,
    /// Units spent.
    spent: Cell<usize>,
    /// Why the parse stopped, if it did.
    refusal: Cell<Option<Refusal>>,
}

impl Budget {
    /// A budget of `fuel` units.
    pub(crate) fn new(fuel: usize) -> Budget {
        Budget { fuel: Cell::new(fuel), spent: Cell::new(0), refusal: Cell::new(None) }
    }

    /// Charge `units`: whether the parse may go on.
    pub(crate) fn spend(&self, units: usize) -> bool {
        if self.refusal.get().is_some() {
            return false;
        }
        let left = self.fuel.get();
        if units > left {
            self.fuel.set(0);
            self.refusal.set(Some(Refusal::TooCostly));
            return false;
        }
        self.fuel.set(left - units);
        self.spent.set(self.spent.get().saturating_add(units));
        true
    }

    /// Stop the parse: the first reason is the one kept.
    pub(crate) fn refuse(&self, why: Refusal) {
        if self.refusal.get().is_none() {
            self.refusal.set(Some(why));
        }
    }

    /// Why the parse stopped, if it did.
    pub(crate) fn refusal(&self) -> Option<Refusal> {
        self.refusal.get()
    }

    /// Units spent so far.
    pub(crate) fn spent(&self) -> usize {
        self.spent.get()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    // On wasm32 the same tests run under Node (QR-21 layer 3).
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    #[test]
    fn spending_within_the_fuel_is_allowed_and_counted() {
        let budget = Budget::new(10);
        assert!(budget.spend(4));
        assert!(budget.spend(6));
        assert_eq!(budget.spent(), 10);
        assert_eq!(budget.refusal(), None);
    }

    #[test]
    fn spending_past_the_fuel_refuses_for_cost_and_spends_nothing_of_it() {
        let budget = Budget::new(10);
        assert!(budget.spend(7));
        assert!(!budget.spend(4));
        assert_eq!(budget.refusal(), Some(Refusal::TooCostly));
        assert_eq!(budget.spent(), 7);
    }

    #[test]
    fn once_refused_nothing_is_spent_again() {
        let budget = Budget::new(10);
        budget.refuse(Refusal::TooDeep);
        assert!(!budget.spend(1));
        assert_eq!(budget.spent(), 0);
        assert_eq!(budget.refusal(), Some(Refusal::TooDeep));
    }

    #[test]
    fn the_first_reason_is_kept() {
        let budget = Budget::new(0);
        budget.refuse(Refusal::TooDeep);
        budget.refuse(Refusal::TooCostly);
        assert!(!budget.spend(1));
        assert_eq!(budget.refusal(), Some(Refusal::TooDeep));
    }

    #[test]
    fn spending_exactly_the_fuel_is_allowed() {
        let budget = Budget::new(3);
        assert!(budget.spend(3));
        assert!(!budget.spend(1));
    }
}
