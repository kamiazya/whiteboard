import type { Scene } from '@kamiazya/whiteboard-scene'
import type { CoreSvgAsk } from '../../canvas-core.js'
import { constantRatioMeasureText, type MeasureText } from '../../measure.js'
import type { LayoutRefusal } from '../../refusal.js'
import { createFakeMeasure } from '../fake-measure.js'
import { digestOf, dumpScene } from './scene-dump.js'

/**
 * The inputs of the refusal-notice recording (`oracle/notice.jsonl`) and how
 * an answer is digested to be held to it.
 *
 * A notice is the core's drawing of `refusalCopy`'s words. Every refusal, mode,
 * width and place below was recorded from the TypeScript notice drawing and
 * its SVG backend before both were deleted (ADR-0054 A3.6), so the core is
 * held to the picture every surface drew before it did. A row holds digests
 * (`digestOf`'s length and FNV-1a), not the text: the grid is a few hundred
 * notices in four forms each, a few megabytes written out.
 */

/** The reasons whose words `refusalCopy` writes, plus two it has no words of its own for. */
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

const NOTICE_REFUSALS: readonly LayoutRefusal[] = [
  ...WORDED.map((reason): LayoutRefusal => ({ code: 'malformed', reason })),
  { code: 'input-too-large', reason: 'no-words-of-its-own' },
  { code: 'malformed', reason: 'no-words-of-its-own' },
]

/** An envelope a picture is asked in; the function names the form. */
export type NoticeAsk = Omit<CoreSvgAsk, 'form'>

/** The envelopes every notice is drawn in, by name; the keyed form is drawn in `scene-box`. */
const NOTICE_ENVELOPES: readonly (readonly [string, NoticeAsk])[] = [
  ['padding', { padding: 12 }],
  ['scene-box', { viewBox: { of: 'scene' }, legend: 'omit' }],
  ['paper', { viewBox: { of: 'document', margin: 16 }, background: '#ffffff' }],
]

export const KEYED_ENVELOPE = 'scene-box'

/** The measurers a notice is recorded under, by name. */
const NOTICE_MEASURES = {
  fake: createFakeMeasure(),
  ratio: constantRatioMeasureText,
  wide: (text, font) => ({
    advanceWidth: text.length * 7,
    ascent: font.sizePx * 0.8,
    descent: font.sizePx * 0.2,
    lineGap: 0,
  }),
} as const satisfies Record<string, MeasureText>

type NoticeMeasure = keyof typeof NOTICE_MEASURES

export interface NoticeInput {
  readonly id: string
  readonly refusal: LayoutRefusal
  readonly measure: NoticeMeasure
  readonly mode: 'light' | 'dark'
  readonly maxWidth?: number
  readonly at?: { readonly x: number; readonly y: number }
  /** The envelopes this notice is drawn in, by name; all of them, and the keyed form, when absent. */
  readonly envelopes?: readonly string[]
}

/** A digest: a text's length and FNV-1a. */
export interface Digest {
  readonly n: number
  readonly h: number
}

/** What a notice was recorded as: its scene, its picture in each envelope, and its keyed form. */
export interface NoticeRecord extends NoticeInput {
  readonly scene: Digest
  readonly svg: Readonly<Record<string, Digest>>
  readonly keyed?: Digest
}

const WIDTHS = [undefined, 480, 300, 120, 40, 20] as const
const POINTS = [undefined, { x: 0, y: 0 }, { x: 37.5, y: -12 }] as const
const MODES = ['light', 'dark'] as const

/**
 * Every notice the recording holds: each refusal in each mode, width and place
 * under the fake measurer, and the dark host-measure notice by ratio and by a
 * wide host measurer, which is what a measurer that cannot place it is drawn
 * as instead.
 */
export function noticeInputs(): readonly NoticeInput[] {
  const grid = NOTICE_REFUSALS.flatMap((refusal) =>
    MODES.flatMap((mode) =>
      WIDTHS.flatMap((maxWidth) =>
        POINTS.map(
          (at): NoticeInput => ({
            id: `grid/${refusal.code}/${refusal.reason}/${mode}/${maxWidth ?? '-'}/${at === undefined ? '-' : `${at.x},${at.y}`}`,
            refusal,
            measure: 'fake',
            mode,
            ...(maxWidth === undefined ? {} : { maxWidth }),
            ...(at === undefined ? {} : { at }),
          }),
        ),
      ),
    ),
  )
  const hostMeasure: LayoutRefusal = { code: 'malformed', reason: 'host-measure' }
  const host = (measure: NoticeMeasure, maxWidth: number): NoticeInput => ({
    id: `host/${measure}/${maxWidth}`,
    refusal: hostMeasure,
    measure,
    mode: 'dark',
    maxWidth,
    envelopes: ['padding-4'],
  })
  return [...grid, ...[480, 300, 200, 40].map((width) => host('ratio', width)), host('wide', 300)]
}

/** The envelopes a host-measure notice is drawn in, beside `NOTICE_ENVELOPES`. */
const HOST_ENVELOPES: readonly (readonly [string, NoticeAsk])[] = [['padding-4', { padding: 4 }]]

/** Every envelope by name. */
export const ENVELOPE_BY_NAME: ReadonlyMap<string, NoticeAsk> = new Map([
  ...NOTICE_ENVELOPES,
  ...HOST_ENVELOPES,
])

/** The names of the envelopes `input` is drawn in. */
export const envelopesOf = (input: NoticeInput): readonly string[] =>
  input.envelopes ?? NOTICE_ENVELOPES.map(([name]) => name)

/** The notice options `input` names, its measurer resolved. */
export function noticeOptions(input: NoticeInput): {
  measure: MeasureText
  mode: 'light' | 'dark'
  maxWidth?: number
  at?: { x: number; y: number }
} {
  return {
    measure: NOTICE_MEASURES[input.measure],
    mode: input.mode,
    ...(input.maxWidth === undefined ? {} : { maxWidth: input.maxWidth }),
    ...(input.at === undefined ? {} : { at: { ...input.at } }),
  }
}

/** A scene's digest over its canonical dump, so the order its objects were built in is no part of it. */
export const sceneDigest = (scene: Scene): Digest => digestOf(dumpScene(scene))

/** A value's text with every object's keys sorted, `undefined` fields left out. */
function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(',')}]`
  if (typeof value !== 'object' || value === null) return JSON.stringify(value)
  const entries = Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${sortedJson(item)}`).join(',')}}`
}

/** A keyed picture's digest over its key-sorted text. */
export const keyedDigest = (keyed: unknown): Digest => digestOf(sortedJson(keyed))

/** An SVG's digest. */
export const svgDigest = (svg: string): Digest => digestOf(svg)
