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
describe('free entry says what to type', () => {
  const CLASS_KEY = 'demo.class/v0'
  const classRegistry = createFacetRegistry([
    definePlugin({
      id: 'demo',
      displayName: 'Demo',
      facets: [
        defineFacet({
          name: 'class',
          displayName: 'Class',
          version: 'v0',
          targets: ['node'],
          schema: z.object({ axis: z.string(), value: z.string() }),
          editor: {
            fields: {
              axis: { widget: 'text', placeholder: 'e.g. health' },
              value: { widget: 'text', placeholder: 'e.g. failing' },
            },
          },
        }),
      ],
    }),
  ])

  it('renders a declared placeholder inside the empty box', () => {
    render(
      <DerivedFacetForm
        facetKey={CLASS_KEY}
        title="Class"
        registry={classRegistry}
        stored={undefined}
        onWrite={vi.fn()}
      />,
    )
    expect(screen.getByLabelText('Class Axis').getAttribute('placeholder')).toBe('e.g. health')
    expect(screen.getByLabelText('Class Value').getAttribute('placeholder')).toBe('e.g. failing')
  })

  it('offers the values already in use as a datalist, so the second box is a pick', () => {
    render(
      <DerivedFacetForm
        facetKey={CLASS_KEY}
        title="Class"
        registry={classRegistry}
        stored={undefined}
        onWrite={vi.fn()}
        suggestions={{ axis: ['health', 'priority'], value: ['failing', 'healthy'] }}
      />,
    )
    const axis = screen.getByLabelText('Class Axis') as HTMLInputElement
    const listId = axis.getAttribute('list')
    expect(listId).not.toBeNull()
    const list = document.getElementById(listId as string) as HTMLDataListElement
    expect([...list.options].map((o) => o.value)).toEqual(['health', 'priority'])
    // Still free entry: the list suggests, the box takes anything.
    fireEvent.change(axis, { target: { value: 'phase' } })
    expect(axis.value).toBe('phase')
  })

  it('draws no datalist for a field with nothing to suggest', () => {
    render(
      <DerivedFacetForm
        facetKey={CLASS_KEY}
        title="Class"
        registry={classRegistry}
        stored={undefined}
        onWrite={vi.fn()}
        suggestions={{ axis: [] }}
      />,
    )
    expect(screen.getByLabelText('Class Axis').getAttribute('list')).toBeNull()
    expect(screen.getByLabelText('Class Value').getAttribute('list')).toBeNull()
    expect(document.querySelector('datalist')).toBeNull()
  })
})

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

