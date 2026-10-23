// The Display panel is ABOUT the document, and about the selection when there
// is one: a person looking for a node's stencil or shape opens Display, not a
// context menu. The selection arrives as a subscribable source (the editor's
// handle) and writes take the Facets panel's own write path.

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import type { EditorCommand } from '../../lib/spatial/commands.js'
import type { EditorSelection, SelectionSource } from '../../lib/spatial/editor-handle.js'
import { CanvasDisplaySettings } from './CanvasDisplaySettings.js'

afterEach(cleanup)

const canvas: SpatialCanvas = {
  nodes: [
    textNode({ id: 'n1', x: 0, y: 0, width: 120, height: 60, text: 'a' }),
    textNode({ id: 'n2', x: 200, y: 0, width: 120, height: 60, text: 'b' }),
  ],
  edges: [],
}

const NONE: EditorSelection = { selectedId: null, selectedEdgeId: null, extraIds: [] }

function sourceOf(initial: EditorSelection) {
  let current = initial
  const listeners = new Set<() => void>()
  const source: SelectionSource = {
    getSelection: () => current,
    subscribeSelection: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  return {
    source,
    select(next: EditorSelection) {
      current = next
      act(() => {
        for (const l of listeners) l()
      })
    },
  }
}

function Host(props: { source?: SelectionSource; onCanvas?: (c: SpatialCanvas) => void }) {
  const [state, setState] = useState(canvas)
  return (
    <CanvasDisplaySettings
      canvas={state}
      onChange={(next: SpatialCanvas, _command: EditorCommand) => {
        props.onCanvas?.(next)
        setState(next)
      }}
      {...(props.source === undefined ? {} : { selectionSource: props.source })}
    />
  )
}

describe('Display panel with a selection', () => {
  it('shows only the document section when nothing is selected', () => {
    const { source } = sourceOf(NONE)
    render(<Host source={source} />)
    expect(screen.queryByTestId('selection-facets')).toBeNull()
    expect(screen.getByText('Tags')).not.toBeNull()
  })

  it('shows the selected node facets above the document settings', () => {
    const { source } = sourceOf({ selectedId: 'n1', selectedEdgeId: null, extraIds: [] })
    render(<Host source={source} />)
    const section = screen.getByTestId('selection-facets')
    expect(within(section).getByLabelText('Shape')).not.toBeNull()
    const doc = screen.getByTestId('document-settings')
    expect(section.compareDocumentPosition(doc) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('writes a facet pick to the node through onChange', () => {
    const { source } = sourceOf({ selectedId: 'n1', selectedEdgeId: null, extraIds: [] })
    let latest = canvas
    render(<Host source={source} onCanvas={(c) => (latest = c)} />)
    const section = screen.getByTestId('selection-facets')
    fireEvent.click(within(section).getByLabelText('Diamond'))
    const n1 = latest.nodes.find((n) => n.id === 'n1')
    expect(n1?.facets?.['visual.shape/v0']).toEqual({ kind: 'diamond' })
    expect(latest.nodes.find((n) => n.id === 'n2')?.facets).toBeUndefined()
  })

  it('fans a write out to every selected node and says how many', () => {
    const { source } = sourceOf({ selectedId: 'n1', selectedEdgeId: null, extraIds: ['n2'] })
    let latest = canvas
    render(<Host source={source} onCanvas={(c) => (latest = c)} />)
    expect(screen.getByText('2 selected')).not.toBeNull()
    const section = screen.getByTestId('selection-facets')
    fireEvent.click(within(section).getByLabelText('Diamond'))
    expect(latest.nodes.every((n) => n.facets?.['visual.shape/v0'] !== undefined)).toBe(true)
  })

  it('commits a fanned-out pick as one change, so it is one undo step', () => {
    const { source } = sourceOf({ selectedId: 'n1', selectedEdgeId: null, extraIds: ['n2'] })
    const commands: EditorCommand[] = []
    render(
      <CanvasDisplaySettings
        canvas={canvas}
        onChange={(_next, command) => commands.push(command)}
        selectionSource={source}
      />,
    )
    fireEvent.click(within(screen.getByTestId('selection-facets')).getByLabelText('Diamond'))
    expect(commands.map((c) => c.kind)).toEqual(['batch'])
  })

  it('chains two picks made before the parent commits the first', () => {
    const { source } = sourceOf({ selectedId: 'n1', selectedEdgeId: null, extraIds: [] })
    let latest = canvas
    render(
      <CanvasDisplaySettings
        canvas={canvas}
        onChange={(next) => {
          latest = next
        }}
        selectionSource={source}
      />,
    )
    const section = screen.getByTestId('selection-facets')
    fireEvent.click(within(section).getByLabelText('Diamond'))
    fireEvent.click(within(section).getByLabelText('Top'))
    const facets = latest.nodes.find((n) => n.id === 'n1')?.facets ?? {}
    expect(facets['visual.shape/v0']).toEqual({ kind: 'diamond' })
    expect(Object.keys(facets).length).toBeGreaterThan(1)
  })

  it('follows the selection as it changes', () => {
    const s = sourceOf(NONE)
    render(<Host source={s.source} />)
    expect(screen.queryByTestId('selection-facets')).toBeNull()
    s.select({ selectedId: 'n2', selectedEdgeId: null, extraIds: [] })
    expect(screen.getByTestId('selection-facets')).not.toBeNull()
    s.select(NONE)
    expect(screen.queryByTestId('selection-facets')).toBeNull()
  })
})
