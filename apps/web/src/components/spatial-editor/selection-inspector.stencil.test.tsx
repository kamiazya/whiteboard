// A stencil chosen in the inspector must DRAW, the way the same choice through
// `wb_canvas_edit` does (ADR-0034 decision 5: the appearance is expanded onto
// the node and the id is recorded beside it). The panel is a derived form that
// writes one facet record, so the expansion has to happen where the panel's
// write becomes editor commands — these tests drive the real panel and apply
// whatever commands it emits.

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { bundledFacetRegistry } from '@kamiazya/whiteboard-plugin-visual'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { applyCommand, type EditorCommand } from '../../lib/spatial/commands.js'
import { SelectionInspector } from './selection-inspector.js'

afterEach(cleanup)

const baseCanvas = (facets?: Record<string, unknown>, color?: string): SpatialCanvas => ({
  nodes: [
    textNode({
      id: 'n1',
      x: 0,
      y: 0,
      width: 120,
      height: 60,
      text: 'orders db',
      ...(color === undefined ? {} : { color }),
      ...(facets === undefined ? {} : { facets }),
    }),
    textNode({ id: 'n2', x: 200, y: 0, width: 120, height: 60, text: 'other' }),
  ],
  edges: [],
})

/** The inspector over a canvas that applies every command it emits, as the editor's eager chain does. */
function Harness(props: { initial: SpatialCanvas; onCanvas: (canvas: SpatialCanvas) => void }) {
  const [canvas, setCanvas] = useState(props.initial)
  const apply = (commands: readonly EditorCommand[]) => {
    const next = commands.reduce(applyCommand, canvas)
    props.onCanvas(next)
    setCanvas(next)
  }
  return (
    <SelectionInspector
      canvas={canvas}
      currentCanvas={() => canvas}
      selectedId="n1"
      selectedEdgeId={null}
      extraIds={new Set(['n2'])}
      tagSuggestions={undefined}
      tagLibrary={undefined}
      variant="dock"
      onCommands={apply}
    />
  )
}

function choose(label: string, initial = baseCanvas()): () => SpatialCanvas {
  let latest = initial
  render(
    <Harness
      initial={initial}
      onCanvas={(next) => {
        latest = next
      }}
    />,
  )
  fireEvent.click(screen.getByRole('radio', { name: label }))
  return () => latest
}

const facetsOf = (canvas: SpatialCanvas, id: string) =>
  canvas.nodes.find((node) => node.id === id)?.facets

describe('choosing a stencil in the inspector', () => {
  it('leaves the node wearing the stencil appearance, not only the record', () => {
    const canvas = choose('Datastore')()
    expect(facetsOf(canvas, 'n1')).toEqual({
      'visual.shape/v0': { kind: 'cylinder' },
      'visual.symbol/v0': { kind: 'icon', name: 'database' },
      'visual.stencil/v0': { stencil: 'visual.datastore' },
    })
  })

  it('dresses every node of the selection', () => {
    const canvas = choose('Gateway')()
    expect(facetsOf(canvas, 'n2')).toMatchObject({
      'visual.shape/v0': { kind: 'hexagon' },
      'visual.stencil/v0': { stencil: 'visual.gateway' },
    })
  })

  it('replaces the previous stencil appearance instead of mixing the two', () => {
    const dressed = baseCanvas({
      'visual.shape/v0': { kind: 'cylinder' },
      'visual.symbol/v0': { kind: 'icon', name: 'database' },
      'visual.stencil/v0': { stencil: 'visual.datastore' },
    })
    expect(facetsOf(choose('Queue', dressed)(), 'n1')).toEqual({
      'visual.shape/v0': { kind: 'parallelogram' },
      'visual.stencil/v0': { stencil: 'visual.queue' },
    })
  })

  it('None takes the stencil appearance back off, and keeps what the stencil never wrote', () => {
    const dressed = baseCanvas({
      'visual.shape/v0': { kind: 'cylinder' },
      'visual.symbol/v0': { kind: 'icon', name: 'database' },
      'visual.stencil/v0': { stencil: 'visual.datastore' },
      'planning.due/v0': { date: '2026-10-03' },
    })
    expect(facetsOf(choose('None', dressed)(), 'n1')).toEqual({
      'planning.due/v0': { date: '2026-10-03' },
    })
  })
})

describe('the bundled registry the panel reads', () => {
  it('offers the stencils this test dresses with', () => {
    expect(bundledFacetRegistry.assetIds('stencils')).toContain('visual.datastore')
  })
})
