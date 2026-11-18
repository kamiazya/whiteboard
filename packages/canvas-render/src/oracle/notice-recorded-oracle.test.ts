import { readFileSync, writeFileSync } from 'node:fs'
import type { Scene } from '@kamiazya/whiteboard-scene'
import { describe, expect, it } from 'vitest'
import { refusalCopy, refusalScene } from '../refusal.js'
import { sceneBounds } from '../scene-bounds.js'
import { renderSceneToSvg, type SvgDocumentOptions } from '../svg/backend.js'
import { renderSceneToKeyedSvg } from '../svg/keyed.js'
import {
  ENVELOPE_BY_NAME,
  envelopesOf,
  KEYED_ENVELOPE,
  keyedDigest,
  type NoticeAsk,
  type NoticeInput,
  type NoticeRecord,
  noticeInputs,
  noticeOptions,
  sceneDigest,
  svgDigest,
} from '../test-utils/render-oracle/notice-oracle.js'
import { decodeLines, encodeLines } from '../test-utils/render-oracle/oracle.js'

/**
 * The committed recording of the refusal notice (`notice.jsonl`): what the
 * TypeScript notice drawing (`refusalScene`) and SVG backend answered for each
 * notice `noticeInputs` names, as digests. `core-notice.rust.test.ts` holds the
 * core's notice to it. Re-record after a deliberate change with
 * `WHITEBOARD_RECORD_ORACLE=1 pnpm vitest run --project canvas-render-node notice-recorded-oracle`.
 */
const FILE = new URL('./notice.jsonl', import.meta.url)

/** The scene the TypeScript draws, less the refusal it attaches and the core has no use for. */
function drawnByTypeScript(input: NoticeInput): Scene {
  const { refusal: _attached, ...scene } = refusalScene(input.refusal, noticeOptions(input))
  return scene
}

/** The backend options that draw the envelope a core picture ask names. */
function envelopeOf(ask: NoticeAsk, scene: Scene): SvgDocumentOptions {
  if (ask.padding !== undefined) return { padding: ask.padding }
  const box = sceneBounds(scene)
  if (ask.background !== undefined) {
    return {
      width: box.w + 32,
      height: box.h + 32,
      viewBox: { x: box.x - 16, y: box.y - 16, w: box.w + 32, h: box.h + 32 },
      background: ask.background,
    }
  }
  return { width: box.w, height: box.h, viewBox: box, legend: 'omit' }
}

function recordOf(input: NoticeInput): NoticeRecord {
  const scene = drawnByTypeScript(input)
  const names = envelopesOf(input)
  const svg = Object.fromEntries(
    names.map((name) => {
      const ask = ENVELOPE_BY_NAME.get(name) ?? {}
      return [name, svgDigest(renderSceneToSvg(scene, envelopeOf(ask, scene)))]
    }),
  )
  const keyedAsk = ENVELOPE_BY_NAME.get(KEYED_ENVELOPE) ?? {}
  return {
    ...input,
    scene: sceneDigest(scene),
    svg,
    ...(input.envelopes === undefined
      ? { keyed: keyedDigest(renderSceneToKeyedSvg(scene, envelopeOf(keyedAsk, scene))) }
      : {}),
  }
}

if (process.env.WHITEBOARD_RECORD_ORACLE === '1') {
  writeFileSync(FILE, encodeLines(noticeInputs().map(recordOf)))
}

describe('the recorded refusal notice', () => {
  const text = readFileSync(FILE, 'utf8')
  const recorded = decodeLines<NoticeRecord>(text)

  it('holds every refusal, mode, width, place and envelope, and the host-measure notices', () => {
    expect(recorded.map((r) => r.id)).toEqual(noticeInputs().map((input) => input.id))
    expect(recorded.filter((r) => r.id.startsWith('grid/')).length, 'grid').toBe(12 * 2 * 6 * 3)
    expect(new Set(recorded.map((r) => r.refusal.reason)).size, 'reasons').toBe(11)
    expect(recorded.filter((r) => r.keyed !== undefined).length, 'keyed').toBe(432)
    expect(recorded.filter((r) => r.measure !== 'fake').length, 'host measures').toBe(5)
    // The reachability guard: every input draws its own notice, except that no
    // width is the default 480 and no place is the origin: 12 refusals x 2
    // modes x 5 widths x 2 places, and the five host-measure notices.
    expect(new Set(recorded.map((r) => r.scene.h)).size).toBe(12 * 2 * 5 * 2 + 5)
    // `refusalCopy` is what draws the words, so a reason it has none for still reads.
    expect(refusalCopy({ code: 'malformed', reason: 'no-words-of-its-own' }).title).not.toBe('')
  })

  it('equals what the TypeScript answers today', () => {
    const lines = text.trimEnd().split('\n')
    const parted = recorded.findIndex((r, i) => JSON.stringify(recordOf(r)) !== lines[i])
    expect(
      recorded[parted]?.id,
      'the first notice the TypeScript no longer draws as recorded',
    ).toBeUndefined()
  })
})
