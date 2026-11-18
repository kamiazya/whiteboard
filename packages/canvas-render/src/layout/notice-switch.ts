import type { Scene, SceneNode } from '@kamiazya/whiteboard-scene'
import type { CoreSvgAsk } from '../canvas-core.js'
import type { LayoutCore } from '../layout-core.js'
import { type MeasureText, measureSpecOf } from '../measure.js'
import { type LayoutRefusal, refusalCopy } from '../refusal.js'
import type { SpatialThemeMode } from '../theme/spatial-theme-mode.js'
import { askedPicture, type MaybePictured } from './asked-picture.js'
import { queried } from './core-query.js'

/** What a notice says; the words are the caller's. */
export interface NoticeWords {
  readonly title: string
  readonly detail: string
}

/** How a notice is drawn: the measurer, the mode, the width there is (480 at most) and where its top-left corner sits. */
export interface NoticeOptions {
  readonly measure: MeasureText
  readonly mode: SpatialThemeMode
  readonly maxWidth?: number
  readonly at?: { readonly x: number; readonly y: number }
}

/**
 * The notice `words` say, drawn by `core` as one box and its text runs, with
 * the picture the core drew of it in the envelope and form `svg` names. The
 * core answers every notice (a measurer that fails draws it by the ratio
 * estimate), so a refusal here is a defect in the asking, not an input.
 */
export function noticeThroughCore(
  core: LayoutCore,
  words: NoticeWords,
  options: NoticeOptions,
  svg?: CoreSvgAsk,
): { readonly nodes: SceneNode[] } & MaybePictured {
  const drawn = askedNotice(core, words, options, svg)
  if ('refused' in drawn) {
    throw new Error(`the core refused a notice: ${drawn.refused.code} ${drawn.refused.reason}`)
  }
  return drawn
}

/** The notice the core drew, or what it refused it with. */
function askedNotice(
  core: LayoutCore,
  words: NoticeWords,
  options: NoticeOptions,
  svg: CoreSvgAsk | undefined,
): ({ readonly nodes: SceneNode[] } & MaybePictured) | { readonly refused: LayoutRefusal } {
  const { measure, mode, maxWidth, at } = options
  type Drawn = { readonly nodes: readonly SceneNode[] } & MaybePictured
  const layer = queried<Drawn | { readonly refused: LayoutRefusal }>(core, {
    request: () => ({
      query: 'notice',
      title: words.title,
      detail: words.detail,
      mode,
      measure: measureSpecOf(measure),
      ...(maxWidth === undefined ? {} : { maxWidth }),
      ...(at === undefined ? {} : { at: [at.x, at.y] as const }),
      ...(svg === undefined ? {} : { svg }),
    }),
    unanswered: (refused) => ({ refused }),
    read: (answer) => {
      if (!('nodes' in answer)) return undefined
      return svg === undefined
        ? { nodes: answer.nodes }
        : { nodes: answer.nodes, ...askedPicture(svg, answer) }
    },
    measure,
  })
  return 'refused' in layer ? layer : { ...layer, nodes: [...layer.nodes] }
}

/**
 * A refused layout drawn as its notice, through the same core that refused it:
 * the words are `refusalCopy`'s, the box and its picture the core's. A core
 * that refuses even the notice is not there to draw anything (a web page whose
 * core did not load answers every layout `core-unavailable`), so the scene is
 * empty and carries only the refusal, which a surface says in words of its
 * own, and no picture is answered.
 */
export function refusalThroughCore(
  core: LayoutCore,
  refusal: LayoutRefusal,
  options: NoticeOptions,
  svg?: CoreSvgAsk,
): { readonly scene: Scene } & MaybePictured {
  const drawn = askedNotice(core, refusalCopy(refusal), options, svg)
  if ('refused' in drawn) return { scene: { nodes: [], refusal } }
  const { nodes, ...picture } = drawn
  return { scene: { nodes, refusal }, ...picture }
}
