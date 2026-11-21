/**
 * What a restore tells the document-written observer, which schedules the
 * document's checkpoint and compaction. Recorded as it stands: an identical
 * restore still announces, and a document a restore creates never does.
 */
import { describe, expect, it } from 'vitest'
import { FakeLive, run, spatialDoc, versionsWith } from '../test-utils/restore-fakes.js'

describe('what a restore announces', () => {
  it('announces a restore in place that moved the content', async () => {
    const live = new FakeLive()
    live.seed('canvas-a', spatialDoc(['n1', 'gone']))
    await run(live, versionsWith({ v1: { doc: spatialDoc(['n1']) } }))
    expect(live.written).toEqual(['canvas-a'])
  })

  it('announces a restore in place that moved nothing', async () => {
    const live = new FakeLive()
    live.seed('canvas-a', spatialDoc(['n1']))
    await run(live, versionsWith({ v1: { doc: spatialDoc(['n1']) } }))
    expect(live.written).toEqual(['canvas-a'])
  })

  it('announces nothing for the new document a restore into a fresh target creates', async () => {
    const live = new FakeLive()
    live.seed('canvas-a', spatialDoc(['n1']))
    await run(live, versionsWith({ v1: { doc: spatialDoc(['n1', 'n2']) } }), {
      targetPath: 'canvas-new',
    })
    expect(live.written).toEqual([])
    expect(live.paths()).toContain('canvas-new')
  })
})
