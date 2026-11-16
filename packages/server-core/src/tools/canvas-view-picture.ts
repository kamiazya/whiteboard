import {
  type CanvasViewPicture,
  hitBoxesOf,
  loadedReferenceFromWire,
  referenceSeams,
  renderSceneToSvg,
  resolveCanvasPalette,
} from '@kamiazya/whiteboard-canvas-render'
import { fromJsonCanvas } from '@kamiazya/whiteboard-codec'
import { composeCanvasScene } from '../render/compose-canvas-scene.js'
import { fontAvailableOf, resolveTextMeasurer } from '../render/text-measurer.js'
import type { ServerDeps } from '../server-deps.js'
import type { CanvasViewOutput } from './canvas-view.js'

/**
 * The picture the MCP Apps widget shows for one `canvas_view` result: laid out
 * HERE, with the Rust core and this daemon's measurer, so the widget only
 * displays it (ADR-0054 step 7, owner decision q54).
 *
 * Built from the RESULT, not from the store, for two reasons. It is drawn from
 * exactly what the widget used to lay out — the scene with its declared
 * colours already on it, the threads, the references, the echoed style — so
 * moving the layout across the boundary changes who draws, not what. And it
 * reads nothing a membership gate has not already let the caller see: the
 * registration builds it from the gated call's answer.
 *
 * A theme's family is declared only where this daemon's measurer holds a face
 * for it, as `wb_scene_render` and the export declare it (owner decision q80,
 * provisional): a family the daemon has not installed draws in the bundled one.
 */
export async function canvasViewPicture(
  deps: ServerDeps,
  result: CanvasViewOutput,
): Promise<CanvasViewPicture> {
  const canvas = fromJsonCanvas(result.scene)
  const measurer = await resolveTextMeasurer(deps)
  const core = await deps.layoutCore?.()
  const style = result.style ?? 'clean'
  const graph = new Map(
    Object.entries(result.references).map(([target, wire]) => [
      target,
      loadedReferenceFromWire(wire),
    ]),
  )
  const scene = composeCanvasScene(canvas, measurer.measure, {
    ...(graph.size === 0 ? {} : { references: referenceSeams(graph) }),
    threads: result.threads,
    style,
    fontAvailable: fontAvailableOf(measurer),
    ...(core === undefined ? {} : { core }),
  })
  return {
    // `padding: 0` asks for the derived envelope: the scene's own bounds,
    // the legend's band included, so nothing drawn falls outside the frame.
    svg: renderSceneToSvg(scene, {
      padding: 0,
      // A theme's paper, which no node carries. Light, the mode this picture
      // is laid out in (`MCP_SCENE_APPEARANCE`).
      background: resolveCanvasPalette(canvas, 'light', { style }).surface,
    }),
    boxes: hitBoxesOf(canvas.nodes),
  }
}
