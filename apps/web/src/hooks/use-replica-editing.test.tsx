/**
 * Editing on the offline replica: an edit writes through the record's
 * containers and queues a save, and only on the kind of document it belongs to.
 */
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  readEdgeLocks,
  readNodeLocks,
  readSpatialCanvas,
  writeMarkdownBody,
} from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { act, renderHook } from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceDocumentEntry } from '../lib/document-entry.js'
import { type ReplicaRecord, replicaEntries } from '../lib/replica-record.js'
import { useReplicaEditing } from './use-replica-editing.js'

const MD = '01ARZ3NDEKTSV4RRFFQ69G5FB1'
const SP = '01ARZ3NDEKTSV4RRFFQ69G5FB2'
const MD2 = '01ARZ3NDEKTSV4RRFFQ69G5FB3'

function record(): ReplicaRecord {
  const doc = new LoroDoc()
  createWorkspaceDocumentAtPath(doc, { path: 'notes/plan', documentId: MD, kind: 'markdown' })
  writeMarkdownBody(documentContainers(doc, MD), '# Plan')
  createWorkspaceDocumentAtPath(doc, { path: 'sketch', documentId: SP, kind: 'spatial' })
  createWorkspaceDocumentAtPath(doc, { path: 'notes/log', documentId: MD2, kind: 'markdown' })
  writeMarkdownBody(documentContainers(doc, MD2), '# Log')
  doc.commit()
  return doc
}

function entry(doc: ReplicaRecord, documentId: string): WorkspaceDocumentEntry {
  const found = replicaEntries(doc).find((e) => e.documentId === documentId)
  if (found === undefined) throw new Error(`fixture lost ${documentId}`)
  return found
}

function withNode(canvas: SpatialCanvas): SpatialCanvas {
  const added = textNode({ id: 'n1', x: 0, y: 0, width: 100, height: 40, text: 'hi' })
  return { ...canvas, nodes: [...canvas.nodes, added] }
}

function editing(doc: ReplicaRecord | undefined, selected: WorkspaceDocumentEntry | undefined) {
  const scheduleSave = vi.fn<(record: ReplicaRecord) => void>()
  const hook = renderHook(() => useReplicaEditing({ record: doc, selected, scheduleSave }))
  return { scheduleSave, result: hook.result }
}

describe('useReplicaEditing', () => {
  it("never offers one note's draft to another note when the selection switches", () => {
    // The editor is keyed by document: one handed the previous note's body
    // mounts with it, then reconciles to its own, and that reconcile reads as
    // an edit — a save of a record nobody changed.
    const doc = record()
    const scheduleSave = vi.fn<(record: ReplicaRecord) => void>()
    const offered: [string | undefined, string | null][] = []
    const hook = renderHook(
      ({ selected }: { selected: WorkspaceDocumentEntry }) => {
        const result = useReplicaEditing({ record: doc, selected, scheduleSave })
        offered.push([selected.documentId, result.draft])
        return result
      },
      { initialProps: { selected: entry(doc, MD) } },
    )
    expect(hook.result.current.draft).toBe('# Plan')

    hook.rerender({ selected: entry(doc, MD2) })

    expect(hook.result.current.draft).toBe('# Log')
    expect(offered.filter(([id, draft]) => id === MD2 && draft === '# Plan')).toEqual([])
    expect(scheduleSave).not.toHaveBeenCalled()
  })

  it('writes a canvas change into the record and queues its save', () => {
    const doc = record()
    const { scheduleSave, result } = editing(doc, entry(doc, SP))
    const next = withNode(readSpatialCanvas(documentContainers(doc, SP)))

    act(() => result.current.onSpatialChange(next))

    expect(readSpatialCanvas(documentContainers(doc, SP)).nodes.map((n) => n.id)).toEqual(['n1'])
    expect(result.current.spatialDraft).toBe(next)
    expect(scheduleSave).toHaveBeenCalledWith(doc)
  })

  it('diffs a second canvas change against the first, so removing an added node removes it', () => {
    const doc = record()
    const { result } = editing(doc, entry(doc, SP))
    const loaded = readSpatialCanvas(documentContainers(doc, SP))

    act(() => result.current.onSpatialChange(withNode(loaded)))
    act(() => result.current.onSpatialChange(loaded))

    expect(readSpatialCanvas(documentContainers(doc, SP)).nodes).toEqual([])
  })

  it('ignores a canvas change while a markdown document is selected', () => {
    const doc = record()
    const { scheduleSave, result } = editing(doc, entry(doc, MD))
    const next = withNode(readSpatialCanvas(documentContainers(doc, SP)))

    act(() => result.current.onSpatialChange(next))

    expect(readSpatialCanvas(documentContainers(doc, SP)).nodes).toEqual([])
    expect(result.current.spatialDraft).toBeNull()
    expect(scheduleSave).not.toHaveBeenCalled()
  })

  it('ignores a canvas change and a lock toggle with no record or no selection', () => {
    const doc = record()
    const next = withNode(readSpatialCanvas(documentContainers(doc, SP)))
    for (const [held, selected] of [
      [undefined, entry(doc, SP)],
      [doc, undefined],
    ] as const) {
      const { scheduleSave, result } = editing(held, selected)
      act(() => {
        result.current.onSpatialChange(next)
        result.current.spatialLocks.onToggleNodeLock('n1', true)
      })
      expect(scheduleSave).not.toHaveBeenCalled()
      expect(result.current.spatialLocks.lockedNodeIds.size).toBe(0)
    }
    expect(readSpatialCanvas(documentContainers(doc, SP)).nodes).toEqual([])
    expect([...readNodeLocks(documentContainers(doc, SP))]).toEqual([])
  })

  it('writes a node lock into the record, shows it as held, and queues its save', () => {
    const doc = record()
    const { scheduleSave, result } = editing(doc, entry(doc, SP))

    act(() => result.current.spatialLocks.onToggleNodeLock('n1', true))

    expect([...readNodeLocks(documentContainers(doc, SP))]).toEqual(['n1'])
    expect([...result.current.spatialLocks.lockedNodeIds]).toEqual(['n1'])
    expect(scheduleSave).toHaveBeenCalledWith(doc)

    act(() => result.current.spatialLocks.onToggleNodeLock('n1', false))

    expect([...readNodeLocks(documentContainers(doc, SP))]).toEqual([])
    expect(result.current.spatialLocks.lockedNodeIds.size).toBe(0)
    expect(scheduleSave).toHaveBeenCalledTimes(2)
  })

  it('writes an edge lock into the record, shows it as held, and queues its save', () => {
    const doc = record()
    const { scheduleSave, result } = editing(doc, entry(doc, SP))

    act(() => result.current.spatialLocks.onToggleEdgeLock('e1', true))

    expect([...readEdgeLocks(documentContainers(doc, SP))]).toEqual(['e1'])
    expect([...result.current.spatialLocks.lockedEdgeIds]).toEqual(['e1'])
    expect(result.current.spatialLocks.lockedNodeIds.size).toBe(0)
    expect(scheduleSave).toHaveBeenCalledWith(doc)
  })
})
