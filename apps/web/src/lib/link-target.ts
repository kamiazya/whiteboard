import { type DocumentKind, documentIdSchema } from '@kamiazya/whiteboard-model'

/** A document this editor can link to, as the composition root knows it. */
export interface LinkTarget {
  readonly id: string
  /** The written form of a reference — what `[[...]]` resolves. */
  readonly path: string
  /** What the picker SHOWS, and the label an id-form link carries. */
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
 * Names the codec's own reference scanner would read as something other than
 * a plain name.
 *
 * ANY `]` is fatal, not just `]]`: the scanner advances to the first `]` and
 * accepts the reference only if the very next character is another one, so a
 * single bracket either kills the whole reference or truncates it and leaves
 * the remainder as literal text. A line break cannot appear in an inline
 * reference, and `|` begins the alias half.
 */
const UNWRITABLE_IN_BRACKETS = /[\]\r\n|]/

/**
 * A name shaped exactly like a document id, which the scanner reads as one
 * rather than as a name — the references syntax carries no scheme, so the id
 * form IS a bare target. Vanishingly unlikely for a human-typed title (a
 * canonical ULID is 26 characters of Crockford base32), but the picker can
 * check it for free, and the alternative is a link pointing somewhere else
 * entirely.
 */
function readsAsDocumentId(name: string): boolean {
  return documentIdSchema.safeParse(name).success
}

/**
 * What an ALIAS cannot contain. Shorter than the target's list — `|` and a
 * document-id-shaped string are ordinary text once the target half is
 * closed — but the bracket rule is the same and for the same reason: the
 * scanner stops at
 * the first `]` and requires the next character to be one too.
 */
const UNWRITABLE_AS_ALIAS = /[\]\r\n]/

/**
 * What to write in the body for a chosen target, optionally displaying
 * `text` instead of the label the renderer would supply.
 *
 * The PATH is the written form: display names are retired from resolution
 * (path + id are the only forms the reader resolves), and a bare `[[path]]`
 * is labeled with the target's CURRENT display name at render time — so
 * the default insert freezes nothing. Chosen display text still travels as
 * the explicit alias, because the author asked for that exact prose.
 *
 * The opaque `[[<id>]]` form appears only when the path itself would
 * mislead the reader's id-first rule — a path shaped exactly like a
 * document id — or would not survive the bracket grammar. That form is
 * unambiguous and unreadable, so it carries the display text or the name
 * as its alias whenever one can be written.
 */
export function linkMarkupFor(
  target: LinkTarget,
  _all: readonly LinkTarget[],
  text?: string,
): string {
  const wanted = (text ?? '').trim()
  const alias = wanted === '' || UNWRITABLE_AS_ALIAS.test(wanted) ? null : wanted
  const pathIsWritable =
    !UNWRITABLE_IN_BRACKETS.test(target.path) && !readsAsDocumentId(target.path)
  if (pathIsWritable) {
    return alias === null || alias === target.path
      ? `[[${target.path}]]`
      : `[[${target.path}|${alias}]]`
  }
  const fallbackAlias = alias ?? (UNWRITABLE_AS_ALIAS.test(target.name) ? null : target.name)
  return fallbackAlias === null ? `[[${target.id}]]` : `[[${target.id}|${fallbackAlias}]]`
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
