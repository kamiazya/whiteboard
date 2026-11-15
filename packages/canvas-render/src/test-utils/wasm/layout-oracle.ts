import { type CoreGlue, coreFrom, EXPECTED_ABI } from '@kamiazya/whiteboard-core-wasm'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { CanvasLayoutRequest, CoreDegradation } from '../../canvas-core.js'
import { highlightCode } from '../../highlight/lowlight.js'
import { canvasLayoutRequest } from '../../layout/canvas-switch.js'
import type { FragmentAsk } from '../../layout/fragment-ask.js'
import type { SpatialLayoutDegradation, SpatialLayoutOptions } from '../../layout/layout-options.js'
import { layoutSpatialCanvasWithAnchors } from '../../layout/spatial-canvas.js'
import { type LayoutTopic, layoutCases } from './layout-cases.js'

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
 * The request texts exactly as the shim sends them: a core over a glue that
 * keeps what it is handed, answers the first call with the fences `needs`
 * names when there are any, and declines, so the recording cannot drift from
 * the shim's encoding of a request or of the tokens it sends on a second call.
 */
function shimRequests(request: CanvasLayoutRequest, needs: readonly Fence[]): string[] {
  const sent: string[] = []
  const glue = {
    initSync: () => undefined,
    abi_version: () => EXPECTED_ABI,
    layout_spatial_canvas: (text: string) => {
      sent.push(text)
      const asks = sent.length === 1 && needs.length > 0
      return asks ? needsAnswer(needs) : '["declined","recorded"]'
    },
  } as unknown as CoreGlue
  coreFrom(glue, new Uint8Array()).layoutSpatialCanvas(request, highlightCode)
  return sent
}

type Fence = readonly [string, string]

const needsAnswer = (needs: readonly Fence[]): string => JSON.stringify(['needs', { code: needs }])

/**
 * The fences the TypeScript colours in this layout, as `[lang, value]` in the
 * order it met them, each once: what the core is held to ask for.
 */
function colouredFences(canvas: SpatialCanvas, options: SpatialLayoutOptions): Fence[] {
  const met = new Map<string, Fence>()
  layoutSpatialCanvasWithAnchors(canvas, {
    ...options,
    highlightCode: (lang, value, budget) => {
      const lines = highlightCode(lang, value, budget)
      if (lines !== undefined) met.set(JSON.stringify([lang, value]), [lang, value])
      return lines
    },
  })
  return [...met.values()]
}

function coreEvent(event: SpatialLayoutDegradation): CoreDegradation {
  return event.kind === 'body-parse-failed' ? { kind: event.kind, nodeId: event.nodeId } : event
}

/**
 * Every layout case the core can be handed, each as the TypeScript answers
 * it, grouped by the topic file it is recorded in. A layout the TypeScript
 * colours a fence in is recorded twice: as first asked, answered with the
 * fences the core must ask for, and as asked again with their tokens.
 */
export function layoutRecords(): Map<LayoutTopic, LayoutRecord[]> {
  const byTopic = new Map<LayoutTopic, LayoutRecord[]>()
  for (const { topic, name, canvas, options } of layoutCases(8)) {
    const records = layoutRecord(name, canvas, options)
    byTopic.set(topic, [...(byTopic.get(topic) ?? []), ...records])
  }
  return byTopic
}

/** One case as the TypeScript answers it, or none when the core cannot be handed it. */
function layoutRecord(
  name: string,
  canvas: SpatialCanvas,
  options: SpatialLayoutOptions,
): LayoutRecord[] {
  const request = canvasLayoutRequest(canvas, options)
  if ('skip' in request) return []
  const needs = colouredFences(canvas, options)
  const sent = shimRequests(request, needs)
  const events: CoreDegradation[] = []
  let asked: readonly FragmentAsk[] = []
  const laid = layoutSpatialCanvasWithAnchors(canvas, {
    ...options,
    onDegrade: (event) => events.push(coreEvent(event)),
    ...(request.fragments !== undefined && {
      onFragmentsAsked: (asks: readonly FragmentAsk[]) => {
        asked = asks
      },
    }),
  })
  // The core answers the sources a table lacked only for a request carrying one.
  const asks = request.fragments === undefined ? [] : [asked]
  const answer =
    answerText(['ok', laid.scene, [...laid.anchors], events, ...asks]) ??
    '["declined","non-finite"]'
  const [first, second] = sent
  if (first === undefined) return []
  if (second === undefined) return [{ id: name, request: first, answer }]
  return [
    { id: `${name}, asked`, request: first, answer: needsAnswer(needs) },
    { id: name, request: second, answer },
  ]
}
