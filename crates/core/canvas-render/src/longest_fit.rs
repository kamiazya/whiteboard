//! The longest prefix that fits, found by galloping search, ported from
//! `longest-fit.ts`.

/// More rounds than any of the three loops can take on a `usize` range: a
/// doubling step or a halving gap is exhausted within `usize::BITS` rounds,
/// and this is twice that on a 64-bit target.
const ROUNDS: u32 = 128;

/// The largest `n` in `[0, limit]` for which `fits(n)` holds, where `fits(0)`
/// is taken as true and `fits` is PREFIX-CLOSED: once a prefix of `n` pieces
/// does not fit, no longer prefix does. A rendered width is monotone in prefix
/// length for every measurer layout is given, which makes this answer the one
/// a piece-by-piece scan stopping at its first failure would give, whatever
/// order the probes are taken in.
///
/// The first probe is `guess` (clamped to `[1, limit]`); from there the search
/// gallops, in steps of 1, 2, 4, ... away from it, up while probes fit and down
/// while they do not, and bisects only the last step. Plain bisection over
/// `[0, limit]` would measure the whole tail of a long paragraph once per line;
/// galloping never probes far past the answer, and a good guess (the previous
/// line's count) usually settles it in two probes.
///
/// When the answer is below `limit`, `fits(answer + 1)` has itself been called
/// and returned false, so a caller may act on that failure without measuring it
/// a second time.
///
/// The TypeScript takes a fractional `guess` and floors it; a count is whole
/// here, which is the only kind a caller has.
pub fn longest_fitting_count(
    mut fits: impl FnMut(usize) -> bool,
    limit: usize,
    guess: usize,
) -> usize {
    if limit == 0 {
        return 0;
    }
    let first = guess.max(1).min(limit);
    let (mut lo, mut hi) = if fits(first) {
        gallop_up(&mut fits, first, limit)
    } else {
        gallop_down(&mut fits, first)
    };
    // Each round halves `hi - lo`, so the bisection ends within `ROUNDS`; the
    // bound only makes that termination a property of the loop rather than of
    // its arithmetic.
    for _ in 0..ROUNDS {
        if hi.saturating_sub(lo) <= 1 {
            break;
        }
        let mid = lo.saturating_add(hi.saturating_sub(lo) / 2);
        if fits(mid) {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    lo
}

/// From a count that fits, step up until one does not: `(fits, does not)`.
fn gallop_up(fits: &mut impl FnMut(usize) -> bool, from: usize, limit: usize) -> (usize, usize) {
    let mut lo = from;
    let mut step = 1_usize;
    // `step` doubles each round and saturates, so `lo` reaches `limit` within
    // `ROUNDS`.
    for _ in 0..ROUNDS {
        if lo >= limit {
            break;
        }
        let probe = limit.min(lo.saturating_add(step));
        if !fits(probe) {
            return (lo, probe);
        }
        lo = probe;
        step = step.saturating_mul(2);
    }
    // Every prefix up to `limit` fits. Any upper bound at most one past `lo`
    // ends the bisection with `lo` unchanged, so `limit + 1` names the first
    // count that cannot exist rather than steering the search.
    (lo, limit.saturating_add(1))
}

/// From a count that does not fit, step down until one does (or zero).
fn gallop_down(fits: &mut impl FnMut(usize) -> bool, from: usize) -> (usize, usize) {
    let mut hi = from;
    let mut step = 1_usize;
    for _ in 0..ROUNDS {
        if hi <= step {
            break;
        }
        let probe = hi.saturating_sub(step);
        if fits(probe) {
            return (probe, hi);
        }
        hi = probe;
        step = step.saturating_mul(2);
    }
    (0, hi)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    /// The probes taken and the answer, against a threshold.
    fn run(limit: usize, guess: usize, threshold: usize) -> (Vec<usize>, usize) {
        let mut probes = Vec::new();
        let answer = longest_fitting_count(
            |n| {
                probes.push(n);
                n <= threshold
            },
            limit,
            guess,
        );
        (probes, answer)
    }

    #[test]
    fn nothing_to_fit_is_zero_without_a_probe() {
        assert_eq!(run(0, 1, 0), (vec![], 0));
    }

    #[test]
    fn a_good_guess_settles_in_two_probes() {
        assert_eq!(run(100, 7, 7), (vec![7, 8], 7));
    }

    #[test]
    fn it_gallops_up_by_doubling_steps_then_bisects() {
        assert_eq!(run(100, 1, 10), (vec![1, 2, 4, 8, 16, 12, 10, 11], 10));
    }

    #[test]
    fn it_gallops_down_when_the_guess_does_not_fit() {
        assert_eq!(run(100, 50, 3), (vec![50, 49, 47, 43, 35, 19, 9, 4, 2, 3], 3));
    }

    #[test]
    fn every_prefix_fitting_answers_the_limit() {
        assert_eq!(run(5, 1, 99), (vec![1, 2, 4, 5], 5));
    }

    #[test]
    fn a_guess_past_the_limit_or_zero_is_clamped() {
        assert_eq!(run(5, 99, 2).1, 2);
        assert_eq!(run(5, 0, 2).1, 2);
        assert_eq!(run(5, 99, 2).0.first(), Some(&5));
        assert_eq!(run(5, 0, 2).0.first(), Some(&1));
    }

    #[test]
    fn nothing_fitting_answers_zero() {
        assert_eq!(run(9, 1, 0).1, 0);
        assert_eq!(run(9, 5, 0).1, 0);
    }
}
