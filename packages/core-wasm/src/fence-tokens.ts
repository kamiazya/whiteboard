// The fence tokens a realm's highlighter has answered, kept so a layout that
// draws the same fences again sends them with its first call instead of
// being asked for them (owner decision q75: tokens travel as data, in at most
// two calls, and one in the steady state).

/** One highlighted token, as canvas-render's `CodeToken`. */
interface FenceToken {
  readonly text: string
  readonly role?: 'keyword' | 'string' | 'number' | 'comment'
}

/** One array per source line, as canvas-render's `CodeTokenLines`. */
type FenceTokenLines = readonly (readonly FenceToken[])[]

/** A host's highlighter over one fence; undefined when it would draw it plain. */
export type FenceHighlighter = (lang: string, value: string) => FenceTokenLines | undefined

/** `[lang, value, lines]` as the request's `codeTokens` carries a fence, `null` for plain. */
export type FenceRow = readonly [string, string, FenceTokenLines | null]

/**
 * The most fences held, and the most UTF-16 units of source among them: a
 * board's worth of fences, while a realm drawing many boards keeps only the
 * ones it drew last. Each one held is also a substring search over every
 * request, so the count bounds that cost too.
 */
const MAX_FENCES = 128
const MAX_UNITS = 1 << 21

/** A least-recently-used table of fence tokens; one per core, so one per realm. */
export class FenceTokenMemo {
  readonly #rows = new Map<string, FenceRow>()
  #units = 0

  constructor(
    private readonly maxFences = MAX_FENCES,
    private readonly maxUnits = MAX_UNITS,
  ) {}

  /** The rows whose source a request's wire text could hold, each touched as used. */
  within(text: string): FenceRow[] {
    const found = [...this.#rows.values()].filter(([, value]) =>
      text.includes(JSON.stringify(value).slice(1, -1)),
    )
    for (const row of found) this.#touch(row)
    return found
  }

  /** The rows for `fences`, each from the table or else from `highlight`, then held. */
  answer(fences: readonly (readonly [string, string])[], highlight: FenceHighlighter): FenceRow[] {
    return fences.map(([lang, value]) => {
      const row = this.#rows.get(keyOf(lang, value)) ?? [
        lang,
        value,
        tokensOf(highlight, lang, value),
      ]
      this.#touch(row)
      return row
    })
  }

  #touch(row: FenceRow): void {
    const key = keyOf(row[0], row[1])
    if (this.#rows.delete(key)) this.#units -= row[1].length
    this.#rows.set(key, row)
    this.#units += row[1].length
    for (const [oldest, held] of this.#rows) {
      if (this.#rows.size <= this.maxFences && this.#units <= this.maxUnits) break
      this.#rows.delete(oldest)
      this.#units -= held[1].length
    }
  }
}

const keyOf = (lang: string, value: string): string => JSON.stringify([lang, value])

/** The highlighter's answer, a throw drawn plain as the layout draws one. */
function tokensOf(
  highlight: FenceHighlighter,
  lang: string,
  value: string,
): FenceTokenLines | null {
  try {
    return highlight(lang, value) ?? null
  } catch {
    return null
  }
}
