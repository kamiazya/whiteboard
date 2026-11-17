import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { decodeLines, type RenderRecord, renderAnswer } from '../test-utils/render-oracle/oracle.js'

/**
 * The committed recording of what `layoutSpatialCanvas` and the SVG renderers
 * answered for a canvas — the scene (every field, every number as its 64 IEEE
 * bits), the SVG, the keyed groups and the scene digest — taken from the
 * TypeScript composer before it was deleted (ADR-0054 step 7, S18h) and
 * frozen: the layout is now the Rust core's, so a re-recording would be the
 * core judging itself. Each line is laid out again through canvas-render's
 * entry over the real core, and drawn and digested again by the TypeScript
 * SVG backend and digest, which are still this package's. A change that
 * moves an answer must say so by editing the recording.
 */
const FILE = new URL('./render.jsonl', import.meta.url)

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

  it('equals what the core lays out and the backend draws today', { timeout: 120_000 }, () => {
    const lines = text.trimEnd().split('\n')
    const parted = recorded.findIndex(
      (r, i) =>
        JSON.stringify(renderAnswer({ id: r.id, canvas: r.canvas, options: r.options })) !==
        lines[i],
    )
    expect(
      recorded[parted]?.id,
      'the first recorded case no longer answered as recorded',
    ).toBeUndefined()
  })
})
