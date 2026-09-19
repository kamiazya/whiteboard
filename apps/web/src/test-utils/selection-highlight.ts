/**
 * The points of the selection highlight, read off the element the editor
 * actually draws.
 *
 * The highlight is ONE `<path>` whose `d` holds a subpath per selected
 * stroke (`EdgeSelectionHighlight` says why), so a test asking "where does
 * the highlight go" parses `d` rather than a `<polyline>`'s `points`. Shared
 * so the parse has one definition: two tests assert on this geometry, and
 * they were reading the same shape two ways.
 */
export function selectionHighlightPoints(
  element: Element | null,
): readonly { readonly x: number; readonly y: number }[] {
  // `filter` before `Number`, not after: the split leaves an empty leading
  // token (the `M` starts the string) and `Number('')` is 0, not NaN — which
  // shifts every pair by one coordinate and reads as the highlight being in
  // the wrong place.
  const numbers = (element?.getAttribute('d') ?? '')
    .split(/[ML\s]+/)
    .filter((token) => token.length > 0)
    .map(Number)
  const points: { x: number; y: number }[] = []
  for (let i = 0; i + 1 < numbers.length; i += 2) {
    points.push({ x: numbers[i] as number, y: numbers[i + 1] as number })
  }
  return points
}
