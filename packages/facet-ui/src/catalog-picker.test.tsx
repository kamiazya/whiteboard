// A picker's OPEN half, rendered: search, categories, recents and free
// entry over a catalog too large to list in a definition.
//
// A synthetic plugin throughout, for the reason the derived-form tests give:
// this package is the library every plugin builds on, and a test reaching
// for the bundled one cannot tell a library defect from that plugin's own
// declaration.
import { createFacetRegistry, defineFacet, definePlugin } from '@kamiazya/whiteboard-facet-engine'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { clearCatalogRecents, DerivedFacetForm, EMOJI_FONT_STACK } from './index.js'

afterEach(() => {
  cleanup()
  clearCatalogRecents()
})

const SYMBOL_KEY = 'demo.symbol/v0'

const symbolSchema = z.union([
  z.object({ kind: z.literal('icon'), name: z.string().min(1) }),
  z.object({
    kind: z.literal('emoji'),
    // The real facet's rule, because it is what free entry is checked
    // against: one character, not a sentence.
    char: z.string().refine((value) => [...value].length === 1, 'must be a single character'),
  }),
])

/** The shape a real catalog row has: the character is the option's glyph. */
const row = (char: string, label: string, keywords: string) => ({
  payload: { kind: 'emoji', char },
  label,
  keywords: [keywords],
  glyph: { kind: 'char' as const, value: char },
})

const SECTIONS = [
  {
    label: 'Smileys',
    options: [row('😀', 'grinning face', 'smiling'), row('🔥', 'fire', 'hot flame')],
  },
  {
    label: 'Travel & Places',
    keywords: ['旅行 乗り物'],
    options: [row('🚀', 'rocket', 'transport air')],
  },
]

const registry = createFacetRegistry([
  definePlugin({
    id: 'demo',
    displayName: 'Demo',
    facets: [
      defineFacet({
        name: 'symbol',
        displayName: 'Symbol',
        version: 'v0',
        targets: ['node'],
        schema: symbolSchema,
        editor: {
          picker: {
            options: [
              { payload: null, label: 'No symbol', glyph: { kind: 'shape', name: 'none' } },
            ],
            catalog: {
              label: 'Search symbols',
              load: async () => SECTIONS,
              entry: {
                label: 'Any character',
                placeholder: 'Paste any character',
                payload: { kind: 'emoji' },
                field: 'char',
              },
            },
          },
        },
      }),
    ],
  }),
])

function mount(stored?: unknown) {
  const onWrite = vi.fn()
  render(
    <DerivedFacetForm
      facetKey={SYMBOL_KEY}
      title="Symbol"
      stored={stored}
      registry={registry}
      onWrite={onWrite}
    />,
  )
  return onWrite
}

/**
 * A catalog opens in a popover now, so every case presses the trigger
 * first — and then waits, because the rows arrive through a promise.
 *
 * Both steps are the flow a person takes, which is why the helper does them
 * rather than the component being reached around: a test that mounted the
 * picker directly would pass over a trigger that no longer opens it.
 */
async function loaded() {
  fireEvent.click(screen.getByRole('button', { name: 'Choose symbol' }))
  return screen.findByRole('radio', { name: 'grinning face' })
}

