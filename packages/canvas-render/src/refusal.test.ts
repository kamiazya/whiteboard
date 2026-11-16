import type { Scene, ShapeSceneNode, TextRunNode } from '@kamiazya/whiteboard-scene'
import { describe, expect, it } from 'vitest'
import { type LayoutRefusal, refusalCopy, refusalScene } from './refusal.js'
import { renderSceneToSvg } from './svg/backend.js'
import { createFakeMeasure } from './test-utils/fake-measure.js'
import { SPATIAL_DARK_PALETTE, SPATIAL_LIGHT_PALETTE } from './theme/spatial-palette.js'

const measure = createFakeMeasure()

/** Every class the core refuses a layout with, each owed words of its own. */
const REFUSAL_REASONS = [
  'too-many-elements',
  'referenced-elements',
  'bodies',
  'too-large',
  'comments',
  'proposals',
  'fragments',
  'non-finite',
  'host-measure',
] as const

const runs = (scene: Scene) =>
  scene.nodes.filter((node): node is TextRunNode => node.kind === 'textRun')
const frame = (scene: Scene) =>
  scene.nodes.find((node): node is ShapeSceneNode => node.kind === 'shape')
const text = (scene: Scene) =>
  runs(scene)
    .map((run) => run.text)
    .join(' ')

describe('refusalCopy', () => {
  it('names what happened and what the reader can do, per reason the core refuses with', () => {
    for (const reason of REFUSAL_REASONS) {
      const code =
        reason === 'non-finite' || reason === 'host-measure' ? 'malformed' : 'input-too-large'
      const { title, detail } = refusalCopy({ code, reason })
      expect(title.length, reason).toBeGreaterThan(0)
      // A sentence that says what was refused, then one that says what to do.
      expect(detail.split('. ').length, `${reason}: ${detail}`).toBeGreaterThanOrEqual(2)
      expect(detail, reason).toMatch(/\.$/)
      // No internal vocabulary reaches a reader.
      expect(`${title} ${detail}`, reason).not.toMatch(/core|wasm|rust|layout|refus|cap\b/i)
    }
    const distinct = new Set(
      REFUSAL_REASONS.map((reason) => refusalCopy({ code: 'input-too-large', reason }).detail),
    )
    expect(distinct.size).toBe(REFUSAL_REASONS.length)
  })

  it('answers a reason it has no words for with the general one, not with the reason', () => {
    const unknown = refusalCopy({ code: 'input-too-large', reason: 'font-families' })
    expect(unknown.detail).not.toContain('font-families')
    expect(unknown).toEqual(refusalCopy({ code: 'input-too-large', reason: 'not-a-reason' }))
    const malformed = refusalCopy({ code: 'malformed', reason: 'not-a-reason' })
    expect(malformed.title).not.toBe(unknown.title)
  })
})

describe('refusalScene', () => {
  const tooMany: LayoutRefusal = { code: 'input-too-large', reason: 'too-many-elements' }

  it('draws one box holding the title and the detail, wrapped inside it', () => {
    const scene = refusalScene(tooMany, { measure, mode: 'light' })
    const box = frame(scene)
    expect(box?.bbox).toMatchObject({ x: 0, y: 0 })
    const { title, detail } = refusalCopy(tooMany)
    expect(text(scene)).toBe(`${title} ${detail}`)
    expect(runs(scene).length).toBeGreaterThan(2)
    for (const run of runs(scene)) {
      expect(run.bbox.x, run.text).toBeGreaterThan(box?.bbox.x ?? 0)
      expect(run.bbox.x + run.bbox.w, run.text).toBeLessThan(
        (box?.bbox.x ?? 0) + (box?.bbox.w ?? 0),
      )
      expect(run.bbox.y + run.bbox.h, run.text).toBeLessThan(
        (box?.bbox.y ?? 0) + (box?.bbox.h ?? 0),
      )
    }
    expect(runs(scene)[0]?.strong).toBe(true)
    // The SVG backend draws it, as every other scene.
    expect(renderSceneToSvg(scene)).toContain(title)
  })

  it('fits the width it is given, and keeps to its own when given none or more', () => {
    const widthOf = (maxWidth?: number) =>
      frame(
        refusalScene(tooMany, {
          measure,
          mode: 'light',
          ...(maxWidth === undefined ? {} : { maxWidth }),
        }),
      )?.bbox.w
    expect(widthOf()).toBe(480)
    expect(widthOf(2000)).toBe(480)
    expect(widthOf(300)).toBe(300)
    const narrow = refusalScene(tooMany, { measure, mode: 'light', maxWidth: 300 })
    expect(runs(narrow).length).toBeGreaterThan(
      runs(refusalScene(tooMany, { measure, mode: 'light' })).length,
    )
  })

  it('is drawn at the point it is given, every run moved with its box', () => {
    const atOrigin = refusalScene(tooMany, { measure, mode: 'light' })
    const moved = refusalScene(tooMany, { measure, mode: 'light', at: { x: 5000, y: -40 } })
    expect(frame(moved)?.bbox).toMatchObject({ x: 5000, y: -40 })
    const shifted = runs(atOrigin).map((run) => ({
      ...run.bbox,
      x: run.bbox.x + 5000,
      y: run.bbox.y - 40,
    }))
    expect(runs(moved).map((run) => run.bbox)).toEqual(shifted)
  })

  it('is painted from the palette of the mode it is drawn in', () => {
    const light = frame(refusalScene(tooMany, { measure, mode: 'light' }))
    const dark = frame(refusalScene(tooMany, { measure, mode: 'dark' }))
    expect(light?.appearance?.fill).toBe(SPATIAL_LIGHT_PALETTE.node.file.fill)
    expect(dark?.appearance?.fill).toBe(SPATIAL_DARK_PALETTE.node.file.fill)
    const labels = (mode: 'light' | 'dark') =>
      new Set(runs(refusalScene(tooMany, { measure, mode })).map((run) => run.appearance?.fill))
    expect(labels('light')).toEqual(new Set([SPATIAL_LIGHT_PALETTE.labelFill]))
    expect(labels('dark')).toEqual(new Set([SPATIAL_DARK_PALETTE.labelFill]))
  })
})
