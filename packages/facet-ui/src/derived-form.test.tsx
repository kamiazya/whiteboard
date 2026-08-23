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
                { value: null, label: 'Rectangle', glyph: 'square' },
                { value: 'ellipse', label: 'Ellipse', glyph: 'circle' },
                { value: 'diamond', label: 'Diamond', glyph: 'diamond' },
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
