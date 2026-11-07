//! The smallest binary min-heap a priority search needs: canvas-render's
//! `layout/edges/min-heap.ts`, ported sift for sift.
//!
//! Ties are NOT broken, exactly as there: two entries of equal cost pop in
//! whatever order the sift leaves them. The route search has several optimal
//! paths on a lattice, and which one it settles on is decided by this order,
//! so `std::collections::BinaryHeap` (a different sift) would pick other
//! routes than the TypeScript does.

/// Parallel arrays of priorities and payloads, as in the TypeScript.
#[derive(Debug, Default)]
pub(crate) struct MinHeap {
    costs: Vec<f64>,
    values: Vec<usize>,
}

impl MinHeap {
    pub(crate) fn len(&self) -> usize {
        self.values.len()
    }

    #[expect(
        clippy::arithmetic_side_effects,
        reason = "`child - 1` runs only while child > 0, and an index is below len"
    )]
    pub(crate) fn push(&mut self, cost: f64, value: usize) {
        self.costs.push(cost);
        self.values.push(value);
        let mut child = self.values.len().saturating_sub(1);
        while child > 0 {
            let parent = (child - 1) >> 1;
            if self.cost(parent) <= self.cost(child) {
                break;
            }
            self.swap(parent, child);
            child = parent;
        }
    }

    /// The lowest-cost entry; `None` only when the heap is empty.
    #[expect(
        clippy::arithmetic_side_effects,
        reason = "child indices are compared against len before use, and len < usize::MAX / 2"
    )]
    pub(crate) fn pop(&mut self) -> Option<(f64, usize)> {
        let top = (*self.costs.first()?, *self.values.first()?);
        let (Some(last_cost), Some(last_value)) = (self.costs.pop(), self.values.pop()) else {
            return None;
        };
        if let (Some(cost), Some(value)) = (self.costs.first_mut(), self.values.first_mut()) {
            *cost = last_cost;
            *value = last_value;
            let mut parent = 0;
            loop {
                let left = parent * 2 + 1;
                let right = left + 1;
                let mut smallest = parent;
                if left < self.costs.len() && self.cost(left) < self.cost(smallest) {
                    smallest = left;
                }
                if right < self.costs.len() && self.cost(right) < self.cost(smallest) {
                    smallest = right;
                }
                if smallest == parent {
                    break;
                }
                self.swap(parent, smallest);
                parent = smallest;
            }
        }
        Some(top)
    }

    /// An index the sift loops above have already bounded by `len`.
    fn cost(&self, index: usize) -> f64 {
        self.costs.get(index).copied().unwrap_or(f64::NAN)
    }

    fn swap(&mut self, a: usize, b: usize) {
        self.costs.swap(a, b);
        self.values.swap(a, b);
    }
}

#[cfg(test)]
mod tests {
    use super::MinHeap;
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    #[test]
    fn pops_in_cost_order_and_answers_none_when_empty() {
        let mut heap = MinHeap::default();
        for (cost, value) in [(5.0, 0), (1.0, 1), (3.0, 2), (1.0, 3), (4.0, 4)] {
            heap.push(cost, value);
        }
        let mut popped = Vec::new();
        while let Some((cost, _)) = heap.pop() {
            popped.push(cost);
        }
        assert_eq!(popped, vec![1.0, 1.0, 3.0, 4.0, 5.0]);
        assert_eq!(heap.len(), 0);
        assert!(heap.pop().is_none());
    }

    #[test]
    fn equal_costs_pop_in_the_order_the_sift_leaves_them() {
        // [0, 2, 3, 1] is what min-heap.ts answers for these four pushes,
        // read off the TypeScript heap rather than derived; a tie-broken heap
        // would answer 0, 1, 2, 3.
        let mut heap = MinHeap::default();
        heap.push(1.0, 1);
        heap.push(1.0, 2);
        heap.push(1.0, 3);
        heap.push(0.0, 0);
        let order: Vec<usize> = std::iter::from_fn(|| heap.pop().map(|(_, v)| v)).collect();
        assert_eq!(order, vec![0, 2, 3, 1]);
    }
}
