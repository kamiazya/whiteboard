// The node branch's composition rules, pinned as plain function calls: items
// are data, so presence/order/label assertions and handler-spy assertions
// need no DOM. The one genuinely untested slice (per the design) is the last
// case below: a LOCKED edge with both endpoints inside the multi-selection
// must be excluded from the area recolor — the membership half (a selected
// node/edge recolors, one leaving the selection does not) is already pinned
// at context-menu.browser.test.tsx:462-508 and is not re-tested here.
import { createFacetRegistry, defineFacet, definePlugin } from '@kamiazya/whiteboard-facet-engine'
import type { SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { NodeMenuItemsInput } from './node-menu-items.js'
import { nodeMenuItems } from './node-menu-items.js'

const textNode: SpatialNode = {
  id: 'a',
  type: 'text',
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  text: 'A',
}
const fileNode: SpatialNode = {
  id: 'f',
  type: 'file',
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  file: 'doc-1',
}

const emptyRegistry = createFacetRegistry([])
const nodeFacetRegistry = createFacetRegistry([
  definePlugin({
    id: 'demo',
    displayName: 'Demo',
    facets: [
      defineFacet({
        name: 'one',
        displayName: 'One',
        version: 'v0',
        targets: ['node' as const],
        schema: z.object({}),
      }),
    ],
  }),
])

function baseInput(
  node: SpatialNode,
  canvas: SpatialCanvas,
  overrides: Partial<NodeMenuItemsInput> = {},
): NodeMenuItemsInput {
  return {
    node,
    canvas,
    canvasRef: { current: canvas },
    theme: 'light',
    gestureState: { kind: 'idle' },
    isLocked: () => false,
    lockEnabled: false,
    isEdgeLocked: () => false,
    extraIds: new Set(),
    selectedId: node.id,
    isImageFileRef: undefined,
    missingFileRef: undefined,
    fileRefOptions: undefined,
    facetRegistry: emptyRegistry,
    selectedAlignableBoxes: () => [],
    pendingBackgroundGroupIdRef: { current: null },
    imageInputRef: { current: null },
    applyResult: vi.fn(),
    applyBoxMoves: vi.fn(),
    copySelection: vi.fn(),
    cutSelection: vi.fn(),
    duplicateSelection: vi.fn(),
    reorderSelection: vi.fn(),
    groupSelection: vi.fn(),
    openLinkNode: vi.fn(),
    onOpenFileRef: undefined,
    onAddImage: undefined,
    onToggleNodeLock: undefined,
    setGroupLabelEditId: vi.fn(),
    setLinkDialog: vi.fn(),
    setDocumentPicker: vi.fn(),
    setFacetPanelOpen: vi.fn(),
    ...overrides,
  }
}

function labelOf(item: unknown): string | undefined {
  return (item as { label?: string }).label
}

describe('nodeMenuItems', () => {
  it('a locked node offers exactly one action: Unlock, which releases the lock', () => {
    const onToggleNodeLock = vi.fn()
    const canvas: SpatialCanvas = { nodes: [textNode], edges: [] }
    const items = nodeMenuItems(
      baseInput(textNode, canvas, { isLocked: () => true, onToggleNodeLock }),
    )
    expect(items.map(labelOf)).toEqual(['Unlock'])
    ;(items[0] as { onSelect: () => void }).onSelect()
    expect(onToggleNodeLock).toHaveBeenCalledWith('a', false)
  })

  it('offers Group selection only when a multi-selection exists (extraIds non-empty)', () => {
    const canvas: SpatialCanvas = { nodes: [textNode], edges: [] }
    const without = nodeMenuItems(baseInput(textNode, canvas))
    expect(without.some((item) => labelOf(item) === 'Group selection')).toBe(false)

    const groupSelection = vi.fn()
    const withExtra = nodeMenuItems(
      baseInput(textNode, canvas, { extraIds: new Set(['b']), groupSelection }),
    )
    const groupItem = withExtra.find((item) => labelOf(item) === 'Group selection')
    expect(groupItem).toBeDefined()
    ;(groupItem as { onSelect: () => void }).onSelect()
    expect(groupSelection).toHaveBeenCalledWith(['a', 'b'])
  })

  it('offers Align at >=2 alignable boxes and Distribute at >=3, never before', () => {
    const canvas: SpatialCanvas = { nodes: [textNode], edges: [] }
    const solo = nodeMenuItems(baseInput(textNode, canvas))
    expect(solo.some((item) => labelOf(item) === 'Align')).toBe(false)
    expect(solo.some((item) => labelOf(item) === 'Distribute')).toBe(false)

    const pair = nodeMenuItems(baseInput(textNode, canvas, { extraIds: new Set(['b']) }))
    expect(pair.some((item) => labelOf(item) === 'Align')).toBe(true)
    expect(pair.some((item) => labelOf(item) === 'Distribute')).toBe(false)

    const trio = nodeMenuItems(baseInput(textNode, canvas, { extraIds: new Set(['b', 'c']) }))
    expect(trio.some((item) => labelOf(item) === 'Align')).toBe(true)
    expect(trio.some((item) => labelOf(item) === 'Distribute')).toBe(true)
  })

  it('hides Open canvas for a missing file ref, and offers it for a live one', () => {
    const canvas: SpatialCanvas = { nodes: [fileNode], edges: [] }
    const onOpenFileRef = vi.fn()
    const missing = nodeMenuItems(
      baseInput(fileNode, canvas, { onOpenFileRef, missingFileRef: () => true }),
    )
    expect(missing.some((item) => labelOf(item) === 'Open canvas')).toBe(false)

    const live = nodeMenuItems(
      baseInput(fileNode, canvas, { onOpenFileRef, missingFileRef: () => false }),
    )
    const openItem = live.find((item) => labelOf(item) === 'Open canvas')
    expect(openItem).toBeDefined()
    ;(openItem as { onSelect: () => void }).onSelect()
    expect(onOpenFileRef).toHaveBeenCalledWith('doc-1', undefined)
  })

  it('contributes the facet doorway only when a plugin targets a node', () => {
    const canvas: SpatialCanvas = { nodes: [textNode], edges: [] }
    const withoutFacets = nodeMenuItems(
      baseInput(textNode, canvas, { facetRegistry: emptyRegistry }),
    )
    expect(withoutFacets.some((item) => labelOf(item) === 'Facets…')).toBe(false)

    const setFacetPanelOpen = vi.fn()
    const withFacets = nodeMenuItems(
      baseInput(textNode, canvas, { facetRegistry: nodeFacetRegistry, setFacetPanelOpen }),
    )
    const doorway = withFacets.find((item) => labelOf(item) === 'Facets…')
    expect(doorway).toBeDefined()
    ;(doorway as { onSelect: () => void }).onSelect()
    expect(setFacetPanelOpen).toHaveBeenCalledWith(true)
  })

  it('excludes a LOCKED edge whose both endpoints are inside the multi-selection from the area recolor', () => {
    const nodeA: SpatialNode = {
      id: 'a',
      type: 'text',
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      text: 'A',
    }
    const nodeB: SpatialNode = {
      id: 'b',
      type: 'text',
      x: 20,
      y: 0,
      width: 10,
      height: 10,
      text: 'B',
    }
    const canvas: SpatialCanvas = {
      nodes: [nodeA, nodeB],
      edges: [{ id: 'ab', fromNode: 'a', toNode: 'b' }],
    }
    const applyResult = vi.fn()
    const items = nodeMenuItems(
      baseInput(nodeA, canvas, {
        extraIds: new Set(['b']),
        selectedId: 'a',
        isEdgeLocked: (id) => id === 'ab',
        applyResult,
      }),
    )
    const colorRow = items.find((item) => labelOf(item) === 'Color') as {
      options: readonly { ariaLabel?: string; onSelect: () => void }[]
    }
    const red = colorRow.options.find((option) => option.ariaLabel === 'Red')
    expect(red).toBeDefined()
    red?.onSelect()
    // Both selected nodes recolor; the edge between them, LOCKED, does not —
    // only 'set-node-color' commands, no 'set-edge-color' for 'ab'.
    expect(applyResult).toHaveBeenCalledWith({
      state: { kind: 'idle' },
      commands: [
        { kind: 'set-node-color', id: 'a', color: '1' },
        { kind: 'set-node-color', id: 'b', color: '1' },
      ],
    })
  })
})
