//! `Array.prototype.sort` as V8 runs it on the arrays the TypeScript sorts.
//!
//! Any stable sort gives the same order when the comparator is a total
//! preorder, which is why most ports call `sort_by`. Some of the
//! TypeScript's comparators are not, and there the order is whatever V8's
//! algorithm leaves. canvas-render's `bestCandidate` is one: it treats two
//! lengths within 1e-6 as equal, which is not transitive. So this is V8's
//! `TimSort` (`third_party/v8/builtins/array-sort.tq`) on its short-array
//! path. An array under 64 elements is ONE run: its leading ascending (or
//! strictly descending, then reversed) stretch, then binary insertion of
//! the rest. A comparator answering NaN reads as 0, as `CallCompare` does.
//!
//! Longer arrays take the merge path, which this does not port. They fall
//! back to `slice::sort_by`, which agrees with V8 for a total preorder only
//! and MAY PANIC when the comparator is not one (std's documented contract
//! since Rust 1.81) — under the wasm build's `panic = "abort"`, an aborted
//! instance. `JS_SORT_EXACT_BELOW` says where exactness ends, so a caller
//! sorting longer arrays with an inconsistent comparator can see that it
//! would need more than this.

use core::cmp::Ordering;

/// The length below which [`js_sort_by`] is V8's order for ANY comparator.
pub const JS_SORT_EXACT_BELOW: usize = 64;

/// Sorts `items` as `items.sort(compare)` would, `compare` answering as a
/// JavaScript comparator does: negative, zero (or NaN), positive.
///
/// # Panics
///
/// At [`JS_SORT_EXACT_BELOW`] elements or more, may panic when `compare` is
/// not a total preorder.
pub fn js_sort_by<T: Clone>(items: &mut [T], compare: impl Fn(&T, &T) -> f64) {
    let order = |a: &T, b: &T| {
        let v = compare(a, b);
        if v < 0.0 {
            Ordering::Less
        } else if v > 0.0 {
            Ordering::Greater
        } else {
            Ordering::Equal
        }
    };
    if items.len() < 2 {
        return;
    }
    if items.len() >= JS_SORT_EXACT_BELOW {
        items.sort_by(order);
        return;
    }
    let run = count_and_make_run(items, &order);
    binary_insertion_sort(items, run, &order);
}

/// V8's `CountAndMakeRun` from index 0: the length of the leading run,
/// reversed in place when it is strictly descending.
fn count_and_make_run<T>(items: &mut [T], order: &impl Fn(&T, &T) -> Ordering) -> usize {
    let len = items.len();
    let descending = match (items.get(1), items.first()) {
        (Some(second), Some(first)) => order(second, first) == Ordering::Less,
        _ => return len,
    };
    let mut run = 2;
    while let (Some(current), Some(previous)) =
        (items.get(run), run.checked_sub(1).and_then(|p| items.get(p)))
    {
        let o = order(current, previous);
        if (descending && o != Ordering::Less) || (!descending && o == Ordering::Less) {
            break;
        }
        run = run.saturating_add(1);
    }
    if descending && let Some(head) = items.get_mut(..run) {
        head.reverse();
    }
    run
}

/// V8's `BinaryInsertionSort(0, start, len)`: each element from `start` on
/// placed after every element it does not sort before.
fn binary_insertion_sort<T: Clone>(
    items: &mut [T],
    start: usize,
    order: &impl Fn(&T, &T) -> Ordering,
) {
    for i in start.max(1)..items.len() {
        let Some(pivot) = items.get(i).cloned() else { break };
        let (mut left, mut right) = (0, i);
        while left < right {
            let mid = left.midpoint(right);
            match items.get(mid) {
                Some(m) if order(&pivot, m) == Ordering::Less => right = mid,
                _ => left = mid.saturating_add(1),
            }
        }
        if let Some(span) = items.get_mut(left..=i) {
            span.rotate_right(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::js_sort_by;
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    #[test]
    fn a_strictly_descending_run_is_reversed_and_an_equal_pair_stops_it() {
        // An equal pair ends a descending run, so reversing it keeps ties in order.
        let mut v = vec![(4, 'a'), (3, 'b'), (3, 'c'), (1, 'd'), (5, 'e')];
        js_sort_by(&mut v, |a, b| f64::from(a.0) - f64::from(b.0));
        assert_eq!(v, vec![(1, 'd'), (3, 'b'), (3, 'c'), (4, 'a'), (5, 'e')]);
    }

    #[test]
    fn a_consistent_comparator_sorts_stably() {
        let mut v = vec![(3, 'a'), (1, 'b'), (3, 'c'), (2, 'd'), (1, 'e')];
        js_sort_by(&mut v, |a, b| f64::from(a.0) - f64::from(b.0));
        assert_eq!(v, vec![(1, 'b'), (1, 'e'), (2, 'd'), (3, 'a'), (3, 'c')]);
    }

    #[test]
    fn an_intransitive_comparator_leaves_the_order_node_answers() {
        // `(a, b) => Math.abs(a - b) <= 1 ? 0 : a - b`, each result read off
        // Node 24's Array.prototype.sort.
        let near = |a: &f64, b: &f64| if (a - b).abs() <= 1.0 { 0.0 } else { a - b };
        for (input, node) in [
            (vec![2.0, 1.0, 0.0, 3.0], vec![2.0, 1.0, 0.0, 3.0]),
            (vec![0.0, 3.0, 1.0, 2.0], vec![0.0, 1.0, 3.0, 2.0]),
            (vec![3.0, 2.0, 1.0, 0.0], vec![3.0, 2.0, 1.0, 0.0]),
            (vec![5.0, 4.5, 4.0, 3.6, 3.0, 2.5, 9.0], vec![5.0, 4.5, 4.0, 3.6, 3.0, 2.5, 9.0]),
        ] {
            let mut v = input.clone();
            js_sort_by(&mut v, near);
            assert_eq!(v, node, "{input:?}");
        }
    }
}
