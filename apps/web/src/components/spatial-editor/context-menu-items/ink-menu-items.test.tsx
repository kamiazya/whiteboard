// @vitest-environment node
// The ink branch's composition rules, pinned as plain function calls in the
// idiom `edge-menu-items.test.tsx` already uses: items are data, so what a
// row writes needs no DOM.
import { SPATIAL_LIGHT_PALETTE } from '@kamiazya/whiteboard-canvas-render'
import type { CanvasEdge, CanvasLine, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { VISUAL_INK_KEY } from '@kamiazya/whiteboard-plugin-visual'
import { describe, expect, it, vi } from 'vitest'
import { deleteInkCommand, type EditorCommand } from '../../../lib/spatial/commands.js'
import type { ContextMenuItem } from '../ContextMenu.js'
import { type InkMenuItemsInput, inkMenuItems } from './ink-menu-items.js'

const stroke = (id: string, group?: string): CanvasLine => ({
  id,
  from: { kind: 'point', point: { x: 0, y: 0 } },
  to: { kind: 'point', point: { x: 100, y: 0 } },
  ...(group === undefined ? {} : { facets: { [VISUAL_INK_KEY]: { group } } }),
})

const relation: CanvasEdge = { id: 'e1', from: { node: 'a' }, to: { node: 'b' } }

function itemsFor(
  canvas: SpatialCanvas,
  line: CanvasLine,
  overrides: Partial<InkMenuItemsInput> = {},
): { items: ContextMenuItem[]; commands: EditorCommand[] } {
  const commands: EditorCommand[] = []
  const items = inkMenuItems({
    line,
    lines: canvas.lines ?? [],
    palette: SPATIAL_LIGHT_PALETTE,
    isEdgeLocked: () => false,
    edgeLockEnabled: false,
    onToggleEdgeLock: vi.fn(),
    applyResult: (result) => commands.push(...result.commands),
    setSelectedEdgeId: vi.fn(),
    setEdgeLabelEditId: vi.fn(),
    selectedInkIds: [line.id],
    createId: () => 'minted',
    deleteInk: (id) => deleteInkCommand(canvas, id),
    ...overrides,
  })
  return { items, commands }
}

const pick = (items: readonly ContextMenuItem[], label: string) => {
  const found = items.find((item) => 'label' in item && item.label === label)
  if (found === undefined)
    throw new Error(
      `no ${label} item: ${JSON.stringify(items.map((i) => ('label' in i ? i.label : i.kind)))}`,
    )
  return found as { onSelect: () => void }
}

describe('inkMenuItems Delete', () => {
  it('takes every selected id, relations included, not only the strokes', () => {
    // A marquee band fills `selectedInkIds` from BOTH collections
    // (`[...gathered.lines, ...gathered.edges]`), and the Delete KEY already
    // resolves each id against both. A menu Delete that resolved only
    // against the strokes left the banded relations standing — the same
    // shape as every other defect this ledger exists to catch: one reader
    // naming one collection over a canvas that holds four.
    const canvas: SpatialCanvas = {
      nodes: [],
      edges: [relation],
      lines: [stroke('l1'), stroke('l2')],
    }
    const { items, commands } = itemsFor(canvas, stroke('l1'), {
      selectedInkIds: ['l1', 'e1', 'l2'],
    })
    pick(items, 'Delete').onSelect()
    expect(commands).toEqual([
      { kind: 'delete-line', id: 'l1' },
      { kind: 'delete-edge', id: 'e1' },
      { kind: 'delete-line', id: 'l2' },
    ])
  })

  it('takes the pressed stroke alone when it is the whole selection', () => {
    const canvas: SpatialCanvas = { nodes: [], edges: [], lines: [stroke('l1'), stroke('l2')] }
    const { items, commands } = itemsFor(canvas, stroke('l1'))
    pick(items, 'Delete').onSelect()
    expect(commands).toEqual([{ kind: 'delete-line', id: 'l1' }])
  })

  it('drops an id the canvas no longer holds rather than writing a command for it', () => {
    const canvas: SpatialCanvas = { nodes: [], edges: [], lines: [stroke('l1')] }
    const { items, commands } = itemsFor(canvas, stroke('l1'), { selectedInkIds: ['l1', 'gone'] })
    pick(items, 'Delete').onSelect()
    expect(commands).toEqual([{ kind: 'delete-line', id: 'l1' }])
  })
})

describe('inkMenuItems', () => {
  it('offers Group only once two or more selected strokes are on the canvas', () => {
    const canvas: SpatialCanvas = { nodes: [], edges: [], lines: [stroke('l1'), stroke('l2')] }
    const labels = (input: Partial<InkMenuItemsInput>) =>
      itemsFor(canvas, stroke('l1'), input).items.map((item) => ('label' in item ? item.label : ''))
    expect(labels({ selectedInkIds: ['l1'] })).not.toContain('Group')
    expect(labels({ selectedInkIds: ['l1', 'l2'] })).toContain('Group')
    // A banded RELATION is not a stroke, so it cannot make a mark of one.
    expect(labels({ selectedInkIds: ['l1', 'e1'] })).not.toContain('Group')
  })

  it('joins the whole selection under one minted id', () => {
    const canvas: SpatialCanvas = { nodes: [], edges: [], lines: [stroke('l1'), stroke('l2')] }
    const { items, commands } = itemsFor(canvas, stroke('l1'), { selectedInkIds: ['l1', 'l2'] })
    pick(items, 'Group').onSelect()
    expect(commands).toEqual([
      { kind: 'set-line-facet', id: 'l1', key: VISUAL_INK_KEY, payload: { group: 'minted' } },
      { kind: 'set-line-facet', id: 'l2', key: VISUAL_INK_KEY, payload: { group: 'minted' } },
    ])
  })

  it('offers a locked stroke exactly one action', () => {
    const canvas: SpatialCanvas = { nodes: [], edges: [], lines: [stroke('l1')] }
    const { items } = itemsFor(canvas, stroke('l1'), { isEdgeLocked: () => true })
    expect(items.map((item) => ('label' in item ? item.label : item.kind))).toEqual(['Unlock'])
  })
})
