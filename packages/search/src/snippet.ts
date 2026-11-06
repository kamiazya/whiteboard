import { leafOfPath } from '@kamiazya/whiteboard-model'
/**
 * How much text either side of the match an excerpt carries, in UTF-16 code
 * units. Exported so a test can place a character exactly on the cut boundary
 * — duplicating the number there would let the generator silently stop
 * aiming at anything the day this changes.
 */
export const CONTEXT_RADIUS = 60

/** Stands in for the match while its surroundings are stripped. */
const MATCH_SLOT = '\uE000'

/**
 * What a `[[target]]` (or `![[target]]`) shows in an excerpt: the target's
 * display name when the caller knows it, `undefined` to fall back to the
 * target's last segment. A reader of the excerpt sees what the preview shows
 * for the link, never the address it is written with.
 */
export type LinkLabel = (target: string) => string | undefined

/** A wiki link or embed, as the reference extractor reads one: no brackets or line breaks inside. */
const LINK = /!?\[\[([^[\]\n]*)\]\]/g
const LINK_AT = /!?\[\[([^[\]\n]*)\]\]/y

/** How far either side of an edge it looks for a link it might sit inside. */
const LINK_REACH_UNITS = 512

/** Stands in for a rendered link while the rest of the excerpt is stripped. */
const LINK_OPEN = ''
const LINK_CLOSE = ''

/**
 * A `LinkLabel` over a listing: a link names its target by path or by
 * document id, and reads as that document's display name when it has one,
 * else as its path's last segment.
 */
export function linkLabelsFrom(
  entries: Iterable<{ readonly documentId: string; readonly path: string; readonly name?: string }>,
): LinkLabel {
  const names = new Map<string, string>()
  for (const { documentId, path, name } of entries) {
    // By id, even unnamed: the id is no word anybody reads, the path's leaf is.
    names.set(documentId, name ?? leafOfPath(path))
    if (name !== undefined) names.set(path, name)
  }
  return (target) => names.get(target)
}

/** `[[target#Heading|alias]]`'s inner text as a reader sees it. */
function linkText(inner: string, labelOf: LinkLabel | undefined): string {
  const bar = inner.indexOf('|')
  if (bar !== -1) return inner.slice(bar + 1)
  const hash = inner.indexOf('#')
  const target = (hash === -1 ? inner : inner.slice(0, hash)).trim()
  const heading = hash === -1 ? '' : inner.slice(hash + 1).trim()
  const label = target === '' ? '' : (labelOf?.(target) ?? leafOfPath(target))
  if (heading === '') return label
  return label === '' ? heading : `${label} › ${heading}`
}

/**
 * The link `at` falls strictly inside, if any — where an excerpt may not be
 * cut. Looks only within `LINK_REACH_UNITS` either side, so an edge costs
 * the same however long the document is; a "link" longer than that is not
 * one an excerpt has to keep whole.
 */
function linkAround(value: string, at: number): { start: number; end: number } | undefined {
  if (at <= 0 || at >= value.length) return undefined
  const from = Math.max(0, at - LINK_REACH_UNITS)
  const near = value.slice(from, Math.min(value.length, at + LINK_REACH_UNITS))
  const local = at - from
  // A cut between `!` and `[[` is inside the embed too.
  const open = near.startsWith('![[', local - 1) ? local - 1 : near.lastIndexOf('[[', local - 1)
  if (open === -1) return undefined
  const start = near[open] === '[' && near[open - 1] === '!' ? open - 1 : open
  LINK_AT.lastIndex = start
  const found = LINK_AT.exec(near)
  if (found === null) return undefined
  const end = start + found[0].length
  return start < local && local < end ? { start: from + start, end: from + end } : undefined
}

/**
 * The words markdown typesets, without the typesetting: fence lines, quote /
 * list / task / heading markers, table delimiter rows and cell pipes, and
 * inline emphasis, code ticks and link syntax. Anchored on lines, so it runs
 * over the excerpt before whitespace is collapsed. A heading or list marker
 * also counts at the very end of a line, since the excerpt's cut can fall
 * between `##` and the space that made it one. A wiki link becomes what
 * it reads as, after everything else, so neither a pipe in it nor markup in
 * a display name is mistaken for the excerpt's own.
 */
