//! A stable sort the digest's five orderings share.
//!
//! `slice::sort_by` is instantiated once per element type and comparator, and
//! the digest sorts five different rows: in the wasm artifact that was about
//! 25 KB of code for what is one algorithm. The merge below is written once,
//! over positions, and each caller only reorders its rows by the answer.

use core::cmp::Ordering;

/// The positions `0..len` in the order `compare` puts them, ties in position
/// order (a stable bottom-up merge sort).
fn positions(len: usize, compare: &dyn Fn(usize, usize) -> Ordering) -> Vec<usize> {
    let mut order: Vec<usize> = (0..len).collect();
    let mut width = 1;
    while width < len {
        let mut merged = Vec::with_capacity(len);
        let mut start = 0;
        while start < len {
            let mid = start.saturating_add(width).min(len);
            let end = mid.saturating_add(width).min(len);
            let left = order.get(start..mid).unwrap_or_default();
            let right = order.get(mid..end).unwrap_or_default();
            let (mut l, mut r) = (0, 0);
            while let (Some(&a), Some(&b)) = (left.get(l), right.get(r)) {
                if compare(b, a) == Ordering::Less {
                    merged.push(b);
                    r = r.saturating_add(1);
                } else {
                    merged.push(a);
                    l = l.saturating_add(1);
                }
            }
            merged.extend_from_slice(left.get(l..).unwrap_or_default());
            merged.extend_from_slice(right.get(r..).unwrap_or_default());
            start = end;
        }
        order = merged;
        width = width.saturating_mul(2);
    }
    order
}

/// `items` stably sorted by `compare`.
pub(super) fn sorted_by<T>(items: Vec<T>, compare: impl Fn(&T, &T) -> Ordering) -> Vec<T> {
    let order = positions(items.len(), &|a, b| match (items.get(a), items.get(b)) {
        (Some(x), Some(y)) => compare(x, y),
        _ => Ordering::Equal,
    });
    let mut slots: Vec<Option<T>> = items.into_iter().map(Some).collect();
    order.into_iter().filter_map(|at| slots.get_mut(at)?.take()).collect()
}
