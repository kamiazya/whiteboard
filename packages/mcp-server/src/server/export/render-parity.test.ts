// `wb_scene_render` and the PNG/SVG exporter are two producers of the same
// drawing, in the same process, and they used to measure text differently:
// the tool with a constant-ratio estimate, the exporter with opentype.js
// glyph metrics. Same canvas, different wrap points — so the SVG an agent
// read back was not the picture a user exported. `ServerDeps.measure` is
// what closed that, and this is the test that keeps it closed.
import { writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import { chunkSnapshot } from '@kamiazya/whiteboard-ports'
import { createCanvasRenderSvgTool } from '@kamiazya/whiteboard-server-core'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { createContainer, resolveServerDeps } from '../../di/container.js'
import { renderSpatialCanvasToSvg } from './headless-renderer.js'

const DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'

// Glyph-width sensitive on purpose: a constant-ratio measurer cannot tell
// 'MMMM' from 'iiii', so a canvas built only from average-width text would
// let the two producers agree by accident.
const canvas = {
  nodes: [
    {
      id: 'n1',
      type: 'text' as const,
      x: 0,
      y: 0,
      width: 240,
      height: 200,
      text: 'Wide MMMM MMMM MMMM versus narrow iiii iiii iiii - where does this wrap?',
    },
    // A Latin-only fixture cannot see the failure that matters most here: the
    // estimator and a `.notdef`-returning font AGREE with each other on CJK,
    // both at a fraction of the true width, so parity holds while the picture
    // is wrong. This node wraps only if the kana are measured at a full em.
    {
      id: 'n2',
      type: 'text' as const,
      x: 0,
      y: 240,
      width: 200,
      height: 200,
      text: 'これは日本語のテキストです。ノードの幅を超えたときにどこで折り返すのか、全角を全角として測っているかどうかで答えが変わります。',
    },
  ],
  edges: [],
}

/** Every painted text run as `text @ x,y` — the wrap points, in order. */
function textRuns(svg: string): string[] {
  return [...svg.matchAll(/<text[^>]*x="([-\d.]+)"[^>]*y="([-\d.]+)"[^>]*>([^<]*)</g)].map(
    (m) => `${m[3]} @ ${m[1]},${m[2]}`,
  )
}

describe('wb_scene_render / export parity', () => {
  it('wraps text at the same points as the exporter, because both measure with the real font', async () => {
    const deps = resolveServerDeps(createContainer())
    const doc = new LoroDoc()
    writeSpatialCanvas(doc, canvas)
    const snapshot = chunkSnapshot(doc.export({ mode: 'snapshot' }), 1 << 20)
    await deps.documentStore.saveSnapshot({
      docRef: { kind: 'document', documentId: DOCUMENT_ID },
      manifest: snapshot.manifest,
      chunks: snapshot.chunks,
      frontier: new Uint8Array(),
    })

    const viaTool = await createCanvasRenderSvgTool(deps).execute({
      workspaceId: 'ws-1',
      documentId: DOCUMENT_ID,
      embedReferences: false,
    })
    const viaExport = await renderSpatialCanvasToSvg(canvas, { theme: 'light' })

    // The envelopes differ by design (the exporter adds padding and a
    // background); the drawing inside them must not.
    expect(textRuns(viaTool.svg)).toEqual(textRuns(viaExport.svg))
    expect(textRuns(viaTool.svg).length).toBeGreaterThan(1)

    // Parity alone would be satisfied by both sides measuring kana as
    // `.notdef` (~0.44 em) and agreeing on a picture that is wrong. The
    // threshold is what separates the two models rather than a pinned count:
    // 60 fullwidth characters in a ~184px content box need 6 lines at a full
    // em and fit in 3 at `.notdef`, so anything at or above 4 can only come
    // from measuring them at their real width.
    const japanese = textRuns(viaTool.svg).filter((run) => /[\u3040-\u30ff]/.test(run))
    expect(japanese.length).toBeGreaterThanOrEqual(4)
  })
})