function stripMarkup(chunk: string, labelOf: LinkLabel | undefined): string {
  const links: string[] = []
  const held = chunk.replace(LINK, (_, inner: string) => {
    links.push(linkText(inner, labelOf))
    return `${LINK_OPEN}${links.length - 1}${LINK_CLOSE}`
  })
  return held
    .replace(/^[ \t]*(?:`{3,}|~{3,}).*$/gm, '')
    .replace(/^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(?:\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/gm, '')
    .replace(
      /^[ \t]*(?:#{1,6}(?:[ \t]+|$)|(?:>[ \t]?)+|[-*+][ \t]+\[[ xX]\][ \t]+|[-*+](?:[ \t]+|$)|\d+[.)](?:[ \t]+|$))/gm,
      '',
    )
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__|~~|`/g, '')
    .replace(/[ \t]*\|[ \t]*/g, ' ')
    .replace(/(\d+)/g, (_, i: string) => links[Number(i)] ?? '')
}

/** A link rendered in place, and nothing else touched — the match keeps what it says. */
function renderLinks(chunk: string, labelOf: LinkLabel | undefined): string {
  return chunk.replace(LINK, (_, inner: string) => linkText(inner, labelOf))
}

/**
 * The excerpt with its markup stripped everywhere but the match itself, which
 * stays as written so a caller can still find and highlight it — bar a link,
 * which reads as its label there too.
 */
function plainExcerpt(
  value: string,
  cut: { start: number; end: number },
  match: { start: number; end: number },
  labelOf: LinkLabel | undefined,
) {
  const { start, end } = cut
  const matchStart = Math.max(start, Math.min(end, match.start))
  const matchEnd = Math.max(matchStart, Math.min(end, match.end))
  const slotted = `${value.slice(start, matchStart)}${MATCH_SLOT}${value.slice(matchEnd, end)}`
  const [head = '', tail = ''] = stripMarkup(slotted, labelOf).split(MATCH_SLOT)
  return `${head}${renderLinks(value.slice(matchStart, matchEnd), labelOf)}${tail}`
}

/** The match, widened to whole links where it starts or ends inside one. */
function matchSpan(value: string, index: number, length: number) {
  return {
    start: linkAround(value, index)?.start ?? index,
    end: linkAround(value, index + length)?.end ?? index + length,
  }
}

/**
 * A short plain-text excerpt around [index, index+length), whitespace
 * collapsed, ellipsised at cut edges, a `[[link]]` shown as what it reads as
 * (`labelOf`) and never cut through. Shared by reference extraction and
 * search results so "where is this in the document" reads the same way
 * from both surfaces.
 */
export function snippetAround(
  value: string,
  index: number,
  length: number,
  labelOf?: LinkLabel,
): string {
  const match = matchSpan(value, index, length)
  // Both edges snap INWARD to a grapheme boundary, so an excerpt can never
  // grow past the radius it was asked for and the rule reads the same at
  // both ends. Code points were not enough: `slice` indexes UTF-16 code
  // units, and a radius landing inside a flag, a ZWJ family or a combining
  // pair emitted a fragment at the edge of every search result and backlink
  // context — and inside a run of flags, an excerpt whose first flag was not
  // one the document contains.
  const start = snapStart(
    value,
    clusterStartAtOrAfter(value, Math.max(0, match.start - CONTEXT_RADIUS)),
    match,
  )
  const end = snapEnd(
    value,
    clusterEndAtOrBefore(value, Math.min(value.length, match.end + CONTEXT_RADIUS)),
    match,
  )
  const text =
    start < end
      ? plainExcerpt(value, { start, end }, match, labelOf).replace(/\s+/g, ' ').trim()
      : ''
  return `${start > 0 ? '…' : ''}${text}${end < value.length ? '…' : ''}`
}

/**
 * A window edge moved off any link it fell inside: outward over a link the
 * match is part of, inward past one it is not.
 */
function snapStart(value: string, at: number, match: { start: number; end: number }): number {
  const link = linkAround(value, at)
  if (link === undefined) return at
  return link.end > match.start ? Math.min(link.start, match.start) : link.end
}

function snapEnd(value: string, at: number, match: { start: number; end: number }): number {
  const link = linkAround(value, at)
  if (link === undefined) return at
  return link.start < match.end ? Math.max(link.end, match.end) : link.start
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

// An explicit locale, never the host's default: the same text must split the
// same way on every machine (QR-20b).
const GRAPHEMES = new Intl.Segmenter('en', { granularity: 'grapheme' })

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
