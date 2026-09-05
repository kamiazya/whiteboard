/**
 * How much text either side of the match an excerpt carries, in UTF-16 code
 * units. Exported so a test can place a character exactly on the cut boundary
 * — duplicating the number there would let the generator silently stop
 * aiming at anything the day this changes.
 */
export const CONTEXT_RADIUS = 60

/**
 * A short plain-text excerpt around [index, index+length), whitespace
 * collapsed, ellipsised at cut edges. Shared by reference extraction and
 * search results so "where is this in the document" reads the same way
 * from both surfaces.
 */
export function snippetAround(value: string, index: number, length: number): string {
  // Both edges snap INWARD to a grapheme boundary, so an excerpt can never
  // grow past the radius it was asked for and the rule reads the same at
  // both ends. Code points were not enough: `slice` indexes UTF-16 code
  // units, and a radius landing inside a flag, a ZWJ family or a combining
  // pair emitted a fragment at the edge of every search result and backlink
  // context — and inside a run of flags, an excerpt whose first flag was not
  // one the document contains.
  const start = clusterStartAtOrAfter(value, Math.max(0, index - CONTEXT_RADIUS))
  const end = clusterEndAtOrBefore(value, Math.min(value.length, index + length + CONTEXT_RADIUS))
  const text = start < end ? value.slice(start, end).replace(/\s+/g, ' ').trim() : ''
  return `${start > 0 ? '…' : ''}${text}${end < value.length ? '…' : ''}`
}

/**
 * How far a cut looks around itself before asking the segmenter.
 *
 * Asking is the cost: every `Intl.Segmenter#segment` call clones an ICU
 * break iterator, ~5µs whatever the text, so the point of everything below
 * is to not ask. Nothing below U+0300 joins the character before it — bar
 * LF after CR, and anything after a Prepend character (UAX #29 GB9b) — so
 * a unit like that AT the cut is a boundary already, which is every cut in
 * Latin text. A cut on anything else asks, but over a window rather than
 * the document: UAX #29's boundary rules are LOCAL — each reads a few code
 * points — except regional-indicator pairing, which counts from the START
 * of the run. So a window that begins `LOCAL_UNITS` back, or at the nearest
 * boundary unit if one is closer, segments the same as the document does
 * from there on, and only a run of flags pushes its start further back, up
 * to `LOOKBACK_UNITS`. Priced on `snippet.bench.ts`: a CJK cut — no
 * boundary unit within reach, so both edges ask — costs the one clone and
 * nothing that grows with the document.
 *
 * ponytail: 64 units is the longest cluster a window is sure to hold whole;
 * a cluster longer than that (sixty-odd combining marks on one base) can
 * still be cut inside. 1024 units is 256 consecutive flags; past it the
 * edge falls back to code-point snapping, exact for everything but a flag
 * straddling the cut inside such a run. The upgrade for either is a
 * backward walk over the class alone.
 */
const LOOKBACK_UNITS = 1024
const LOCAL_UNITS = 64

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/**
 * Code points that glue themselves to the character AFTER them (UAX #29
 * GB9b, Grapheme_Cluster_Break=Prepend — Arabic number signs, Indic
 * prefixes). Enumerated rather than derived, so `snippet.test.ts` asks the
 * runtime's own segmenter for the list and fails when a Unicode update
 * moves it.
 */
const PREPEND = new Set([
  0x0600, 0x0601, 0x0602, 0x0603, 0x0604, 0x0605, 0x06dd, 0x070f, 0x0890, 0x0891, 0x08e2, 0x0d4e,
  0x110bd, 0x110cd, 0x111c2, 0x111c3, 0x113d1, 0x1193f, 0x11941, 0x11a84, 0x11a85, 0x11a86, 0x11a87,
  0x11a88, 0x11a89, 0x11d46, 0x11f02,
])

/** Whether the code point ending at `at - 1` is a Prepend. */
function precededByPrepend(value: string, at: number): boolean {
  const unit = value.charCodeAt(at - 1)
  if (unit < 0x0600) return false
  if (unit < 0xdc00 || unit > 0xdfff) return PREPEND.has(unit)
  const high = value.charCodeAt(at - 2)
  return (
    high >= 0xd800 &&
    high <= 0xdbff &&
    PREPEND.has((high - 0xd800) * 0x400 + (unit - 0xdc00) + 0x10000)
  )
}

/** A cut no cluster can straddle, decided from two units — the cheap test. */
function isBoundaryUnit(value: string, at: number): boolean {
  if (at === 0 || at === value.length) return true
  const unit = value.charCodeAt(at)
  return unit < 0x0300 && unit !== 0x000a && !precededByPrepend(value, at)
}

/** Whether the unit at `at` is the low half of a regional indicator. */
function endsRegionalIndicator(value: string, at: number): boolean {
  const low = value.charCodeAt(at)
  return low >= 0xdde6 && low <= 0xddff && value.charCodeAt(at - 1) === 0xd83c
}

/**
 * Where a window around `at` can start and still segment as the document
 * does, or null when a run of flags outlasts the lookback.
 */
function windowStart(value: string, at: number): number | null {
  const floor = Math.max(0, at - LOOKBACK_UNITS)
  let sawRegionalIndicator = false
  for (let p = at; p >= floor; p -= 1) {
    if (isBoundaryUnit(value, p)) return p
    if (endsRegionalIndicator(value, p)) sawRegionalIndicator = true
    else if (!sawRegionalIndicator && at - p >= LOCAL_UNITS) return p
  }
  return null
}

/** The cluster the window around `at` puts `at` inside, in document offsets. */
function clusterAround(value: string, at: number, from: number): { start: number; end: number } {
  const span = value.slice(from, Math.min(value.length, at + LOCAL_UNITS))
  const found = GRAPHEMES.segment(span).containing(at - from)
  const start = from + (found?.index ?? 0)
  return { start, end: start + (found?.segment.length ?? 0) }
}

/** The first grapheme boundary at or after `from`, inward. */
function clusterStartAtOrAfter(value: string, from: number): number {
  if (isBoundaryUnit(value, from)) return from
  const anchor = windowStart(value, from)
  if (anchor === null) return snapForward(value, from)
  const cluster = clusterAround(value, from, anchor)
  return cluster.start === from ? from : cluster.end
}

/** The last grapheme boundary at or before `to`, inward. */
function clusterEndAtOrBefore(value: string, to: number): number {
  if (isBoundaryUnit(value, to)) return to
  const anchor = windowStart(value, to)
  if (anchor === null) return snapBack(value, to)
  return clusterAround(value, to, anchor).start
}

/** Past the low half of a pair, when the cut landed between the two. */
function snapForward(value: string, at: number): number {
  const unit = value.charCodeAt(at)
  return unit >= 0xdc00 && unit <= 0xdfff ? at + 1 : at
}

/** Before the high half of a pair, when the cut landed between the two. */
function snapBack(value: string, at: number): number {
  const unit = value.charCodeAt(at - 1)
  return unit >= 0xd800 && unit <= 0xdbff ? at - 1 : at
}
