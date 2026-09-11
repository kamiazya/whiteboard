/**
 * The chrome the editor draws over a board — an in-place draft, a proposal
 * card — is painted from the palette the BOARD is drawn in (ADR-0030), not
 * from the bundled one, so nothing floating over a themed canvas arrives in
 * a colour the scene underneath never uses.
 */
import {
  resolveCanvasPalette,
  SPATIAL_DARK_PALETTE,
  SPATIAL_LIGHT_PALETTE,
} from '@kamiazya/whiteboard-canvas-render'
import type { Proposal, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createIdleState } from './gestures.js'
import { EdgeLabelEditorOverlay } from './label-editor-overlays.js'
import { MarkdownBodyEditorOverlay } from './markdown-body-editor-overlay.js'
import { ProposalCard } from './ProposalCard.js'

afterEach(cleanup)

const neon: SpatialCanvas = {
  nodes: [
    { id: 'a', type: 'text', x: 0, y: 0, width: 120, height: 60, text: 'a' },
    { id: 'b', type: 'text', x: 300, y: 200, width: 120, height: 60, text: 'b' },
  ],
  edges: [
    {
      id: 'e',
      from: { kind: 'node' as const, node: 'a' },
      to: { kind: 'node' as const, node: 'b' },
    },
  ],
  facets: { 'visual.theme/v0': { theme: 'visual.neon' } },
}

const edgePaths = [
  {
    id: 'e',
    path: [
      { x: 0, y: 0 },
      { x: 300, y: 200 },
    ],
  },
]

const proposal: Proposal = {
  id: 'p1',
  changes: [
    {
      id: 'node:a',
      op: 'node.patch',
      status: 'open',
      nodeId: 'a',
      patch: { x: 40 },
      assumed: { x: 0 },
    },
  ],
}

/** jsdom normalizes an inline `#RRGGBB` colour to `rgb(r, g, b)`. */
function rgb(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16)
  return `rgb(${(value >> 16) & 0xff}, ${(value >> 8) & 0xff}, ${value & 0xff})`
}

function renderLabelDraft(palette: ReturnType<typeof resolveCanvasPalette>) {
  render(
    <EdgeLabelEditorOverlay
      editId="e"
      canvas={neon}
      fontFamily="sans-serif"
      edgePaths={edgePaths}
      zoom={1}
      palette={palette}
      applyResult={vi.fn()}
      onClose={vi.fn()}
    />,
  )
  return screen.getByTestId('edge-label-editor')
}

describe('editor chrome palette', () => {
  it("types an in-place label draft in the theme's own label fill", () => {
    const themed = resolveCanvasPalette(neon, 'light', { style: 'document' })
    // Non-vacuous: the theme's ink and paper differ from the bundled pair.
    expect(themed.labelFill).not.toBe(SPATIAL_LIGHT_PALETTE.labelFill)
    expect(renderLabelDraft(themed).style.color).toBe(rgb(themed.labelFill))
  })

  it('keeps the bundled ink for a board that names no theme', () => {
    const bundled = resolveCanvasPalette({ nodes: [], edges: [] }, 'light')
    expect(renderLabelDraft(bundled).style.color).toBe(rgb(SPATIAL_LIGHT_PALETTE.labelFill))
  })

  it("wears the theme's proposal chrome on the card a bubble opens", () => {
    const themed = resolveCanvasPalette(neon, 'dark', { style: 'document' })
    expect(themed.proposal.edge).not.toBe(SPATIAL_DARK_PALETTE.proposal.edge)
    render(
      <ProposalCard
        proposal={proposal}
        canvas={neon}
        box={{ x: 0, y: 0, width: 200, height: 0 }}
        palette={themed}
        onDecide={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    const card = screen.getByTestId('proposal-card')
    expect(card.style.background).toBe(rgb(themed.proposal.bubbleFill))
    expect(card.style.border).toBe(`1px solid ${rgb(themed.proposal.edge)}`)
    expect(card.style.color).toBe(rgb(themed.labelFill))
  })

  function renderBodyDraftCover(
    theme: 'light' | 'dark',
    palette: ReturnType<typeof resolveCanvasPalette>,
  ) {
    const node = neon.nodes[0] as SpatialCanvas['nodes'][number] & {
      readonly type: 'text'
      readonly text: string
    }
    render(
      <MarkdownBodyEditorOverlay
        node={node}
        selectionBox={{ x: 0, y: 0, width: 120, height: 60 }}
        sceneNodes={[]}
        // The scene has not yet stopped drawing the node's text, so the
        // draft keeps its opaque cover over the committed render.
        sceneCurrent={false}
        threads={undefined}
        onRequestComment={() => false}
        zoom={1}
        theme={theme}
        palette={palette}
        canvas={neon}
        gestureState={createIdleState()}
        applyResult={vi.fn()}
        fontFamily="sans-serif"
      />,
    )
    return screen.getByTestId('text-node-editor')
  }

  it("covers a body draft in the theme's own node fill while the scene catches up", () => {
    const themed = resolveCanvasPalette(neon, 'dark', { style: 'document' })
    // Non-vacuous: the bundled dark text node has no fill at all.
    expect(themed.node.text.fill).not.toBe(SPATIAL_DARK_PALETTE.node.text.fill)
    expect(renderBodyDraftCover('dark', themed).style.background).toBe(rgb(themed.node.text.fill))
  })

  it("covers a fill-less node in the palette's paper, not a colour the board never uses", () => {
    const bundled = resolveCanvasPalette({ nodes: [], edges: [] }, 'dark')
    expect(bundled.node.text.fill).toBe('none')
    expect(renderBodyDraftCover('dark', bundled).style.background).toBe(rgb(bundled.surface))
  })
})