describe('a catalog picker offers more than the definition listed', () => {
  it('keeps the listed options and adds the loaded ones beside them', async () => {
    mount()
    await loaded()
    expect(screen.getByRole('radio', { name: 'No symbol' })).toBeTruthy()
    // Only the first section is on screen; the second is a category away.
    expect(screen.queryByRole('radio', { name: 'rocket' })).toBeNull()
  })

  it('writes the payload of a row that was never in the definition', async () => {
    const onWrite = mount()
    await loaded()
    fireEvent.click(screen.getByRole('radio', { name: 'fire' }))
    expect(onWrite).toHaveBeenCalledWith(SYMBOL_KEY, { kind: 'emoji', char: '🔥' })
  })

  it('draws the stored value as the selected cell, whichever band it is in', async () => {
    mount({ kind: 'emoji', char: '🔥' })
    await loaded()
    expect((screen.getByRole('radio', { name: 'fire' }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('radio', { name: 'grinning face' }) as HTMLInputElement).checked).toBe(
      false,
    )
  })

  it('shows another category without leaving the first one on screen', async () => {
    mount()
    await loaded()
    fireEvent.click(screen.getByRole('radio', { name: 'Travel & Places' }))
    expect(screen.getByRole('radio', { name: 'rocket' })).toBeTruthy()
    expect(screen.queryByRole('radio', { name: 'grinning face' })).toBeNull()
  })

  /**
   * The category band and the symbol band must not be one radio group: a
   * browser treats same-named radios as one answer, so picking a category
   * would uncheck the symbol a person had chosen.
   */
  it('keeps categories out of the group the value is chosen in', async () => {
    mount({ kind: 'emoji', char: '🔥' })
    await loaded()
    const category = screen.getByRole('radio', { name: 'Travel & Places' }) as HTMLInputElement
    const cell = screen.getByRole('radio', { name: 'fire' }) as HTMLInputElement
    expect(category.name).not.toBe(cell.name)
  })
})

describe('search finds a row by any of the words it carries', () => {
  const search = () => screen.getByRole('searchbox', { name: 'Search symbols' })

  it('matches a keyword the label never says', async () => {
    mount()
    await loaded()
    fireEvent.change(search(), { target: { value: 'flame' } })
    expect(screen.getByRole('radio', { name: 'fire' })).toBeTruthy()
    expect(screen.queryByRole('radio', { name: 'grinning face' })).toBeNull()
  })

  it('searches across every category, not only the one on screen', async () => {
    mount()
    await loaded()
    fireEvent.change(search(), { target: { value: 'rocket' } })
    expect(screen.getByRole('radio', { name: 'rocket' })).toBeTruthy()
  })

  /** Pasting a symbol in is how somebody asks whether it is already here. */
  it('matches the character itself, not only its name', async () => {
    mount()
    await loaded()
    fireEvent.change(search(), { target: { value: '🚀' } })
    expect(screen.getByRole('radio', { name: 'rocket' })).toBeTruthy()
  })

  it('takes the terms in any order and anywhere in the words', async () => {
    mount()
    await loaded()
    fireEvent.change(search(), { target: { value: 'face grin' } })
    expect(screen.getByRole('radio', { name: 'grinning face' })).toBeTruthy()
  })

  /**
   * The word on the CATEGORY chip, which is the one a person can actually
   * see. Found by measuring the real catalog: `travel` matched nothing,
   * because Unicode names the rocket "rocket" and files it under
   * `transport-air` while the band it lives in reads "Travel & Places".
   */
  it('matches the name of the band an option lives in', async () => {
    mount()
    await loaded()
    fireEvent.change(search(), { target: { value: 'travel' } })
    expect(screen.getByRole('radio', { name: 'rocket' })).toBeTruthy()
    expect(screen.queryByRole('radio', { name: 'fire' })).toBeNull()
  })

  /**
   * A band's LABEL is one string in one language, so a band carries
   * keywords of its own and its options inherit them. `Food & Drink` is not
   * what somebody reaches for when they want something to eat, and no
   * per-option index supplies it — CLDR annotates emoji, not groups.
   */
  it('matches a word the band carries that neither its label nor its options say', async () => {
    mount()
    await loaded()
    fireEvent.change(search(), { target: { value: '乗り物' } })
    expect(screen.getByRole('radio', { name: 'rocket' })).toBeTruthy()
    expect(screen.queryByRole('radio', { name: 'fire' })).toBeNull()
  })

  it('says so rather than showing an empty band when nothing matches', async () => {
    mount()
    await loaded()
    fireEvent.change(search(), { target: { value: 'zzzz' } })
    expect(screen.getByRole('status').textContent).toContain('No match')
  })
})

describe('free entry is a RESULT, not a second input', () => {
  const search = () => screen.getByRole('searchbox', { name: 'Search symbols' })

  /**
   * One box, because two were the same gesture twice: the search already
   * matched a pasted CHARACTER, so "I have this symbol, use it" had two
   * controls and only one of them wrote anything. Nobody could tell which.
   */
  it('offers no input of its own, and says in the search box that it takes one', async () => {
    mount()
    await loaded()
    expect(screen.queryByRole('textbox', { name: 'Any character' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Use' })).toBeNull()
    expect(search().getAttribute('placeholder')).toBe('Paste any character')
  })

  it('leads the results with a character the catalog does not have', async () => {
    const onWrite = mount()
    await loaded()
    fireEvent.change(search(), { target: { value: '🦖' } })
    fireEvent.click(screen.getByRole('radio', { name: '🦖' }))
    expect(onWrite).toHaveBeenCalledWith(SYMBOL_KEY, { kind: 'emoji', char: '🦖' })
  })

  it('applies on Enter, so a paste needs no press at all', async () => {
    const onWrite = mount()
    await loaded()
    fireEvent.change(search(), { target: { value: '🦖' } })
    fireEvent.keyDown(search(), { key: 'Enter' })
    expect(onWrite).toHaveBeenCalledWith(SYMBOL_KEY, { kind: 'emoji', char: '🦖' })
  })

  /**
   * The catalog HAS 🔥, so offering it again would draw one symbol twice in
   * one grid — once as itself and once as its row — and a person could not
   * tell which of the two they had picked.
   */
  it('offers nothing extra for a character the catalog already lists', async () => {
    mount()
    await loaded()
    fireEvent.change(search(), { target: { value: '🔥' } })
    expect(screen.getAllByRole('radio', { name: 'fire' })).toHaveLength(1)
    expect(screen.queryByRole('radio', { name: '🔥' })).toBeNull()
  })

  /**
   * The facet's own schema decides whether the text is a value at all, and
   * an invalid one is simply NOT OFFERED — which beats a control that takes
   * it and then reports an error. This component knows no rule about
   * symbols and so cannot hold a laxer one.
   */
  it('offers nothing for text the facet would refuse, and writes nothing', async () => {
    const onWrite = mount()
    await loaded()
    fireEvent.change(search(), { target: { value: 'not one character' } })
    expect(onWrite).not.toHaveBeenCalled()
    expect(screen.queryByRole('radio', { name: 'not one character' })).toBeNull()
    expect(screen.getByRole('status').textContent).toContain('No match')
  })

  /** And says which of the two empty-handed answers this is. */
  it('distinguishes nothing found from something not in the list', async () => {
    mount()
    await loaded()
    fireEvent.change(search(), { target: { value: '🦖' } })
    expect(screen.getByRole('status').textContent).toContain('Not in the list')
  })
})

describe('an emoji is drawn by a font that has it in colour', () => {
  /**
   * Left to the inherited stack, an emoji is drawn by whichever installed
   * font claims its codepoint first — and several ordinary text faces claim
   * the common ones as MONOCHROME OUTLINES. Measured in this repo's own
   * headless Chromium: 😀 😃 🙂 😉 ☺️ ♠️ 🏁 came out as grey line drawings
   * beside 🤣 🥰 ⭐ 🔥 in full colour, one grid with two kinds of picture
   * and nothing in the data to explain it.
   *
   * jsdom computes no fonts, so what is pinned HERE is that the declaration
   * reaches the cell at all. The pixels are the browser suite's job.
   */
  it('names the colour faces on every cell, rather than inheriting the panel stack', async () => {
    mount()
    await loaded()
    const cell = screen
      .getByRole('radio', { name: 'grinning face' })
      .closest('label') as HTMLElement
    const drawn = cell.querySelector('[aria-hidden="true"] span') as HTMLElement
    expect(drawn.textContent).toBe('😀')
    expect(drawn.style.fontFamily).toContain('Color Emoji')
  })

  /**
   * The one face that must NOT be in the stack: `Segoe UI Symbol` is
   * Windows's monochrome emoji font, and listing it is how a stack meant to
   * force colour quietly reintroduces the outlines it was written to stop.
   */
  it('names no monochrome face among them', () => {
    expect(EMOJI_FONT_STACK).not.toContain('Segoe UI Symbol')
    expect(EMOJI_FONT_STACK).toContain('Apple Color Emoji')
    expect(EMOJI_FONT_STACK).toContain('Noto Color Emoji')
  })
})

describe('what was picked here comes back on top', () => {
  it('offers a freshly typed symbol as a recent one, drawn like any other', async () => {
    mount()
    await loaded()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search symbols' }), {
      target: { value: '🦖' },
    })
    fireEvent.click(screen.getByRole('radio', { name: '🦖' }))
    await waitFor(() => {
      expect(screen.getByRole('radiogroup', { name: 'Symbol recently used' })).toBeTruthy()
    })
    expect(screen.getAllByRole('radio', { name: '🦖' })).toHaveLength(1)
  })

  /**
   * Recents exist for the moment the panel is closed and reopened — held
   * inside the component they would remember nothing past the first close,
   * which is the only moment they are for.
   */
  it('survives the picker being unmounted and drawn again', async () => {
    mount()
    await loaded()
    fireEvent.click(screen.getByRole('radio', { name: 'fire' }))
    cleanup()

    mount()
    await loaded()
    expect(screen.getByRole('radiogroup', { name: 'Symbol recently used' }).textContent).toContain(
      '🔥',
    )
  })
})