describe('a number field that is emptied writes no number', () => {
  const counted = definePlugin({
    id: 'demo',
    displayName: 'Demo',
    facets: [
      defineFacet({
        name: 'count',
        displayName: 'Count',
        version: 'v0',
        targets: ['node'],
        schema: z.object({ count: z.number().optional() }),
      }),
    ],
  })

  it('clears the field rather than storing zero', () => {
    const onWrite = vi.fn()
    render(
      <DerivedFacetForm
        facetKey="demo.count/v0"
        title="Count"
        registry={createFacetRegistry([counted])}
        stored={{ count: 5 }}
        onWrite={onWrite}
      />,
    )
    const field = screen.getByLabelText('Count') as HTMLInputElement
    fireEvent.change(field, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save Count' }))
    expect(onWrite).toHaveBeenCalledWith('demo.count/v0', {})
  })
})

/**
 * An enum field with no richer declaration is a closed list, so it draws as
 * one: a free text box would accept a value the schema then refuses.
 */
describe('a choice field', () => {
  const PRIORITY_KEY = 'demo.priority/v0'
  const priorityRegistry = createFacetRegistry([
    definePlugin({
      id: 'demo',
      displayName: 'Demo',
      facets: [
        defineFacet({
          name: 'priority',
          displayName: 'Priority',
          version: 'v0',
          targets: ['node'],
          schema: z.object({ level: z.enum(['low', 'high']) }),
        }),
      ],
    }),
  ])

  it('draws a select of the enum and writes the pick at once', () => {
    const onWrite = vi.fn()
    render(
      <DerivedFacetForm
        facetKey={PRIORITY_KEY}
        title="Priority"
        registry={priorityRegistry}
        stored={undefined}
        onWrite={onWrite}
      />,
    )
    const select = screen.getByRole('combobox', { name: 'Priority Level' })
    expect(Array.from((select as HTMLSelectElement).options).map((option) => option.value)).toEqual(
      ['', 'low', 'high'],
    )

    fireEvent.change(select, { target: { value: 'high' } })
    expect(onWrite).toHaveBeenCalledWith(PRIORITY_KEY, { level: 'high' })
  })
})

/**
 * A union facet's discriminant is not a field of any variant, so nothing a
 * person edits puts it in the draft — until they touch the variant select.
 * The payload must carry it regardless, or the default variant can never be
 * written.
 */
describe('a variants facet', () => {
  const DUE_KEY = 'demo.due/v0'
  const dueRegistry = createFacetRegistry([
    definePlugin({
      id: 'demo',
      displayName: 'Demo',
      facets: [
        defineFacet({
          name: 'due',
          displayName: 'Due',
          version: 'v0',
          targets: ['node'],
          schema: z.union([
            z.object({ mode: z.literal('flag'), done: z.boolean() }),
            z.object({ mode: z.literal('tier'), tier: z.enum(['soon', 'later']) }),
          ]),
        }),
      ],
    }),
  ])

  it('writes the default variant with its discriminant', () => {
    const onWrite = vi.fn()
    render(
      <DerivedFacetForm
        facetKey={DUE_KEY}
        title="Due"
        registry={dueRegistry}
        stored={undefined}
        onWrite={onWrite}
      />,
    )
    fireEvent.click(screen.getByRole('checkbox', { name: 'Due Done' }))
    expect(onWrite).toHaveBeenCalledWith(DUE_KEY, { mode: 'flag', done: true })
  })

  it("switching variant writes the new variant's shape", () => {
    const onWrite = vi.fn()
    render(
      <DerivedFacetForm
        facetKey={DUE_KEY}
        title="Due"
        registry={dueRegistry}
        stored={{ mode: 'flag', done: true }}
        onWrite={onWrite}
      />,
    )
    fireEvent.change(screen.getByRole('combobox', { name: 'Due Mode' }), {
      target: { value: 'tier' },
    })
    fireEvent.change(screen.getByRole('combobox', { name: 'Due Tier' }), {
      target: { value: 'later' },
    })
    expect(onWrite).toHaveBeenLastCalledWith(DUE_KEY, { mode: 'tier', tier: 'later' })
  })
})

/**
 * A catalog's rows load only when the popover opens, so a stored value the
 * listed options do not name is drawn from the free-entry field the facet
 * declares — the trigger shows what is set without loading anything.
 */
describe("a catalog picker's trigger", () => {
  const MARK_KEY = 'demo.mark/v0'
  const load = vi.fn(async () => [])
  const markRegistry = createFacetRegistry([
    definePlugin({
      id: 'demo',
      displayName: 'Demo',
      facets: [
        defineFacet({
          name: 'mark',
          displayName: 'Mark',
          version: 'v0',
          targets: ['node'],
          schema: z.object({ kind: z.literal('emoji'), char: z.string().min(1) }),
          editor: {
            picker: {
              options: [{ payload: null, label: 'No mark' }],
              catalog: {
                label: 'Search marks',
                load,
                entry: { label: 'Any emoji', payload: { kind: 'emoji' }, field: 'char' },
              },
            },
          },
        }),
      ],
    }),
  ])

  it('draws a stored free-entry value without loading the catalog', () => {
    render(
      <DerivedFacetForm
        facetKey={MARK_KEY}
        title="Mark"
        registry={markRegistry}
        stored={{ kind: 'emoji', char: '⭐' }}
        onWrite={vi.fn()}
      />,
    )
    const trigger = screen.getByRole('button', { name: 'Choose mark' })
    expect(trigger.textContent).toContain('⭐')
    expect(trigger.textContent).not.toContain('Choose')
    expect(load).not.toHaveBeenCalled()
  })
})
