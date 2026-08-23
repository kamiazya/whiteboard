// Tier 1's vessel: every registered facet a node can carry is visible and
// editable here, including the ones no quick band knows about — the gap an
// agent's MCP write otherwise falls into.
import {
  bundledPlugins,
  createFacetRegistry,
  defineFacet,
  definePlugin,
} from '@kamiazya/whiteboard-facet-engine'
import type { SpatialNode } from '@kamiazya/whiteboard-model'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { FacetFormPanel } from './FacetFormPanel.js'

afterEach(cleanup)

const plain = definePlugin({
  id: 'planning',
  displayName: 'Planning',
  facets: [
    defineFacet({
      name: 'due',
      displayName: 'Due',
      version: 'v0',
      targets: ['node'],
      schema: z.object({
        date: z.string(),
        urgent: z.boolean().optional(),
        weight: z.number().optional(),
      }),
    }),
  ],
})
const registry = createFacetRegistry([...bundledPlugins, plain])

const node = (facets?: Record<string, unknown>): SpatialNode => ({
  id: 'n1',
  type: 'text',
  x: 0,
  y: 0,
  width: 100,
  height: 60,
  text: '',
  ...(facets === undefined ? {} : { 'x-whiteboard': { facets } }),
})

describe('FacetFormPanel', () => {
  it('lists every node-target facet under its plugin heading, widget or not', () => {
    render(<FacetFormPanel node={node()} registry={registry} onWrite={() => {}} />)
    expect(screen.getByText('Planning')).not.toBeNull()
    expect(screen.getByText('Visual style')).not.toBeNull()
    // The facet with no quick band is the one this panel exists for.
    expect(screen.getByLabelText('Due Date')).not.toBeNull()
  })

  it('shows the stored value and writes an edited payload back', () => {
    const onWrite = vi.fn()
    render(
      <FacetFormPanel
        node={node({ 'planning.due/v0': { date: '2026-08-22' } })}
        registry={registry}
        onWrite={onWrite}
      />,
    )
    const input = screen.getByLabelText('Due Date') as HTMLInputElement
    expect(input.value).toBe('2026-08-22')

    fireEvent.change(input, { target: { value: '2026-09-01' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save Due' }))
    expect(onWrite).toHaveBeenCalledWith('planning.due/v0', { date: '2026-09-01' })
  })

  it('refuses a payload the facet rejects, and says which field', () => {
    const onWrite = vi.fn()
    render(<FacetFormPanel node={node()} registry={registry} onWrite={onWrite} />)
    // `date` is required and empty: the registry's own write validation is
    // what answers, so the panel can never store what the tool would refuse.
    fireEvent.click(screen.getByRole('button', { name: 'Save Due' }))
    expect(onWrite).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain('date')
  })

  it('clears a facet, and a facet with no stored value has nothing to clear', () => {
    const onWrite = vi.fn()
    render(
      <FacetFormPanel
        node={node({ 'planning.due/v0': { date: '2026-08-22' } })}
        registry={registry}
        onWrite={onWrite}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Clear Due' }))
    expect(onWrite).toHaveBeenCalledWith('planning.due/v0', undefined)
    expect(screen.queryByRole('button', { name: 'Clear Shape' })).toBeNull()
  })
})

describe('control kinds the derived form emits', () => {
  it('a variants facet saves the arm the discriminant selects, with only its own fields', () => {
    const onWrite = vi.fn()
    render(
      <FacetFormPanel
        node={node({ 'visual.symbol/v0': { kind: 'icon', name: 'star' } })}
        registry={registry}
        onWrite={onWrite}
      />,
    )
    // Switching arms must not carry the previous arm's field into the
    // payload — `name` belongs to icon, `char` to emoji.
    fireEvent.change(screen.getByLabelText('Symbol Kind'), {
      target: { value: 'emoji' },
    })
    fireEvent.change(screen.getByLabelText('Symbol Char'), { target: { value: '⭐' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save Symbol' }))
    expect(onWrite).toHaveBeenCalledWith('visual.symbol/v0', { kind: 'emoji', char: '⭐' })
  })

  it('a toggle writes a boolean and a number control writes a number', () => {
    const onWrite = vi.fn()
    render(<FacetFormPanel node={node()} registry={registry} onWrite={onWrite} />)
    fireEvent.change(screen.getByLabelText('Due Date'), {
      target: { value: '2026-08-22' },
    })
    fireEvent.click(screen.getByLabelText('Due Urgent'))
    fireEvent.change(screen.getByLabelText('Due Weight'), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save Due' }))
    expect(onWrite).toHaveBeenCalledWith('planning.due/v0', {
      date: '2026-08-22',
      urgent: true,
      weight: 3,
    })
  })
})

describe("the panel honours a facet's declared editor", () => {
  it("uses the spec's label and its segmented options, not the derived defaults", () => {
    render(<FacetFormPanel node={node()} registry={registry} onWrite={() => {}} />)
    // visual.shape declares label 'Shape' and a segmented control; without
    // the spec the panel would show a select labelled 'kind'.
    const control = screen.getByLabelText('Shape')
    expect(control).not.toBeNull()
    expect(control.getAttribute('role')).toBe('radiogroup')
  })
})

describe('the absence segment clears the facet, like the band does', () => {
  it('picking the absence option removes the facet instead of failing validation', () => {
    const onWrite = vi.fn()
    render(
      <FacetFormPanel
        node={node({ 'visual.shape/v0': { kind: 'hexagon' } })}
        registry={registry}
        onWrite={onWrite}
      />,
    )
    // `Rectangle` carries value: null — the facet's ABSENCE. Staging it in
    // the draft and saving would validate `{}` against a schema whose
    // `kind` is required, so the pick must clear, exactly as the quick
    // band and the Clear button already do.
    fireEvent.click(screen.getByLabelText('Rectangle'))
    expect(onWrite).toHaveBeenCalledWith('visual.shape/v0', undefined)
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('a draft never outlives what it was seeded from', () => {
  it('clearing a facet empties the form, so a later Save cannot restore it', () => {
    const onWrite = vi.fn()
    const stored = node({ 'planning.due/v0': { date: '2026-08-22' } })
    const { rerender } = render(
      <FacetFormPanel node={stored} registry={registry} onWrite={onWrite} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Clear Due' }))
    // The host applies the clear and re-renders with the facet gone.
    rerender(<FacetFormPanel node={node()} registry={registry} onWrite={onWrite} />)
    expect((screen.getByLabelText('Due Date') as HTMLInputElement).value).toBe('')
    onWrite.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Save Due' }))
    expect(onWrite).not.toHaveBeenCalled()
  })

  it("switching variants drops the previous arm's field from the payload", () => {
    const onWrite = vi.fn()
    render(
      <FacetFormPanel
        node={node({ 'visual.symbol/v0': { kind: 'icon', name: 'star' } })}
        registry={registry}
        onWrite={onWrite}
      />,
    )
    fireEvent.change(screen.getByLabelText('Symbol Kind'), {
      target: { value: 'emoji' },
    })
    fireEvent.change(screen.getByLabelText('Symbol Char'), {
      target: { value: '⭐' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save Symbol' }))
    // `name` belonged to the icon arm and must not ride along: a schema
    // that passes unknown keys through would otherwise store it.
    const [, payload] = onWrite.mock.calls[0] as [string, Record<string, unknown>]
    expect(Object.keys(payload).sort()).toEqual(['char', 'kind'])
  })
})

describe('the panel is bound to ONE node', () => {
  it('switching the target node re-seeds the form, never carrying a draft across', () => {
    const onWrite = vi.fn()
    const { rerender } = render(
      <FacetFormPanel
        node={{ ...node({ 'planning.due/v0': { date: '2026-01-01' } }), id: 'a' }}
        registry={registry}
        onWrite={onWrite}
      />,
    )
    // Edit node A's draft without saving, then retarget the panel at node B.
    fireEvent.change(screen.getByLabelText('Due Date'), {
      target: { value: '2026-06-06' },
    })
    rerender(
      <FacetFormPanel
        node={{ ...node({ 'planning.due/v0': { date: '2026-12-31' } }), id: 'b' }}
        registry={registry}
        onWrite={onWrite}
      />,
    )

    // B's stored value is what shows — A's abandoned edit must not survive.
    expect((screen.getByLabelText('Due Date') as HTMLInputElement).value).toBe('2026-12-31')
    fireEvent.click(screen.getByRole('button', { name: 'Save Due' }))
    expect(onWrite).toHaveBeenCalledWith('planning.due/v0', { date: '2026-12-31' })
  })
})

describe('choices apply on pick; free entry still needs Save', () => {
  it('a segmented pick writes without any Save click', () => {
    const writes: { key: string; payload: unknown }[] = []
    render(
      <FacetFormPanel
        node={node()}
        registry={registry}
        onWrite={(key, payload) => writes.push({ key, payload })}
      />,
    )
    // The same facet reached from the quick band applies on tap; reaching
    // it here must not mean something different.
    fireEvent.click(screen.getByLabelText('Diamond'))
    expect(writes).toEqual([{ key: 'visual.shape/v0', payload: { kind: 'diamond' } }])
    // And no Save button exists for a facet made only of choices.
    expect(screen.queryByRole('button', { name: 'Save Shape' })).toBeNull()
  })

  it('a text field is still staged until Save — there is no "done" mid-typing', () => {
    const writes: unknown[] = []
    render(<FacetFormPanel node={node()} registry={registry} onWrite={() => writes.push(1)} />)
    fireEvent.change(screen.getByLabelText('Due Date'), { target: { value: '2026-09-01' } })
    expect(writes).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'Save Due' }))
    expect(writes).toEqual([1])
  })
})

describe('a segmented option draws its declared glyph', () => {
  it('shows the shape, not the word — the same vocabulary the quick band uses', () => {
    render(<FacetFormPanel node={node()} registry={registry} onWrite={() => {}} />)
    // visual.shape declares a glyph per option. A picker that names shapes in
    // words while the band beside it draws them is two vocabularies.
    const ellipse = screen.getByLabelText('Ellipse')
    const drawn = ellipse.closest('label')?.querySelector('svg')
    expect(drawn).not.toBeNull()
    // The word stays as the accessible name, so nothing is lost for a reader.
    expect(ellipse.getAttribute('aria-label')).toBe('Ellipse')
  })
})

it('does not print a field label that repeats the facet name', () => {
  render(<FacetFormPanel node={node()} registry={registry} onWrite={() => {}} />)
  // visual.shape declares label 'Shape' on its only field, under a heading
  // already reading 'Shape'.
  expect(screen.getAllByText('Shape')).toHaveLength(1)
  // The control still answers to that name.
  expect(screen.getByLabelText('Shape')).not.toBeNull()
})
