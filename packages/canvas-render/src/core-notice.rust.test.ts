import type { Scene } from '@kamiazya/whiteboard-scene'
import { describe, expect, it } from 'vitest'
import type { CoreSvgAsk } from './canvas-core.js'
import { layoutNoticeKeyedPicture, layoutNoticePicture } from './core-picture.js'
import { constantRatioMeasureText, type MeasureText } from './measure.js'
import { type LayoutRefusal, refusalCopy, refusalScene } from './refusal.js'
import { sceneBounds } from './scene-bounds.js'
import { renderSceneToSvg } from './svg/backend.js'
import { renderSceneToKeyedSvg } from './svg/keyed.js'
import { createFakeMeasure } from './test-utils/fake-measure.js'
import { built } from './test-utils/wasm/glue.js'
import { oracleLayoutCore } from './test-utils/wasm/oracle-layout-core.js'

// The core draws the notice a refused layout is shown as; the words stay
// `refusalCopy`'s. Each case below is held to what `refusalScene` draws and
// `renderSceneToSvg` serializes, the picture every surface drew before the
// core did.

const WORDED = [
  'too-many-elements',
  'referenced-elements',
  'bodies',
  'too-large',
  'comments',
  'proposals',
  'fragments',
  'non-finite',
  'host-measure',
  'core-unavailable',
] as const

const REFUSALS: readonly LayoutRefusal[] = [
  ...WORDED.map((reason): LayoutRefusal => ({ code: 'malformed', reason })),
  { code: 'input-too-large', reason: 'no-words-of-its-own' },
  { code: 'malformed', reason: 'no-words-of-its-own' },
]

const WIDTHS = [undefined, 480, 300, 120, 40] as const
const POINTS = [undefined, { x: 0, y: 0 }, { x: 37.5, y: -12 }] as const
const MODES = ['light', 'dark'] as const

/** The scene `refusalScene` draws, less the refusal it attaches and the core has no use for. */
function drawnByTypeScript(
  refusal: LayoutRefusal,
  options: Parameters<typeof refusalScene>[1],
): Scene {
  const { refusal: _attached, ...scene } = refusalScene(refusal, options)
  return scene
}

const ENVELOPES: readonly (readonly [string, CoreSvgAsk])[] = [
  ['padding', { padding: 12 }],
  ['scene-box', { viewBox: { of: 'scene' }, legend: 'omit' }],
  ['paper', { viewBox: { of: 'document', margin: 16 }, background: '#ffffff' }],
]

const envelopeOf = (ask: CoreSvgAsk, scene: Scene) => {
  if (ask.padding !== undefined) return { padding: ask.padding }
  if (ask.background !== undefined) {
    const { x, y, w, h } = sceneBounds(scene)
    return {
      width: w + 32,
      height: h + 32,
      viewBox: { x: x - 16, y: y - 16, w: w + 32, h: h + 32 },
      background: ask.background,
    }
  }
  const box = sceneBounds(scene)
  return { width: box.w, height: box.h, viewBox: box, legend: 'omit' as const }
}

