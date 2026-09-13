import { CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { shortcodeCompletionSource } from './shortcode-completion.js'

/**
 * The `:` half of the shortcode feature: what opens the list, what it
 * offers, and what accepting writes.
 *
 * The source is ASYNC — the 190KB search index arrives by dynamic import on
 * first use — so every case awaits. That is also why this file has no
 * `vi.mock`: the import is the thing under test.
 */
function complete(doc: string, pos = doc.length) {
  return shortcodeCompletionSource(new CompletionContext(EditorState.create({ doc }), pos, false))
}

/**
 * Accepts option `index` the way the plugin would: run its apply function.
 *
 * `against` is what the DOCUMENT says by the time apply runs, which is not
 * always what it said when the source did — that gap is the last case here.
 */
function accept(doc: string, result: CompletionResult, index: number, against = doc): string {
  const option = result.options[index]
  if (option === undefined || typeof option.apply !== 'function')
    throw new Error('expected an apply function')
  const view = new EditorView({ state: EditorState.create({ doc: against }) })
  option.apply(view, option, result.from, doc.length)
  const text = view.state.doc.toString()
  view.destroy()
  return text
}

describe('what opens the list', () => {
  /**
   * Two characters, which is what keeps this out of prose. A lone colon
   * would open 1914 rows on every `10:`, every `http:` and every sentence
   * with a clause in it.
   */
  it('stays shut on a bare colon and on one character', async () => {
    expect(await complete('a :')).toBeNull()
    expect(await complete('a :r')).toBeNull()
  })

  it('opens on two characters of a name', async () => {
    expect(await complete('ship it :ro')).not.toBeNull()
  })

  /** The shapes that made a naive trigger unusable in ordinary text. */
  it('stays shut on a time, a ratio and a URL scheme', async () => {
    expect(await complete('meet at 10:30')).toBeNull()
    expect(await complete('ratio 3:2')).toBeNull()
    expect(await complete('see https://x')).toBeNull()
  })

  /** A name nobody has is an empty answer, not an empty list. */
  it('answers null rather than an empty popup for a name that matches nothing', async () => {
    expect(await complete('a :zzzznotathing')).toBeNull()
  })
})

describe('what it offers and what accepting writes', () => {
  it('points from AFTER the colon, so the plugin filter has the query to score', async () => {
    const doc = 'ship it :ro'
    const result = await complete(doc)
    expect(result?.from).toBe(doc.length - 'ro'.length)
    expect(result?.validFor).toBeDefined()
  })

  it('labels rows with the bare shortcode and shows the character beside it', async () => {
    const result = await complete('x :rocket')
    const first = result?.options[0]
    expect(first?.label).toBe('rocket')
    expect(first?.displayLabel).toBe('🚀 rocket')
  })

  /**
   * Read off the real popup, which showed `🪨 rock` captioned `rock` — the
   * same word twice on a row already carrying the character.
   */
  it('captions a row only where the CLDR name says more than the shortcode', async () => {
    const plain = await complete('x :rocket')
    expect(plain?.options[0]?.detail).toBeUndefined()

    const captioned = await complete('x :flag_moro')
    expect(captioned?.options[0]?.label).toBe('flag_morocco')
    expect(captioned?.options[0]?.detail).toBe('flag: Morocco')
  })

  /**
   * The plugin re-scores against `label`, which would reshuffle this
   * module's own ranking; `boost` is what holds the exact name on top.
   */
  it('boosts in the order the search ranked them', async () => {
    const result = await complete('x :rocket')
    const boosts = (result?.options ?? []).map((option) => option.boost ?? 0)
    expect(boosts).toEqual([...boosts].sort((a, b) => b - a))
    expect(boosts[0]).toBeGreaterThan(0)
  })

  /**
   * The SHORTCODE, not the character — that is what the document stores,
   * and inserting 🚀 here would make this a different feature with the same
   * gesture. The closing colon is written too, so the projection sees a
   * complete name without the person typing one.
   */
  it('writes the shortcode, colons included, replacing what was typed', async () => {
    const doc = 'ship it :rocke'
    const result = await complete(doc)
    expect(result).not.toBeNull()
    expect(accept(doc, result as CompletionResult, 0)).toBe('ship it :rocket:')
  })

  /**
   * The position comes from the plugin, never from when the source ran: the
   * document can change in between (mobile autocorrect, a CRDT remote echo)
   * and a stale offset writes into the middle of a word.
   */
  it('writes nothing when the trigger is no longer where the plugin says', async () => {
    const doc = 'ship it :rocke'
    const result = await complete(doc)
    expect(accept(doc, result as CompletionResult, 0, 'moved on entirely')).toBe(
      'moved on entirely',
    )
  })
})

/**
 * Icons in the same list, under the same `:`.
 *
 * The vocabulary landed with no way to reach it: a person had to know the
 * spelling, and the trigger could not even see it — `[a-z0-9_]{2,}` rejects
 * the hyphen in `icon-`, so the popup DISAPPEARED at the moment they typed
 * it. Offering icons under their bare name too is what makes `:st` a way to
 * find one without knowing the prefix exists.
 */
describe('an icon is offered under the same colon', () => {
  const iconRows = (result: CompletionResult | null) =>
    (result?.options ?? []).filter((o) => o.label.startsWith('icon-')).map((o) => o.label)

  it('offers it under its bare name, so the prefix need not be known', async () => {
    expect(iconRows(await complete('a :star'))).toContain('icon-star')
  })

  it('keeps the list open once the prefix is typed, and narrows it', async () => {
    expect(iconRows(await complete('a :icon-'))).toEqual(
      expect.arrayContaining(['icon-star', 'icon-lock']),
    )
    expect(iconRows(await complete('a :icon-st'))).toEqual(['icon-star'])
  })

  it('writes the shortcode the renderer resolves', async () => {
    const result = await complete('a :icon-st')
    const index = (result?.options ?? []).findIndex((o) => o.label === 'icon-star')
    expect(index).toBeGreaterThanOrEqual(0)
    expect(accept('a :icon-st', result as CompletionResult, index)).toBe('a :icon-star:')
  })

  /**
   * Six names against 1914 rows: ordered by score they would be buried, and
   * an icon is the answer a person cannot get any other way — the emoji they
   * are also offered is a character they could have pasted.
   *
   * The emoji half is asserted as "still there" rather than by naming a
   * shortcode: the first version of this case expected `lock` beside
   * `icon-lock` and the vocabulary spells it `locked`, so the assertion was
   * about CLDR rather than about ordering.
   */
  it('offers icons before the 1914 emoji, without crowding them out', async () => {
    const labels = (await complete('a :lock'))?.options.map((o) => o.label) ?? []
    expect(labels[0]).toBe('icon-lock')
    expect(labels.filter((l) => !l.startsWith('icon-')).length).toBeGreaterThan(1)
  })

  /** The prose guard still holds — a hyphen must not open a list in a date. */
  it('stays shut where the colon is punctuation', async () => {
    expect(await complete('from 10:30-11')).toBeNull()
  })
})
