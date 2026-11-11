import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  decodeLines,
  encodeLines,
  type RenderRecord,
  renderAnswer,
  renderInputs,
} from '../test-utils/render-oracle/oracle.js'

/**
 * The committed recording of what `layoutSpatialCanvas` and the SVG renderers
 * answer for a canvas — the scene (every field, every number as its 64 IEEE
 * bits), the SVG, the keyed groups and the scene digest — equals what the
 * TypeScript answers today. The Rust composer (ADR-0054 slice S13) replays it
 * natively and is held to it byte for byte; a recording left behind a
 * TypeScript change would hold it to an answer nobody gives. The Rust replay
 * tests arrive with those slices, not here.
 *
 * The recording holds its inputs as well as its answers, so this test draws
 * nothing and reads no corpus. Re-record after a deliberate rendering change
 * with
 * `WHITEBOARD_RECORD_ORACLE=1 pnpm vitest run --project canvas-render-node recorded-oracle`.
 */
const FILE = new URL('./render.jsonl', import.meta.url)

if (process.env.WHITEBOARD_RECORD_ORACLE === '1') {
  writeFileSync(FILE, encodeLines(renderInputs().map(renderAnswer)))
}

describe('the recorded render oracle', () => {
  const text = readFileSync(FILE, 'utf8')
  const recorded = decodeLines<RenderRecord>(text)

  it('reaches the corpora, the generated canvases and the scene kinds the composer draws', () => {
    const under = (prefix: string) => recorded.filter((r) => r.id.startsWith(prefix)).length
    expect(under('routing/'), 'routing layouts').toBeGreaterThan(20)
    expect(under('drawing/'), 'drawings').toBeGreaterThan(8)
    expect(under('wrapping/'), 'wrapped texts').toBeGreaterThan(30)
    expect(under('body/'), 'markdown bodies').toBeGreaterThan(4)
    expect(under('generated/'), 'generated canvases').toBeGreaterThan(40)
    const scenes = recorded.map((r) => r.scene).join('\n')
    for (const kind of [
      'edge',
      'shape',
      'textRun',
      'paragraph',
      'codeBlock',
      'blockquote',
      'table',
      'thematicBreak',
      'rawHtml',
      'list',
    ]) {
      expect(scenes.includes(`"kind":"${kind}"`), `a scene holding a ${kind}`).toBe(true)
    }
    expect(new Set(recorded.map((r) => r.options.mode)).size, 'modes').toBe(2)
  })

  it('equals what the TypeScript answers today', () => {
    const lines = text.trimEnd().split('\n')
    const parted = recorded.findIndex(
      (r, i) =>
        JSON.stringify(renderAnswer({ id: r.id, canvas: r.canvas, options: r.options })) !==
        lines[i],
    )
    expect(
      recorded[parted]?.id,
      'the first recorded case the TypeScript no longer answers as recorded',
    ).toBeUndefined()
  })
})
