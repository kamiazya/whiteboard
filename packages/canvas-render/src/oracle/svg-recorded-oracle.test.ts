import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  decodeLines,
  encodeLines,
  type SvgRecord,
  svgAnswer,
  svgInputs,
} from '../test-utils/render-oracle/oracle.js'

/**
 * The committed recording of what the SVG backend alone answers for a scene
 * (`renderSceneToSvg` and `renderSceneToKeyedSvg`, over the envelope options a
 * caller may pass) equals what the TypeScript answers today. The Rust SVG
 * backend (ADR-0054 slice S2) replays it natively and is held to it byte for
 * byte; the Rust replay test arrives with that slice, not here.
 *
 * The scenes are the pixel and determinism goldens and the scenes the render
 * recording lays out, held as JSON inputs, so this test draws nothing and
 * reads no corpus. Re-record after a deliberate backend change with
 * `WHITEBOARD_RECORD_ORACLE=1 pnpm vitest run --project canvas-render-node recorded-oracle`.
 */
const FILE = new URL('./svg.jsonl', import.meta.url)

if (process.env.WHITEBOARD_RECORD_ORACLE === '1') {
  writeFileSync(FILE, encodeLines(svgInputs().map(svgAnswer)))
}

describe('the recorded SVG backend oracle', () => {
  const text = readFileSync(FILE, 'utf8')
  const recorded = decodeLines<SvgRecord>(text)

  it('reaches the goldens, the laid-out scenes and every envelope option', () => {
    const under = (prefix: string) => recorded.filter((r) => r.id.startsWith(prefix)).length
    expect(under('golden/'), 'determinism goldens').toBeGreaterThan(6)
    expect(under('pixel/'), 'pixel goldens').toBeGreaterThan(30)
    expect(under('layout/'), 'laid-out scenes').toBeGreaterThan(100)
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
