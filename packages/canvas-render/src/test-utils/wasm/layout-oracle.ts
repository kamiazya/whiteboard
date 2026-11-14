import { type CoreGlue, coreFrom, EXPECTED_ABI } from '@kamiazya/whiteboard-core-wasm'
import type { CanvasLayoutRequest, CoreDegradation } from '../../canvas-core.js'
import { canvasLayoutRequest } from '../../layout/canvas-switch.js'
import type { SpatialLayoutDegradation } from '../../layout/layout-options.js'
import { layoutSpatialCanvasWithAnchors } from '../../layout/spatial-canvas.js'
import { layoutCases } from './layout-cases.js'

/** One recorded layout: the request as the shim sends it, and the TypeScript's answer as the core spells it. */
export interface LayoutRecord {
  readonly id: string
  readonly request: string
  readonly answer: string
}

/**
 * A value as `scene_wire`'s JSON writes it: JavaScript's own number spelling
 * but `-0` kept, so the replay compares every double; undefined when a number
 * has no JSON spelling, which the core declines.
 */
function answerText(value: unknown): string | undefined {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined
    return Object.is(value, -0) ? '-0' : String(value)
  }
  if (typeof value !== 'object' || value === null) return JSON.stringify(value)
  const parts = Array.isArray(value)
    ? value.map(answerText)
    : Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => {
          const text = answerText(item)
          return text === undefined ? undefined : `${JSON.stringify(key)}:${text}`
        })
  if (parts.includes(undefined)) return undefined
  return Array.isArray(value) ? `[${parts.join(',')}]` : `{${parts.join(',')}}`
}

/**
 * The request text exactly as the shim sends it: a core over a glue that keeps
 * what it is handed and declines, so the recording cannot drift from the shim's
 * encoding.
 */
function shimRequest(request: CanvasLayoutRequest): string | undefined {
  let sent: string | undefined
  const glue = {
    initSync: () => undefined,
    abi_version: () => EXPECTED_ABI,
    layout_spatial_canvas: (text: string) => {
      sent = text
      return '["declined","recorded"]'
    },
  } as unknown as CoreGlue
  coreFrom(glue, new Uint8Array()).layoutSpatialCanvas(request)
  return sent
}

function coreEvent(event: SpatialLayoutDegradation): CoreDegradation {
  return event.kind === 'body-parse-failed' ? { kind: event.kind, nodeId: event.nodeId } : event
}

/**
 * Every layout case the core can be handed, each as the TypeScript answers
 * it. The two cases only the TypeScript draws exactly are recorded with the
 * answer the core gives them, a decline.
 */
export function layoutRecords(): LayoutRecord[] {
  return layoutCases(8).flatMap(({ name, canvas, options }) => {
    const request = canvasLayoutRequest(canvas, options)
    const sent = request === undefined ? undefined : shimRequest(request)
    if (sent === undefined) return []
    const events: CoreDegradation[] = []
    const laid = layoutSpatialCanvasWithAnchors(canvas, {
      ...options,
      onDegrade: (event) => events.push(coreEvent(event)),
    })
    const declined = name.startsWith('declined: ')
      ? name.includes('```')
        ? 'highlight'
        : 'shortcode'
      : undefined
    const answer =
      declined === undefined
        ? (answerText(['ok', laid.scene, [...laid.anchors], events]) ?? '["declined","non-finite"]')
        : JSON.stringify(['declined', declined])
    return [{ id: name, request: sent, answer }]
  })
}
