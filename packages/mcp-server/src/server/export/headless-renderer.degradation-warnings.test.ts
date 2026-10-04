import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { captureLogsForTests } from '../log.js'
import { renderSpatialCanvasToSvg } from './headless-renderer.js'
import { NO_INSTALLED_FONTS } from './test-utils/no-installed-fonts.js'

// headless-renderer.ts documents both reports as "a silent degradation that diverges visually is worth a
// record" (`reportUnresolvedFamilies`, `reportUndrawable`). The suite asserts the RETURNED lists but never
// that the record is written, so deleting either `log.warning` leaves the export silently wrong in the log.
const one = (text: string, over = {}): SpatialCanvas => ({
  nodes: [textNode({ id: 'n1', x: 0, y: 0, width: 320, height: 200, text, ...over })],
  edges: [],
})

async function warningsFor(canvas: SpatialCanvas) {
  const capture = captureLogsForTests('warning')
  try {
    await renderSpatialCanvasToSvg(canvas, NO_INSTALLED_FONTS)
    return capture.records.filter((r) => r.level === 'warning')
  } finally {
    capture.restore()
  }
}

describe('an export that degrades says so in the log', () => {
  it('names the declared families no loaded face provides', async () => {
    const records = await warningsFor(one('```ts\nconst x = 1\n```'))
    const record = records.find((r) => r.msg.includes('no loaded face provides'))
    expect(record).toBeDefined()
    expect(String((record?.data?.families as string[] | undefined)?.join(' '))).toContain(
      'ui-monospace',
    )
  })

  it('counts and names the characters no loaded font can draw', async () => {
    const records = await warningsFor(one('こんにちは'))
    const record = records.find((r) => r.msg.includes('no glyph for some characters'))
    expect(record).toBeDefined()
    expect(record?.data?.count).toBe(5)
    expect(record?.data?.characters).toBe('こんにちは')
  })

  it('is quiet for a canvas it can draw whole', async () => {
    expect(await warningsFor(one('plain prose'))).toEqual([])
  })
})