describe.runIf(built)("the notice the core draws is the TypeScript's", () => {
  it('draws every refusal, mode, width and place as refusalScene does', {
    timeout: 120_000,
  }, () => {
    const core = oracleLayoutCore()
    const measure = createFakeMeasure()
    let compared = 0
    for (const refusal of REFUSALS) {
      const words = refusalCopy(refusal)
      for (const mode of MODES) {
        for (const maxWidth of WIDTHS) {
          for (const at of POINTS) {
            const options = {
              measure,
              mode,
              ...(maxWidth === undefined ? {} : { maxWidth }),
              ...(at === undefined ? {} : { at }),
            }
            const name = `${refusal.reason} ${mode} ${maxWidth} ${JSON.stringify(at)}`
            const expected = drawnByTypeScript(refusal, options)
            for (const [label, ask] of ENVELOPES) {
              const picture = layoutNoticePicture(core, words, options, ask)
              expect(picture.scene, `${name} ${label}`).toStrictEqual(expected)
              const svg = renderSceneToSvg(expected, envelopeOf(ask, expected))
              expect(picture.svg === svg, `${name} ${label}`).toBe(true)
              compared += 1
            }
            const keyed = layoutNoticeKeyedPicture(core, words, options, ENVELOPES[1]?.[1] ?? {})
            expect(keyed.scene, `${name} keyed`).toStrictEqual(expected)
            expect(keyed.keyed, `${name} keyed`).toEqual(
              renderSceneToKeyedSvg(expected, envelopeOf(ENVELOPES[1]?.[1] ?? {}, expected)),
            )
            compared += 1
          }
        }
      }
    }
    expect(compared, 'notices compared').toBeGreaterThan(900)
  })

  it('wraps to the width there is and draws the words in the notice', () => {
    const refusal: LayoutRefusal = { code: 'malformed', reason: 'bodies' }
    const options = { measure: createFakeMeasure(), mode: 'light' as const, maxWidth: 120 }
    const { scene } = layoutNoticePicture(oracleLayoutCore(), refusalCopy(refusal), options, {
      padding: 0,
    })
    const runs = scene.nodes.filter((node) => node.kind === 'textRun')
    // The reachability guard: a width of 120 wraps the detail onto many lines.
    expect(runs.length).toBeGreaterThan(8)
    expect(scene.nodes[0]?.kind).toBe('shape')
  })

  describe('a measurer that cannot place the notice', () => {
    const refusal: LayoutRefusal = { code: 'malformed', reason: 'host-measure' }
    const words = refusalCopy(refusal)
    const ratio = (options: { maxWidth?: number }) =>
      drawnByTypeScript(refusal, { measure: constantRatioMeasureText, mode: 'dark', ...options })

    const drawnWith = (measure: MeasureText, maxWidth: number) =>
      layoutNoticePicture(
        oracleLayoutCore(),
        words,
        { measure, mode: 'dark', maxWidth },
        { padding: 4 },
      )

    it('draws the whole notice by the ratio estimate when the host throws', () => {
      const throws: MeasureText = () => {
        throw new Error('no canvas context')
      }
      for (const maxWidth of [480, 200, 40]) {
        const picture = drawnWith(throws, maxWidth)
        expect(picture.scene).toStrictEqual(ratio({ maxWidth }))
        const svg = renderSceneToSvg(ratio({ maxWidth }), { padding: 4 })
        expect(picture.svg === svg).toBe(true)
      }
    })

    it('draws the whole notice by the ratio estimate when the host answers no number', () => {
      const nan: MeasureText = () => ({
        advanceWidth: Number.NaN,
        ascent: 8,
        descent: 2,
        lineGap: 0,
      })
      expect(drawnWith(nan, 300).scene).toStrictEqual(ratio({ maxWidth: 300 }))
      const noAscent: MeasureText = (text, font) => ({
        ...constantRatioMeasureText(text, font),
        ascent: Number.POSITIVE_INFINITY,
      })
      expect(drawnWith(noAscent, 300).scene).toStrictEqual(ratio({ maxWidth: 300 }))
    })

    it('draws all of it by the ratio estimate when only one text goes unanswered', () => {
      const once: MeasureText = (text, font) =>
        text.length > 40
          ? { ...constantRatioMeasureText(text, font), advanceWidth: Number.NaN }
          : { advanceWidth: 5, ascent: 9, descent: 1, lineGap: 0 }
      expect(drawnWith(once, 300).scene).toStrictEqual(ratio({ maxWidth: 300 }))
    })

    it('draws by the host measurer when it answers every text', () => {
      const answers: MeasureText = (text, font) => constantRatioMeasureText(text, font)
      expect(drawnWith(answers, 300).scene).toStrictEqual(ratio({ maxWidth: 300 }))
      const wide: MeasureText = (text, font) => ({
        advanceWidth: text.length * 7,
        ascent: font.sizePx * 0.8,
        descent: font.sizePx * 0.2,
        lineGap: 0,
      })
      const expected = drawnByTypeScript(refusal, { measure: wide, mode: 'dark', maxWidth: 300 })
      expect(drawnWith(wide, 300).scene).toStrictEqual(expected)
    })
  })
})
