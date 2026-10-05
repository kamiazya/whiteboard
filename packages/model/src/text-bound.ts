/**
 * Whether a text going from `before` to `after` characters breaks a bound of
 * `max`: only growth that ends past it does. A text stored longer before the
 * bound existed must still read and still take an edit that shortens it, and
 * a flat `after > max` would leave it stuck — every keeper and every editor
 * holds a text bound to this one rule, so they refuse the same edits.
 */
export function growsPast(max: number, before: number, after: number): boolean {
  return after > max && after > before
}
