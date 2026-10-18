/**
 * The largest `n` in `[0, limit]` for which `fits(n)` holds, where `fits(0)`
 * is taken as true and `fits` is PREFIX-CLOSED: once a prefix of `n` pieces
 * does not fit, no longer prefix does. A rendered width is monotone in prefix
 * length for every measurer this package is given (kerning is off on the
 * export measurer, and a glyph's advance is never negative), which is what
 * makes this answer the one a piece-by-piece scan stopping at its first
 * failure would give — whatever order the probes below are taken in.
 *
 * The first probe is `guess`; from there the search GALLOPS — steps of 1,
 * 2, 4, ... away from it, up while probes fit and down while they do not —
 * and bisects only the last step. Plain bisection over `[0, limit]` would
 * measure the whole remaining tail of a long paragraph once per line, which
 * is quadratic again in the line count; galloping never probes far past the
 * answer, and a good guess (the previous line's count) usually settles it
 * in two probes.
 *
 * When the answer is below `limit`, `fits(answer + 1)` has itself been
 * called and returned false, so a caller may act on that failure without
 * measuring it a second time.
 */
export function longestFittingCount(
  fits: (n: number) => boolean,
  limit: number,
  guess = 1,
): number {
  if (limit <= 0) return 0
  const first = Math.min(limit, Math.max(1, Math.floor(guess)))
  let [lo, hi] = fits(first) ? gallopUp(fits, first, limit) : gallopDown(fits, first)
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2)
    if (fits(mid)) lo = mid
    else hi = mid
  }
  return lo
}

/** From a count that fits, step up until one does not: `[fits, does not]`. */
function gallopUp(fits: (n: number) => boolean, from: number, limit: number): [number, number] {
  let lo = from
  for (let step = 1; lo < limit; step *= 2) {
    const probe = Math.min(limit, lo + step)
    if (!fits(probe)) return [lo, probe]
    lo = probe
  }
  // Every prefix up to `limit` fits. Any upper bound at most one past `lo`
  // ends the bisection with `lo` unchanged, so `limit + 1` names the
  // first count that cannot exist rather than steering the search.
  return [lo, limit + 1]
}

/** From a count that does not fit, step down until one does (or zero). */
function gallopDown(fits: (n: number) => boolean, from: number): [number, number] {
  let hi = from
  for (let step = 1; hi - step > 0; step *= 2) {
    const probe = hi - step
    if (fits(probe)) return [probe, hi]
    hi = probe
  }
  return [0, hi]
}
