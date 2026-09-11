// The derived form (tiers 1 and 2) belongs to the facet system, not to one
// vessel. A facet that declares an editor should render the same controls
// wherever it is shown — before this it rendered only where apps/web drew
// it, and a second surface would have had to reimplement the derivation.
import { createFacetRegistry, defineFacet, definePlugin } from '@kamiazya/whiteboard-facet-engine'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { DerivedFacetForm } from './index.js'

afterEach(cleanup)

// A synthetic plugin throughout: this package is the library every plugin
// builds on, so a test that reaches for the bundled one cannot tell a
// library defect from that plugin's own declaration — and cannot import it
// either, since the bundled plugin depends on this package.
const SHAPE_KEY = 'demo.shape/v0'

const shapeRegistry = createFacetRegistry([
  definePlugin({
    id: 'demo',
    displayName: 'Demo',
    facets: [
      defineFacet({
        name: 'shape',
        displayName: 'Shape',
        version: 'v0',
        targets: ['node'],
        schema: z.object({ kind: z.enum(['ellipse', 'diamond']).optional() }),
        editor: {
          fields: {
            kind: {
              widget: 'segmented',
              label: 'Shape',
              quick: true,
              options: [
                { value: null, label: 'Rectangle', glyph: { kind: 'shape', name: 'square' } },
                { value: 'ellipse', label: 'Ellipse', glyph: { kind: 'shape', name: 'circle' } },
                { value: 'diamond', label: 'Diamond', glyph: { kind: 'shape', name: 'diamond' } },
              ],
            },
          },
        },
      }),
    ],
  }),
])

describe('DerivedFacetForm', () => {
  it("renders a declared editor's segmented control with its glyphs", () => {
    const onWrite = vi.fn()
    render(
      <DerivedFacetForm
        facetKey={SHAPE_KEY}
        title="Shape"
        registry={shapeRegistry}
        stored={{ kind: 'diamond' }}
        onWrite={onWrite}
      />,
    )
    // The declared options, drawn — not the raw enum a schema alone yields.
    expect(screen.getByLabelText('Ellipse')).not.toBeNull()
    expect(screen.getByLabelText('Diamond').closest('label')?.querySelector('svg')).not.toBeNull()

    fireEvent.click(screen.getByLabelText('Ellipse'))
    expect(onWrite).toHaveBeenCalledWith(SHAPE_KEY, { kind: 'ellipse' })
  })

  it('cannot store what the facet refuses', () => {
    const strict = definePlugin({
      id: 'demo',
      displayName: 'Demo',
      facets: [
        defineFacet({
          name: 'note',
          displayName: 'Note',
          version: 'v0',
          targets: ['node'],
          schema: z.object({ text: z.string().min(3) }),
        }),
      ],
    })
    const onWrite = vi.fn()
    render(
      <DerivedFacetForm
        facetKey="demo.note/v0"
        title="Note"
        registry={createFacetRegistry([strict])}
        stored={undefined}
        onWrite={onWrite}
      />,
    )
    fireEvent.change(screen.getByLabelText('Note Text'), { target: { value: 'no' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save Note' }))
    expect(onWrite).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).not.toBeNull()
  })
})

/**
 * A stored payload's key order is its WRITER'S. `wb_facet_set` and a
 * document authored elsewhere have no reason to match the declaration's,
 * and the picker compared the two by stringifying each — so such a value
 * matched no option and the control drew with NOTHING selected, over a
 * facet that was set, valid, and being drawn on the canvas.
 */
describe('a picker over a payload somebody else wrote', () => {
  const SYMBOL_KEY = 'demo.symbol/v0'
  const symbolRegistry = createFacetRegistry([
    definePlugin({
      id: 'demo',
      displayName: 'Demo',
      facets: [
        defineFacet({
          name: 'symbol',
          displayName: 'Symbol',
          version: 'v0',
          targets: ['node'],
          schema: z.object({ kind: z.literal('icon'), name: z.string().min(1) }),
          editor: {
            picker: {
              options: [
                { payload: null, label: 'No symbol' },
                { payload: { kind: 'icon', name: 'database' }, label: 'Database' },
              ],
            },
          },
        }),
      ],
    }),
  ])

  it('marks the option a reversed-key payload names', () => {
    render(
      <DerivedFacetForm
        facetKey={SYMBOL_KEY}
        title="Symbol"
        // The SAME value the declaration writes, keys the other way round.
        stored={{ name: 'database', kind: 'icon' }}
        registry={symbolRegistry}
        onWrite={vi.fn()}
      />,
    )

    expect((screen.getByRole('radio', { name: 'Database' }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('radio', { name: 'No symbol' }) as HTMLInputElement).checked).toBe(
      false,
    )
  })
})

/**
 * A `<label>` inside a `<label>` is invalid, and the browser resolves a
 * click on the inner one against the OUTER label's control — so the option
 * a person pressed is not the one that takes the press. A segmented field
 * therefore takes a plain wrapper; every other control here is a single
 * labelable element, which is what `htmlFor` is for.
 */
describe('label nesting', () => {
  it('never nests an option label inside a field label', () => {
    const { container } = render(
      <DerivedFacetForm
        facetKey={SHAPE_KEY}
        title="Shape"
        stored={undefined}
        registry={shapeRegistry}
        onWrite={vi.fn()}
      />,
    )

    const nested = [...container.querySelectorAll('label label')]
    expect(nested.map((el) => el.getAttribute('title') ?? el.textContent)).toEqual([])
    // And the options are still labels — the fix is where they sit, not
    // what they are.
    expect(container.querySelectorAll('label').length).toBeGreaterThan(1)
  })
})
