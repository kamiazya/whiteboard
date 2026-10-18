/**
 * An update whose changes build on a change the keeper does not hold.
 *
 * Loro parks such changes as PENDING, outside the oplog, so nothing the judge
 * reads of the import — the operations from the old version to the new one —
 * includes them, and every bound reads clean. They stay in the document and
 * apply, unjudged, the moment a later import supplies what they build on.
 */
import { LABEL_MAX_CHARS, MARKDOWN_MAX_CHARS } from '@kamiazya/whiteboard-model'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { importWithinTextLimits, syncTextLimitJudge } from './sync-text-limits.js'
import { createWorkspaceDocumentAtPath, documentContainers } from './workspace-tree.js'

const DOC_ID = '01BRWAAAAAAAAAAAAAAAAAAAA0'

function record(): LoroDoc {
  const doc = new LoroDoc()
  createWorkspaceDocumentAtPath(doc, { path: 'notes', documentId: DOC_ID, kind: 'markdown' })
  documentContainers(doc, DOC_ID).getText('body').insert(0, 'short')
  doc.commit()
  return doc
}

/**
 * Two changes by one client: an edit within every bound, and a run past the
 * limit built on it. The keeper is sent the second alone. The first is
 * longer than any value bound, so a judge cannot answer it without importing
 * it into its copy.
 */
function gappedUpdates(base: LoroDoc): { readonly gap: Uint8Array; readonly gapped: Uint8Array } {
  const client = base.fork()
  const from = client.oplogVersion()
  const body = documentContainers(client, DOC_ID).getText('body')
  body.insert(0, 'a'.repeat(LABEL_MAX_CHARS * 4))
  client.commit()
  const gap = client.export({ mode: 'update', from })
  const between = client.oplogVersion()
  body.insert(0, 'x'.repeat(MARKDOWN_MAX_CHARS + 1))
  client.commit()
  return { gap, gapped: client.export({ mode: 'update', from: between }) }
}

describe('an update that builds on a change the keeper does not hold', () => {
  it('is reported as pending rather than judged clean', () => {
    const keeper = record()
    const { gapped } = gappedUpdates(keeper)

    expect(importWithinTextLimits(keeper, gapped)).toMatchObject({ breach: null, pending: true })
  })

  it('an update holding everything it builds on is not pending', () => {
    const keeper = record()
    const { gap } = gappedUpdates(keeper)

    expect(importWithinTextLimits(keeper, gap)).toMatchObject({ breach: null, pending: false })
  })

  it('leaves the judge copy as it was, so the change it builds on is judged alone', () => {
    const keeper = record()
    const { gap, gapped } = gappedUpdates(keeper)
    const judge = syncTextLimitJudge(keeper)

    judge(gapped)

    // Kept, the copy would apply the parked run as this small edit fills
    // the gap, and refuse the edit for a run it never carried.
    expect(judge(gap)).toBeNull()
  })
})
