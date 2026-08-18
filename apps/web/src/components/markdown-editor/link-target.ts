import type { DocumentKind } from '@kamiazya/whiteboard-model'

/** A document this editor can link to, as the composition root knows it. */
export interface LinkTarget {
  readonly id: string
  readonly name: string
  readonly kind?: DocumentKind
}

/** Matched name, best first; `null` when the name does not match at all. */
function scoreOf(name: string, query: string): number | null {
  const haystack = name.toLowerCase()
  if (haystack === query) return 0
  if (haystack.startsWith(query)) return 1
  return haystack.includes(query) ? 2 : null
}

/**
 * The targets worth showing for `query`, best match first. Substring
 * matching rather than fuzzy: a document list is small and the author is
 * typing a name they can already see, so a fuzzy matcher would mostly add
 * surprising middle results. Ties keep the caller's order, which is the
 * list the switcher shows.
 */
export function rankLinkTargets(
  targets: readonly LinkTarget[],
  query: string,
): readonly LinkTarget[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return targets
  return targets
    .flatMap((target) => {
      const score = scoreOf(target.name, needle)
      return score === null ? [] : [{ target, score }]
    })
    .sort((a, b) => a.score - b.score)
    .map((entry) => entry.target)
}

/**
 * Names that cannot survive being written between `[[` and `]]`: `]]` closes
 * the reference early, and a line break cannot appear inside an inline one.
 */
const UNWRITABLE_IN_BRACKETS = /]]|[\r\n]/

/**
 * What to write in the body for a chosen target.
 *
 * The readable form wins where it works, because the reference is prose the
 * author will read again — but `[[Name]]` resolves only when exactly one
 * document carries that name (see `createSnapshotAliasResolver`), so a
 * duplicate name would produce a link that silently stays literal text. The
 * picker is the one place that KNOWS which document was chosen, so it spends
 * that knowledge here: the opaque `[[canvas:<id>]]` form appears only when
 * the readable one would be wrong.
 */
export function linkMarkupFor(target: LinkTarget, all: readonly LinkTarget[]): string {
  const sameName = all.filter((candidate) => candidate.name === target.name)
  const unambiguous = sameName.length === 1 && !UNWRITABLE_IN_BRACKETS.test(target.name)
  return unambiguous ? `[[${target.name}]]` : `[[canvas:${target.id}]]`
}

/**
 * The URL a search query stands for, or null when it is just text.
 *
 * Only http(s) — this writes into a document that other people open, and a
 * `javascript:` or `file:` target typed into a search box is never what an
 * author meant. A bare domain is promoted rather than rejected, since that
 * is how a pasted address usually arrives; anything without a dot in its
 * first segment stays text, so ordinary prose does not become a link.
 */
export function urlFromQuery(query: string): string | null {
  const trimmed = query.trim()
  if (trimmed === '' || /\s/.test(trimmed)) return null
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  // `https://notes` parses fine; a host with no dot is a word, not an address.
  if (!parsed.hostname.includes('.')) return null
  return candidate
}

/**
 * The markdown for an external link over `text`.
 *
 * With nothing to carry the link, CommonMark's autolink (`<url>`) is the
 * honest form — an empty label renders as an invisible link. Brackets in the
 * text are escaped because a stray `]` closes the label early and silently
 * turns the rest into prose, and a destination containing spaces or parens
 * goes in angle brackets, which is CommonMark's own answer for it.
 */
export function externalLinkMarkup(text: string, url: string): string {
  if (text.trim() === '') return `<${url}>`
  const label = text.replace(/[[\]]/g, (bracket) => `\\${bracket}`)
  const destination = /[\s()]/.test(url) ? `<${url}>` : url
  return `[${label}](${destination})`
}
