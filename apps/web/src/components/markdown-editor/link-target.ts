import { type DocumentKind, documentIdSchema } from '@kamiazya/whiteboard-model'

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
 * Names the codec's own reference parser would read as something other than a
 * plain name: `]]` closes the reference early, a line break cannot appear in
 * an inline one, and `|` begins the alias half (`[[target|alias]]`).
 */
const UNWRITABLE_IN_BRACKETS = /]]|[\r\n|]/

/**
 * A name shaped exactly like a document id, which the parser reads as one
 * rather than as a name. Vanishingly unlikely for a human-typed title — a
 * canonical ULID is 26 characters of Crockford base32 — but the picker can
 * check it for free, and the alternative is a link that silently points at
 * whatever document carries that id.
 */
function readsAsDocumentId(name: string): boolean {
  return documentIdSchema.safeParse(name).success
}

/**
 * What to write in the body for a chosen target.
 *
 * The readable form wins where it works, because the reference is prose the
 * author will read again — but `[[Name]]` resolves only when exactly one
 * document carries that name (see `createSnapshotAliasResolver`), so a
 * duplicate name would produce a link that silently stays literal text. The
 * picker is the one place that KNOWS which document was chosen, so it spends
 * that knowledge here: the opaque `[[<id>]]` form appears only when the
 * readable one would be wrong.
 */
export function linkMarkupFor(target: LinkTarget, all: readonly LinkTarget[]): string {
  const sameName = all.filter((candidate) => candidate.name === target.name)
  const unambiguous =
    sameName.length === 1 &&
    !UNWRITABLE_IN_BRACKETS.test(target.name) &&
    !readsAsDocumentId(target.name)
  return unambiguous ? `[[${target.name}]]` : `[[${target.id}]]`
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
  const parse = (value: string): URL | null => {
    try {
      return new URL(value)
    } catch {
      return null
    }
  }
  const isHttp = (url: URL | null): boolean =>
    url !== null && (url.protocol === 'http:' || url.protocol === 'https:')

  // `example.com:8080/path` satisfies the URL scheme grammar — `.` is a legal
  // scheme character — so the first parse succeeds with protocol
  // `example.com:`. A second parse behind `https://` is what recognises a
  // pasted host:port as the address it obviously is.
  const asWritten = parse(trimmed)
  const candidate = isHttp(asWritten) ? trimmed : `https://${trimmed}`
  const parsed = isHttp(asWritten) ? asWritten : parse(candidate)
  if (!isHttp(parsed) || parsed === null) return null
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
  // Backslash first, or the escape added for a trailing `\` would itself be
  // escaped and the closing bracket would lose its meaning.
  const label = text.replace(/[\\[\]]/g, (char) => `\\${char}`)
  const destination = /[\s()]/.test(url)
    ? // The angle-bracket form is closed by the first `>` inside it.
      `<${url.replace(/</g, '%3C').replace(/>/g, '%3E')}>`
    : url
  return `[${label}](${destination})`
}
