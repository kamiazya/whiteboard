//! The work a layout's edge routing may still do: canvas-render's
//! `layout/edges/routing-budget.ts`, ported as written. Counts are `f64`,
//! JavaScript's numbers, because the grid search spends its account in the
//! same unit as [`crate::grid_route::route_on_grid`]'s allowance.

/// The four accounts, as `RoutingBudget`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RoutingBudget {
    pub grid: f64,
    pub pairs: f64,
    pub trials: f64,
    pub repairs: f64,
}

const LAYOUT_GRID_TESTS: f64 = 64_000_000.0;
const LAYOUT_SEGMENT_PAIRS: f64 = 64_000_000.0;
const LAYOUT_TRIAL_VISITS: f64 = 200_000_000.0;
const LAYOUT_REPAIR_VISITS: f64 = 1_000_000.0;
const SEARCH_TRIAL_VISITS: f64 = 20_000_000.0;

/// As `PAIR_LOOKUP_VISITS`.
pub const PAIR_LOOKUP_VISITS: f64 = 8.0;

impl RoutingBudget {
    /// One layout's allowance, as `createRoutingBudget()`.
    #[must_use]
    pub const fn for_layout() -> Self {
        Self {
            grid: LAYOUT_GRID_TESTS,
            pairs: LAYOUT_SEGMENT_PAIRS,
            trials: LAYOUT_TRIAL_VISITS,
            repairs: LAYOUT_REPAIR_VISITS,
        }
    }
}

/// Which account [`spend`] draws on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Account {
    Trials,
    Repairs,
}

/// Takes `work` from `account`, or refuses and takes nothing.
pub fn spend(budget: &mut RoutingBudget, account: Account, work: f64) -> bool {
    let balance = match account {
        Account::Trials => &mut budget.trials,
        Account::Repairs => &mut budget.repairs,
    };
    if work > *balance {
        return false;
    }
    *balance -= work;
    true
}

/// One side-choice search's share of the layout's trials, as `searchShare`:
/// it refuses past its own share or past what the layout has left.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SearchShare {
    share: f64,
}

impl Default for SearchShare {
    fn default() -> Self {
        Self { share: SEARCH_TRIAL_VISITS }
    }
}

impl SearchShare {
    pub fn take(&mut self, budget: &mut RoutingBudget, work: f64) -> bool {
        if work > self.share || !spend(budget, Account::Trials, work) {
            return false;
        }
        self.share -= work;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::{Account, RoutingBudget, SearchShare, spend};
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    #[test]
    fn a_share_refuses_past_its_own_cap_and_past_the_layouts() {
        let mut budget = RoutingBudget::for_layout();
        let mut share = SearchShare::default();
        assert!(share.take(&mut budget, 19_000_000.0));
        assert!(!share.take(&mut budget, 2_000_000.0));
        assert!(spend(&mut budget, Account::Repairs, 1_000_000.0));
        assert!(!spend(&mut budget, Account::Repairs, 1.0));
        assert_eq!(budget.trials.to_bits(), 181_000_000.0_f64.to_bits());
    }
}
