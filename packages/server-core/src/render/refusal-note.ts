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
 * Where `wb_scene_render`'s result carries `refusalNote`'s words. A symbol
 * key, so JSON and the strict output schema read past it: the structured
 * output keeps its one shape, and the words travel with the result through
 * every wrapper a tool's `execute` passes (the workspace-handle resolution,
 * the membership gate), which a second method would bypass. The MCP adapter
 * takes them off and answers them as a second text item.
 */
export const REFUSAL_NOTE: unique symbol = Symbol('whiteboard.refusal-note')

/**
 * What a render tells a caller beside the SVG when the document is drawn as a
 * refusal: the same words the notice carries, and the reason the core gave,
 * which is what an agent can act on without reading the picture.
 */
export function refusalNote(refusal: LayoutRefusal): string {
  const { title, detail } = refusalCopy(refusal)
  return `The SVG shows a notice in place of the document: ${title}. ${detail} (reason: ${refusal.reason})`
}
