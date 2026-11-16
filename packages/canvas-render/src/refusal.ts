import type { Scene, SceneNode } from '@kamiazya/whiteboard-scene'
import { clampAdvance, type FontDescriptor, type MeasureText } from './measure.js'
import { SPATIAL_THEME_FONT_FAMILY } from './theme/font-family.js'
import { SPATIAL_DARK_PALETTE, SPATIAL_LIGHT_PALETTE } from './theme/spatial-palette.js'
import type { SpatialThemeMode } from './theme/spatial-theme-mode.js'

// What a surface draws where the Rust core refused a layout (ADR-0054 step 7,
// owner decision q81, D7d): a request past one of the core's caps, a number no
// answer can spell, or a host measurer that did not answer. It is a scene on
// the ordinary vocabulary, so every surface that draws a layout draws this one
// the same way, through the same SVG backend. Not a layout: one box and its
// words, wrapped greedily, which is all a message needs.
//
// The words are owner decision D12's, drafted for review; they name no number,
// since a cap's value lives in the core and a sentence quoting it is one more
// place a raised cap would have to reach.

/** A layout the core refused, as `@kamiazya/whiteboard-core-wasm` answers it. */
export interface LayoutRefusal {
  readonly code: 'input-too-large' | 'malformed'
  readonly reason: string
}

/** What a refusal says: a title, and a detail saying what happened and what the reader can do. */
export interface RefusalCopy {
  readonly title: string
  readonly detail: string
}

const TOO_MUCH = 'Too much to draw here'
const CANNOT = 'This could not be drawn'

/** The words for each reason the core refuses with that a person can act on. */
const COPY = {
  'too-many-elements': {
    title: TOO_MUCH,
    detail:
      'This board has more boxes, edges and lines than can be drawn at once. Split it into smaller boards.',
  },
  'referenced-elements': {
    title: TOO_MUCH,
    detail:
      'The boards shown inside this one hold more boxes, edges and lines together than can be drawn at once. Show fewer of them here, or open them on their own.',
  },
  bodies: {
    title: TOO_MUCH,
    detail:
      'The text here, with the notes it shows, is more than can be drawn at once. Show fewer notes here, or split the text.',
  },
  'too-large': {
    title: TOO_MUCH,
    detail: 'There is more here than can be drawn at once. Split it into smaller boards or notes.',
  },
  comments: {
    title: TOO_MUCH,
    detail:
      'This board has more comments than can be drawn at once. Resolve or delete some of the threads.',
  },
  proposals: {
    title: TOO_MUCH,
    detail:
      'This board has more proposed changes than can be drawn at once. Accept or reject some of them.',
  },
  fragments: {
    title: TOO_MUCH,
    detail:
      'There are more formulas and diagrams here than can be drawn at once. Split it into smaller boards or notes.',
  },
  'non-finite': {
    title: CANNOT,
    detail:
      'A position or size in it is too large to draw. Undo the last change, or restore an earlier version.',
  },
  'host-measure': {
    title: CANNOT,
    detail: 'The browser could not measure its text. Reload the page to try again.',
  },
} as const satisfies Record<string, RefusalCopy>

/** The reasons with words of their own. */
export const REFUSAL_REASONS = Object.keys(COPY) as readonly (keyof typeof COPY)[]

/** What a refusal whose reason has no words of its own says, by its code. */
const GENERAL: Readonly<Record<LayoutRefusal['code'], RefusalCopy>> = {
  'input-too-large': {
    title: TOO_MUCH,
    detail: 'There is more here than can be drawn at once. Split it into smaller parts.',
  },
  malformed: {
    title: CANNOT,
    detail:
      'Something in it could not be drawn. Undo the last change, or restore an earlier version.',
  },
}

const isWorded = (reason: string): reason is keyof typeof COPY => Object.hasOwn(COPY, reason)

/** The words a refusal is drawn with. */
export function refusalCopy({ code, reason }: LayoutRefusal): RefusalCopy {
  return isWorded(reason) ? COPY[reason] : GENERAL[code]
}

/** How a refusal is drawn: the measurer, the mode, and the width there is (default and most, 480px). */
export interface RefusalSceneOptions {
  readonly measure: MeasureText
  readonly mode: SpatialThemeMode
  readonly maxWidth?: number
}

const WIDTH_PX = 480
const PADDING_PX = 16
const GAP_PX = 6
const TITLE_SIZE_PX = 16
const DETAIL_SIZE_PX = 14
const LINE_HEIGHT = 1.4

const font = (sizePx: number, weight: number): FontDescriptor => ({
  family: SPATIAL_THEME_FONT_FAMILY,
  fallbackChain: [],
  weight,
  style: 'normal',
  sizePx,
})

/** `text` broken at spaces into lines no wider than `width`; a word wider than it keeps a line of its own. */
function wrap(text: string, width: number, measure: MeasureText, at: FontDescriptor): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(' ')) {
    const tried = line === '' ? word : `${line} ${word}`
    if (line !== '' && clampAdvance(measure(tried, at).advanceWidth) > width) {
      lines.push(line)
      line = word
    } else {
      line = tried
    }
  }
  if (line !== '') lines.push(line)
  return lines
}

/**
 * A refused layout drawn as one box naming why, at the origin, in the
 * palette of `mode`: the title in bold, then the detail, wrapped to the box.
 */
export function refusalScene(refusal: LayoutRefusal, options: RefusalSceneOptions): Scene {
  const { measure, mode } = options
  const palette = mode === 'dark' ? SPATIAL_DARK_PALETTE : SPATIAL_LIGHT_PALETTE
  const width = Math.min(options.maxWidth ?? WIDTH_PX, WIDTH_PX)
  const inner = width - 2 * PADDING_PX
  const { title, detail } = refusalCopy(refusal)
  const runs: SceneNode[] = []
  let y = PADDING_PX
  const set = (text: string, sizePx: number, strong: boolean) => {
    const at = font(sizePx, strong ? 700 : 400)
    const lineHeight = sizePx * LINE_HEIGHT
    for (const line of wrap(text, inner, measure, at)) {
      const { advanceWidth, ascent } = measure(line, at)
      runs.push({
        kind: 'textRun',
        bbox: { x: PADDING_PX, y, w: Math.min(clampAdvance(advanceWidth), inner), h: lineHeight },
        text: line,
        ...(strong ? { strong: true } : {}),
        baseline: ascent + (lineHeight - sizePx) / 2,
        appearance: {
          fill: palette.labelFill,
          fontFamily: SPATIAL_THEME_FONT_FAMILY,
          fontSize: sizePx,
        },
      })
      y += lineHeight
    }
  }
  set(title, TITLE_SIZE_PX, true)
  y += GAP_PX
  set(detail, DETAIL_SIZE_PX, false)
  const box: SceneNode = {
    kind: 'shape',
    bbox: { x: 0, y: 0, w: width, h: y + PADDING_PX },
    radius: palette.cornerRadiusPx,
    appearance: {
      fill: palette.node.file.fill,
      stroke: palette.node.file.stroke,
      strokeWidth: 1,
    },
  }
  return { nodes: [box, ...runs] }
}
