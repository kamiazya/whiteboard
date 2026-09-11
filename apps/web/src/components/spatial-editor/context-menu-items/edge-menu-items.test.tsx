import { SPATIAL_LIGHT_PALETTE } from '@kamiazya/whiteboard-canvas-render'
// @vitest-environment node
// The edge branch's composition rules, pinned as plain function calls: items
// are data, so presence/order/label assertions and handler-spy assertions
// need no DOM.
import type { CanvasEdge } from '@kamiazya/whiteboard-model'
import { bundledFacetRegistry } from '@kamiazya/whiteboard-plugin-visual'
import { describe, expect, it, vi } from 'vitest'
import type { ContextMenuItem } from '../ContextMenu.js'
import { edgeMenuItems } from './edge-menu-items.js'

const baseEdge: CanvasEdge = { id: 'e1', fromNode: 'a', toNode: 'b' }

function labelsOf(items: readonly ContextMenuItem[]): string[] {
  return items.map((item) => ('label' in item ? item.label : `<${item.kind}>`))
}

describe('edgeMenuItems', () => {
  it('a locked edge offers exactly one action: Unlock, which releases the lock', () => {
    const onToggleEdgeLock = vi.fn()
    const items = edgeMenuItems({
      edge: baseEdge,
      point: { x: 0, y: 0 },
      setCommentCompose: vi.fn(),
      palette: SPATIAL_LIGHT_PALETTE,
      isEdgeLocked: () => true,
      edgeLockEnabled: true,
      applyResult: vi.fn(),
      setEdgeLabelEditId: vi.fn(),
      setSelectedEdgeId: vi.fn(),
      onToggleEdgeLock,
      facetRegistry: bundledFacetRegistry,
      setFacetPanelOpen: vi.fn(),
    })
    expect(labelsOf(items)).toEqual(['Unlock'])
    ;(items[0] as { onSelect: () => void }).onSelect()
    expect(onToggleEdgeLock).toHaveBeenCalledWith('e1', false)
  })

  it('an unlocked edge offers arrows/sides/color rows, then label, lock, and delete', () => {
    const items = edgeMenuItems({
      edge: baseEdge,
      point: { x: 0, y: 0 },
      setCommentCompose: vi.fn(),
      palette: SPATIAL_LIGHT_PALETTE,
      isEdgeLocked: () => false,
      edgeLockEnabled: true,
      applyResult: vi.fn(),
      setEdgeLabelEditId: vi.fn(),
      setSelectedEdgeId: vi.fn(),
      onToggleEdgeLock: vi.fn(),
      facetRegistry: bundledFacetRegistry,
      setFacetPanelOpen: vi.fn(),
    })
    expect(items.map((item) => item.kind ?? 'action')).toEqual([
      'options', // Arrows
      'options', // From side
      'options', // To side
      'options', // Color
      'separator',
      'action', // Facets… (the inspector doorway, since edges carry facets)
      'separator',
      'action', // Edit label
      'action', // Comment on this
      'action', // Lock
      'separator',
      'action', // Delete
    ])
    expect(items[0]).toMatchObject({ label: 'Arrows' })
    expect(items[1]).toMatchObject({ label: 'From side' })
    expect(items[2]).toMatchObject({ label: 'To side' })
    expect(items[3]).toMatchObject({ label: 'Color' })
    expect(items[5]).toMatchObject({ label: 'Facets…' })
    expect(items[7]).toMatchObject({ label: 'Edit label' })
    expect(items[8]).toMatchObject({ label: 'Comment on this' })
    expect(items[9]).toMatchObject({ label: 'Lock' })
    expect(items[11]).toMatchObject({ label: 'Delete', danger: true })
  })

  it('omits Lock when no lock callback is wired (edgeLockEnabled false)', () => {
    const items = edgeMenuItems({
      edge: baseEdge,
      point: { x: 0, y: 0 },
      setCommentCompose: vi.fn(),
      palette: SPATIAL_LIGHT_PALETTE,
      isEdgeLocked: () => false,
      edgeLockEnabled: false,
      applyResult: vi.fn(),
      setEdgeLabelEditId: vi.fn(),
      setSelectedEdgeId: vi.fn(),
      onToggleEdgeLock: undefined,
      facetRegistry: bundledFacetRegistry,
      setFacetPanelOpen: vi.fn(),
    })
    expect(items.some((item) => 'label' in item && item.label === 'Lock')).toBe(false)
  })

  it('Delete applies delete-edge and clears the selected edge', () => {
    const applyResult = vi.fn()
    const setSelectedEdgeId = vi.fn()
    const items = edgeMenuItems({
      edge: baseEdge,
      point: { x: 0, y: 0 },
      setCommentCompose: vi.fn(),
      palette: SPATIAL_LIGHT_PALETTE,
      isEdgeLocked: () => false,
      edgeLockEnabled: false,
      applyResult,
      setEdgeLabelEditId: vi.fn(),
      setSelectedEdgeId,
      onToggleEdgeLock: undefined,
      facetRegistry: bundledFacetRegistry,
      setFacetPanelOpen: vi.fn(),
    })
    const deleteItem = items.find((item) => 'label' in item && item.label === 'Delete')
    expect(deleteItem).toBeDefined()
    ;(deleteItem as { onSelect: () => void }).onSelect()
    expect(applyResult).toHaveBeenCalledWith({
      state: { kind: 'idle' },
      commands: [{ kind: 'delete-edge', id: 'e1' }],
    })
    expect(setSelectedEdgeId).toHaveBeenCalledWith(null)
  })
})
