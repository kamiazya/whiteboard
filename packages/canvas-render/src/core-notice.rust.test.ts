import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { layoutNoticeKeyedPicture, layoutNoticePicture } from './core-picture.js'
import { constantRatioMeasureText, type MeasureText } from './measure.js'
import { type LayoutRefusal, refusalCopy } from './refusal.js'
import { createFakeMeasure } from './test-utils/fake-measure.js'
import {
  type Digest,
  ENVELOPE_BY_NAME,
  envelopesOf,
  KEYED_ENVELOPE,
  keyedDigest,
  type NoticeRecord,
  noticeOptions,
  sceneDigest,
  svgDigest,
} from './test-utils/render-oracle/notice-oracle.js'
import { decodeLines } from './test-utils/render-oracle/oracle.js'
import { built } from './test-utils/wasm/glue.js'
import { oracleLayoutCore } from './test-utils/wasm/oracle-layout-core.js'

// The core draws the notice a refused layout is shown as; the words stay
// `refusalCopy`'s. Each notice is held to `oracle/notice.jsonl`, the picture
// every surface drew before the core did, recorded from the TypeScript notice
// drawing and SVG backend (ADR-0054 A3.6).

const RECORDED = decodeLines<NoticeRecord>(
  readFileSync(new URL('./oracle/notice.jsonl', import.meta.url), 'utf8'),
)

const recordOf = (id: string): NoticeRecord => {
  const record = RECORDED.find((r) => r.id === id)
  if (record === undefined) throw new Error(`notice.jsonl holds no ${id}`)
  return record
}

/** A digest's length and hash as one text, so a failure names both. */
const text = ({ n, h }: Digest) => `${n}/${h}`

describe.runIf(built)('the notice the core draws is the recorded one', () => {
  it('draws every recorded notice in every envelope and in the keyed form', {
    timeout: 120_000,
  }, () => {
    const core = oracleLayoutCore()
    let compared = 0
    for (const record of RECORDED) {
      const words = refusalCopy(record.refusal)
      const options = noticeOptions(record)
      for (const name of envelopesOf(record)) {
        const picture = layoutNoticePicture(core, words, options, ENVELOPE_BY_NAME.get(name) ?? {})
        expect(text(sceneDigest(picture.scene)), `${record.id} ${name} scene`).toBe(
          text(record.scene),
        )
        expect(text(svgDigest(picture.svg)), `${record.id} ${name}`).toBe(
          text(record.svg[name] ?? { n: -1, h: -1 }),
        )
        compared += 1
      }
      if (record.keyed !== undefined) {
        const ask = ENVELOPE_BY_NAME.get(KEYED_ENVELOPE) ?? {}
        const keyed = layoutNoticeKeyedPicture(core, words, options, ask)
        expect(text(sceneDigest(keyed.scene)), `${record.id} keyed scene`).toBe(text(record.scene))
        expect(text(keyedDigest(keyed.keyed)), `${record.id} keyed`).toBe(text(record.keyed))
        compared += 1
      }
    }
    expect(compared, 'notices compared').toBe(432 * 4 + 5)
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
    const words = refusalCopy({ code: 'malformed', reason: 'host-measure' })

    /** The host-measure notice drawn at `maxWidth` by `measure`, as recorded. */
    const drawnWith = (measure: MeasureText, maxWidth: number) => {
      const picture = layoutNoticePicture(
        oracleLayoutCore(),
        words,
        { measure, mode: 'dark', maxWidth },
        ENVELOPE_BY_NAME.get('padding-4') ?? {},
      )
      return { scene: text(sceneDigest(picture.scene)), svg: text(svgDigest(picture.svg)) }
    }

    /** The recorded notice `kind` drew at `maxWidth`. */
    const recorded = (kind: 'ratio' | 'wide', maxWidth: number) => {
      const record = recordOf(`host/${kind}/${maxWidth}`)
      return { scene: text(record.scene), svg: text(record.svg['padding-4'] ?? { n: -1, h: -1 }) }
    }

    it('draws the whole notice by the ratio estimate when the host throws', () => {
      const throws: MeasureText = () => {
        throw new Error('no canvas context')
      }
      for (const maxWidth of [480, 200, 40]) {
        expect(drawnWith(throws, maxWidth)).toEqual(recorded('ratio', maxWidth))
      }
    })

    it('draws the whole notice by the ratio estimate when the host answers no number', () => {
      const nan: MeasureText = () => ({
        advanceWidth: Number.NaN,
        ascent: 8,
        descent: 2,
        lineGap: 0,
      })
      expect(drawnWith(nan, 300)).toEqual(recorded('ratio', 300))
      const noAscent: MeasureText = (text, font) => ({
        ...constantRatioMeasureText(text, font),
        ascent: Number.POSITIVE_INFINITY,
      })
      expect(drawnWith(noAscent, 300)).toEqual(recorded('ratio', 300))
    })

    it('draws all of it by the ratio estimate when only one text goes unanswered', () => {
      const once: MeasureText = (text, font) =>
        text.length > 40
          ? { ...constantRatioMeasureText(text, font), advanceWidth: Number.NaN }
          : { advanceWidth: 5, ascent: 9, descent: 1, lineGap: 0 }
      expect(drawnWith(once, 300)).toEqual(recorded('ratio', 300))
    })

    it('draws by the host measurer when it answers every text', () => {
      const answers: MeasureText = (text, font) => constantRatioMeasureText(text, font)
      expect(drawnWith(answers, 300)).toEqual(recorded('ratio', 300))
      const wide: MeasureText = (text, font) => ({
        advanceWidth: text.length * 7,
        ascent: font.sizePx * 0.8,
        descent: font.sizePx * 0.2,
        lineGap: 0,
      })
      expect(drawnWith(wide, 300)).toEqual(recorded('wide', 300))
      // The two measurers place it differently, so neither answer is the other's.
      expect(recorded('wide', 300)).not.toEqual(recorded('ratio', 300))
    })
  })
})
