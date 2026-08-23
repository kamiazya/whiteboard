// The derived form (tiers 1 and 2) belongs to the facet system, not to one
// vessel. A facet that declares an editor should render the same controls
// wherever it is shown — before this it rendered only where apps/web drew
// it, and a second surface would have had to reimplement the derivation.
import {
  bundledFacetRegistry,
  createFacetRegistry,
  defineFacet,
  definePlugin,
  VISUAL_SHAPE_KEY,
} from '@kamiazya/whiteboard-facet-engine'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { DerivedFacetForm } from './index.js'

afterEach(cleanup)

describe('DerivedFacetForm', () => {
  it("renders a declared editor's segmented control with its glyphs", () => {
    const onWrite = vi.fn()
    render(
      <DerivedFacetForm
        facetKey={VISUAL_SHAPE_KEY}
        title="Shape"
        registry={bundledFacetRegistry}
        stored={{ kind: 'diamond' }}
        onWrite={onWrite}
      />,
    )
    // The declared options, drawn — not the raw enum a schema alone yields.
    expect(screen.getByLabelText('Ellipse')).not.toBeNull()
    expect(screen.getByLabelText('Diamond').closest('label')?.querySelector('svg')).not.toBeNull()

    fireEvent.click(screen.getByLabelText('Ellipse'))
    expect(onWrite).toHaveBeenCalledWith(VISUAL_SHAPE_KEY, { kind: 'ellipse' })
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
