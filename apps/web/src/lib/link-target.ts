import { documentReferenceMarkup } from '@kamiazya/whiteboard-codec'
import type { DocumentKind } from '@kamiazya/whiteboard-model'

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
 * What to write in the body for a chosen target, optionally displaying
 * `text` instead of the label the renderer would supply.
 *
 * The grammar is the codec's: the PATH is the written form (display names are
 * retired from resolution, and a bare `[[path]]` is labeled with the target's
 * CURRENT display name at render time, so the default insert freezes
 * nothing), the opaque id form is the fallback when the path cannot be
 * written or would read as an id, and text the scanner cannot read inside the
 * brackets is dropped rather than truncated. Chosen display text still
 * travels as the explicit alias whenever it can, because the author asked for
 * that exact prose.
 */
export function linkMarkupFor(target: LinkTarget, text?: string): string {
  return documentReferenceMarkup(target, (text ?? '').trim())
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
