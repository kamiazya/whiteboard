/**
 * What opening the files panel costs the browser keeper, against real
 * IndexedDB: `listDocuments` as the workspace grows.
 *
 * An INSTRUMENT before it is a guard: it prints the readings so a change to
 * how the list derives its tags is judged by numbers rather than argument, and
 * asserts a budget only where the budget holds. The cold call is a listing
 * with nothing remembered; the repeat is the same listing over unchanged
 * documents.
 *
 * The sizes stop at 100 because the cold listing does not scale to the
 * desktop capacity (`DESKTOP_CAPACITY.limit`, 2000): every document it reads
 * reopens the whole workspace record, so the cost per document itself grows
 * with the workspace. A ladder to 2000 did not finish inside ten minutes.
 */
import { writeCoreFacets, writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { Loro } from 'loro-crdt'
import { beforeEach, expect, it } from 'vitest'
import { getBrowserWorkspaceId } from '../../lib/browser-workspace-id.js'
import { FoldingBrowserIndex } from '../../lib/folding-browser-index.js'
import { ensureLocalWorkspace } from '../../lib/local-document-summary.js'
import { createLocalFilesSource } from '../../lib/local-files-source.js'
import { seedWorkspaceDocumentContent } from '../../lib/workspace-content.js'
import { clearWhiteboardDb } from '../../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../../test-utils/isolated-whiteboard-db.js'

claimIsolatedWhiteboardDb('local-list-documents-timing')

const SIZES = [25, 50, 100] as const

const noteDoc = (n: number): Loro => {
  const doc = new Loro()
  writeCoreFacets(doc, { type: 'note', tags: [`team:t${n % 7}`, 'q3'] })
  return doc
}

const boardDoc = (n: number): Loro => {
  const doc = new Loro()
  writeSpatialCanvas(doc, {
    tags: [`team:t${n % 7}`],
    nodes: [
      textNode({ id: 'a', x: 0, y: 0, width: 100, height: 50, text: 'a', tags: ['health:ok'] }),
      textNode({ id: 'b', x: 200, y: 0, width: 100, height: 50, text: 'b' }),
    ],
    edges: [{ id: 'e', from: { node: 'a' }, to: { node: 'b' }, tags: ['link:slow'] }],
  })
  return doc
}

// Before EACH, not once: a stress run repeats the test in one process, and a
// second run over the seeded workspace would refuse every path as taken.
beforeEach(clearWhiteboardDb)

it('prints what listDocuments costs as the workspace grows', { timeout: 600_000 }, async () => {
  const index = new FoldingBrowserIndex()
  await ensureLocalWorkspace(index)
  const workspaceId = getBrowserWorkspaceId()
  const readings: Record<number, { coldMs: number; repeatMs: number }> = {}
  let seeded = 0

  for (const size of SIZES) {
    for (; seeded < size; seeded += 1) {
      // One board in ten, so both kinds' walks are inside the reading.
      const spatial = seeded % 10 === 0
      const entry = await index.createDocument({
        workspaceId,
        path: `docs/d${seeded}`,
        kind: spatial ? 'spatial' : 'markdown',
      })
      const doc = spatial ? boardDoc(seeded) : noteDoc(seeded)
      await seedWorkspaceDocumentContent(entry.documentId, doc.export({ mode: 'snapshot' }))
    }

    const source = createLocalFilesSource({ index })
    const startedCold = performance.now()
    const listed = await source.listDocuments()
    const coldMs = Math.round(performance.now() - startedCold)
    expect(listed).toHaveLength(size)
    const startedRepeat = performance.now()
    await source.listDocuments()
    readings[size] = { coldMs, repeatMs: Math.round(performance.now() - startedRepeat) }
  }

  console.info(`listDocuments, ms: ${JSON.stringify(readings)}`)

  // Budgets only where they hold. A workspace of 25 lists in well under the
  // ceiling whatever the machine, and a repeat over unchanged documents reads
  // none of them, so it costs a fraction of a cold list however many there are.
  expect(readings[25]?.coldMs).toBeLessThan(10_000)
  expect(readings[100]?.repeatMs).toBeLessThan(1000)
})
