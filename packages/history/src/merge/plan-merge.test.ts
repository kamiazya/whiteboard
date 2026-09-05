import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  projectWorkspaceDocument,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { frontiersToBase64 } from '../frontiers-base64.js'
import { makeSpatialDoc } from '../test-utils/spatial-doc.js'
import { planMerge, UnreadableBranchTipError } from './plan-merge.js'

const DOC_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

function node(id: string, text: string): SpatialCanvas['nodes'][number] {
  return { id, type: 'text', text, x: 0, y: 0, width: 80, height: 40 }
}

/**
 * A workspace record holding one document, edited in two steps so the two
 * frontiers stand for two tips: `base` after the first write, `tip` after
 * the second.
 */
function recordWithTwoPoints(first: SpatialCanvas, second: SpatialCanvas) {
  const record = new LoroDoc()
  createWorkspaceDocumentAtPath(record, { path: 'a', documentId: DOC_ID, kind: 'spatial' })
  writeSpatialCanvas(documentContainers(record, DOC_ID), first)
  record.commit()
  const base = frontiersToBase64(record.oplogFrontiers())
  writeSpatialCanvas(documentContainers(record, DOC_ID), second)
  record.commit()
  const tip = frontiersToBase64(record.oplogFrontiers())
  const clone = LoroDoc.fromSnapshot(record.export({ mode: 'snapshot' }))
  return { record, clone, base, tip }
}

describe('planMerge', () => {
  it('projects both tips off the record, previews the source, and lists what arrives', () => {
    const { clone, base, tip } = recordWithTwoPoints(
      { nodes: [node('a', 'one')], edges: [] },
      { nodes: [node('a', 'one'), node('b', 'two')], edges: [] },
    )
    const liveDoc = projectWorkspaceDocument(clone, DOC_ID) ?? new LoroDoc()
    const plan = planMerge({
      workspaceRecord: clone,
      documentId: DOC_ID,
      liveDoc,
      into: { name: 'main', tipFrontiers: base },
      source: { name: 'idea', tipFrontiers: tip },
    })
    expect(plan.targetElementCount).toBe(1)
    expect(plan.sourceElementCount).toBe(2)
    expect(plan.previewElementCount).toBe(plan.previewElements.length)
    expect(plan.newElementIds).toEqual(['b'])
    expect(plan.changedElementIds).toEqual([])
    // Genesis of the record is the ancestor of a straight line, so nothing is
    // resurrected or in conflict.
    expect(plan.badges).toEqual([])
    expect(plan.conflictElementIds).toEqual([])
  })

  it('does not move the record it planned over', () => {
    const { clone, base, tip } = recordWithTwoPoints(
      { nodes: [node('a', 'one')], edges: [] },
      { nodes: [node('a', 'one'), node('b', 'two')], edges: [] },
    )
    const before = frontiersToBase64(clone.oplogFrontiers())
    planMerge({
      workspaceRecord: clone,
      documentId: DOC_ID,
      liveDoc: new LoroDoc(),
      into: { name: 'main', tipFrontiers: base },
      source: { name: 'idea', tipFrontiers: tip },
    })
    expect(frontiersToBase64(clone.oplogFrontiers())).toBe(before)
    expect(projectWorkspaceDocument(clone, DOC_ID)).not.toBeNull()
  })

  it('reads an empty tip as the live document, off the record too', () => {
    const live = makeSpatialDoc({ nodes: [node('a', 'live')], edges: [] })
    const plan = planMerge({
      workspaceRecord: null,
      documentId: null,
      liveDoc: live,
      into: { name: 'main', tipFrontiers: '' },
      source: { name: 'idea', tipFrontiers: '' },
    })
    expect(plan.targetElementCount).toBe(1)
    expect(plan.newElementIds).toEqual([])
    expect(plan.changedElementIds).toEqual([])
  })

  it('names the branch whose tip cannot be read, as corruption rather than a failed merge', () => {
    const { clone, base } = recordWithTwoPoints(
      { nodes: [node('a', 'one')], edges: [] },
      { nodes: [node('a', 'two')], edges: [] },
    )
    expect(() =>
      planMerge({
        workspaceRecord: clone,
        documentId: DOC_ID,
        liveDoc: new LoroDoc(),
        into: { name: 'main', tipFrontiers: base },
        source: { name: 'idea', tipFrontiers: '!!!not-base64!!!' },
      }),
    ).toThrow(UnreadableBranchTipError)
    try {
      planMerge({
        workspaceRecord: clone,
        documentId: DOC_ID,
        liveDoc: new LoroDoc(),
        into: { name: 'main', tipFrontiers: base },
        source: { name: 'idea', tipFrontiers: '!!!not-base64!!!' },
      })
    } catch (err) {
      expect((err as UnreadableBranchTipError).branchLabel).toBe('idea')
    }
  })
})
