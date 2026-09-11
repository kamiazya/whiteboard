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
import { clearFacetCatalogRecents, DerivedFacetForm } from './index.js'

afterEach(() => {
  cleanup()
  clearFacetCatalogRecents()
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
  { label: 'Travel', options: [row('🚀', 'rocket', 'travel space')] },
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
              entry: { label: 'Any character', payload: { kind: 'emoji' }, field: 'char' },
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

/** The catalog arrives through a promise, so every case waits for it once. */
const loaded = () => screen.findByRole('radio', { name: 'grinning face' })

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
    fireEvent.click(screen.getByRole('radio', { name: 'Travel' }))
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
    const category = screen.getByRole('radio', { name: 'Travel' }) as HTMLInputElement
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

  it('says so rather than showing an empty band when nothing matches', async () => {
    mount()
    await loaded()
    fireEvent.change(search(), { target: { value: 'zzzz' } })
    expect(screen.getByRole('status').textContent).toContain('No match')
  })
})

describe('free entry writes a value nobody listed', () => {
  const field = () => screen.getByRole('textbox', { name: 'Any character' })

  it('accepts a character the catalog does not carry', async () => {
    const onWrite = mount()
    await loaded()
    fireEvent.change(field(), { target: { value: '🦖' } })
    fireEvent.click(screen.getByRole('button', { name: 'Use' }))
    expect(onWrite).toHaveBeenCalledWith(SYMBOL_KEY, { kind: 'emoji', char: '🦖' })
  })

  it('applies on Enter, so a picker needs no second press', async () => {
    const onWrite = mount()
    await loaded()
    fireEvent.change(field(), { target: { value: '🦖' } })
    fireEvent.keyDown(field(), { key: 'Enter' })
    expect(onWrite).toHaveBeenCalledWith(SYMBOL_KEY, { kind: 'emoji', char: '🦖' })
  })

  /**
   * The facet's own schema is what refuses it, at the write boundary every
   * other control crosses — this component knows no rule about symbols.
   */
  it('refuses what the facet refuses, and says why instead of writing', async () => {
    const onWrite = mount()
    await loaded()
    fireEvent.change(field(), { target: { value: 'not one character' } })
    fireEvent.click(screen.getByRole('button', { name: 'Use' }))
    expect(onWrite).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain('single character')
  })
})

describe('what was picked here comes back on top', () => {
  it('offers a freshly typed symbol as a recent one, drawn like any other', async () => {
    mount()
    await loaded()
    fireEvent.change(screen.getByRole('textbox', { name: 'Any character' }), {
      target: { value: '🦖' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Use' }))
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
