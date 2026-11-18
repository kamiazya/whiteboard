import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { decodeLines, type SvgRecord, svgAnswer } from '../test-utils/render-oracle/oracle.js'

/**
 * The committed recording of what the SVG backend alone answered for a scene
 * (`renderSceneToSvg` and `renderSceneToKeyedSvg`, over the envelope options a
 * caller may pass). The Rust SVG backend replays it natively and on wasm32
 * (`crates/core/canvas-render/tests/svg_oracle.rs`) and is held to it byte for
 * byte.
 *
 * The scenes are the pixel and determinism goldens, the pixel goldens as the
 * browser screenshots them (`pixel-mount/`), and the scenes the render
 * recording laid out when it was taken. It is FROZEN: the laid-out scenes are
 * recorded inputs now, not what today's layout draws, so nothing re-records
 * it (ADR-0054 A3.6).
 */
const FILE = new URL('./svg.jsonl', import.meta.url)

describe('the recorded SVG backend oracle', () => {
  const text = readFileSync(FILE, 'utf8')
  const recorded = decodeLines<SvgRecord>(text)

  it('reaches the goldens, the laid-out scenes and every envelope option', () => {
    const under = (prefix: string) => recorded.filter((r) => r.id.startsWith(prefix)).length
    expect(under('golden/'), 'determinism goldens').toBeGreaterThan(6)
    expect(under('pixel/'), 'pixel goldens').toBeGreaterThan(30)
    expect(under('layout/'), 'laid-out scenes').toBeGreaterThan(100)
    expect(under('pixel-mount/'), 'pixel goldens as mounted').toBe(8)
    expect(recorded.filter((r) => r.id.startsWith('golden/every-kind')).length, 'every kind').toBe(
      4,
    )
    for (const option of ['padding', 'background', 'width', 'textFill', 'viewBox', 'legend']) {
      expect(
        recorded.filter((r) => r.options !== null && option in r.options).length,
        `scenes drawn with ${option}`,
      ).toBeGreaterThan(5)
    }
  })

  it('equals what the TypeScript answers today', () => {
    const lines = text.trimEnd().split('\n')
    const parted = recorded.findIndex(
      (r, i) =>
        JSON.stringify(svgAnswer({ id: r.id, scene: r.scene, options: r.options })) !== lines[i],
    )
    expect(
      recorded[parted]?.id,
      'the first recorded scene the TypeScript no longer draws as recorded',
    ).toBeUndefined()
  })
})
