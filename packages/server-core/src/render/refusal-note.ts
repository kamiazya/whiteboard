import { type LayoutRefusal, refusalCopy } from '@kamiazya/whiteboard-canvas-render'
import { getLogger } from '../log.js'

const log = getLogger('layout-refusal')

/**
 * Reports a layout the Rust core refused (owner decision q81, D7) through
 * `getLogger`, since canvas-render cannot log: the scene drawn is the refusal,
 * and the reason is what a person reading the daemon's log can act on.
 */
export function logRefusal({ code, reason }: LayoutRefusal): void {
  log.warning('the layout was refused and is drawn as a notice', { code, reason })
}

/**
 * What a render tells a caller beside the SVG when the document is drawn as a
 * refusal: the same words the notice carries, and the reason the core gave,
 * which is what an agent can act on without reading the picture.
 */
export function refusalNote(refusal: LayoutRefusal): string {
  const { title, detail } = refusalCopy(refusal)
  return `The SVG shows a notice in place of the document: ${title}. ${detail} (reason: ${refusal.reason})`
}
