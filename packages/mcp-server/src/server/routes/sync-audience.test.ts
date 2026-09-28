/**
 * Every text event the daemon emits is one the browser reads.
 *
 * The emitters in `sync-audience.ts` are hand-written literals sent as
 * `JSON.stringify(message)`; the browser parses each with
 * `serverTextMessageSchema` and DROPS one it refuses, warning into a console
 * nobody watches. A property over the schema alone cannot see a drift here —
 * the generator would narrow with the schema — so this one drives the
 * emitters themselves with what their parameters admit and parses what
 * reached the SSE transport the way the browser does.
 */
import { versionEntrySchema } from '@kamiazya/whiteboard-daemon-client/api-contracts/document'
import {
  agentActivityMessageSchema,
  headChangedMessageSchema,
  serverTextMessageSchema,
  viewportRequestParamsSchema,
} from '@kamiazya/whiteboard-daemon-client/ws-messages'
import { arbitraryForSchema } from '@kamiazya/whiteboard-model/test-utils'
import { afterAll, describe, expect, vi } from 'vitest'
import { fc, fcTest, withDefaults } from '../../shared/test-utils/fast-check.js'

/** Every raw event handed to the SSE transport, whichever broadcaster carried it. */
const sent: string[] = []

vi.mock('./sync-sse.js', () => ({
  setSyncSseHooks: () => {},
  sseBroadcastText: (_workspaceId: string, _path: string, raw: string) => {
    sent.push(raw)
  },
  sseBroadcastTextToReady: (_workspaceId: string, _path: string, raw: string) => {
    sent.push(raw)
  },
  sseClientCount: () => 0,
  sseSubscribedWorkspaceIds: () => [],
}))

const {
  sendAgentActivity,
  sendHeadChanged,
  sendRestoreEvent,
  sendVersionCreated,
  sendViewportRequest,
} = await import('./sync-audience.js')

const WORKSPACE = 'session1'
const CANVAS = 'emitter-property-canvas'

const versionArb = arbitraryForSchema(versionEntrySchema)
const activityArb = arbitraryForSchema(agentActivityMessageSchema.omit({ type: true }))
const viewportArb = arbitraryForSchema(viewportRequestParamsSchema)
const headArb = arbitraryForSchema(headChangedMessageSchema.shape.head)

type Emission =
  | { readonly kind: 'version_created'; readonly version: fc.TypeOf<typeof versionArb> }
  | { readonly kind: 'restore'; readonly phase: 'started' | 'complete'; readonly label?: string }
  | { readonly kind: 'agent_activity'; readonly payload: fc.TypeOf<typeof activityArb> }
  | { readonly kind: 'head_changed'; readonly head: string }
  | {
      readonly kind: 'viewport_request'
      readonly requestId: string
      readonly params: fc.TypeOf<typeof viewportArb>
    }

const emissionArb: fc.Arbitrary<Emission> = fc.oneof(
  versionArb.map((version) => ({ kind: 'version_created', version }) as const),
  fc
    .tuple(fc.constantFrom('started', 'complete'), fc.option(fc.string(), { nil: undefined }))
    .map(
      ([phase, label]) =>
        ({ kind: 'restore', phase, ...(label === undefined ? {} : { label }) }) as const,
    ),
  activityArb.map((payload) => ({ kind: 'agent_activity', payload }) as const),
  headArb.map((head) => ({ kind: 'head_changed', head }) as const),
  fc
    .tuple(fc.string({ minLength: 1 }), viewportArb)
    .map(([requestId, params]) => ({ kind: 'viewport_request', requestId, params }) as const),
)

/** What the browser should read: composed from the emission, not from the emitter. */
function expectedFrame(emission: Emission): unknown {
  switch (emission.kind) {
    case 'version_created':
      return { type: 'version_created', version: emission.version }
    case 'restore':
      return emission.phase === 'started'
        ? {
            type: 'restore_started',
            ...(emission.label === undefined ? {} : { label: emission.label }),
          }
        : { type: 'restore_complete' }
    case 'agent_activity':
      return { type: 'agent_activity', ...emission.payload }
    case 'head_changed':
      return { type: 'head_changed', head: emission.head }
    case 'viewport_request':
      return { type: 'viewport_request', requestId: emission.requestId, ...emission.params }
  }
}

function emit(emission: Emission): void {
  switch (emission.kind) {
    case 'version_created':
      sendVersionCreated(WORKSPACE, CANVAS, emission.version)
      break
    case 'restore':
      sendRestoreEvent(WORKSPACE, CANVAS, emission.phase, emission.label)
      break
    case 'agent_activity':
      sendAgentActivity(WORKSPACE, CANVAS, emission.payload)
      break
    case 'head_changed':
      sendHeadChanged(WORKSPACE, CANVAS, emission.head)
      break
    case 'viewport_request':
      sendViewportRequest(WORKSPACE, CANVAS, emission.requestId, emission.params)
      break
  }
}

const viaJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value))
const kinds = new Map<string, number>()

describe('every text event the daemon emits is one the browser reads', () => {
  afterAll(() => {
    const unreached = [
      'version_created',
      'restore',
      'agent_activity',
      'head_changed',
      'viewport_request',
    ].filter((kind) => (kinds.get(kind) ?? 0) === 0)
    expect(unreached, `emitters the run never drove: ${JSON.stringify([...kinds])}`).toEqual([])
  })

  fcTest.prop([emissionArb], withDefaults())(
    'the event parses under the browser schema, equal to what was asked',
    (emission) => {
      kinds.set(emission.kind, (kinds.get(emission.kind) ?? 0) + 1)
      const before = sent.length
      emit(emission)
      const frames = sent.slice(before)
      expect(frames, JSON.stringify(emission)).toHaveLength(1)
      const raw: unknown = JSON.parse(frames[0] as string)
      const parsed = serverTextMessageSchema.safeParse(raw)
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true)
      expect(parsed.data).toEqual(viaJson(expectedFrame(emission)))
      // The parser strips a key it does not know, so a field the emitter adds
      // and the schema never learned would pass the line above unseen.
      expect(raw).toEqual(viaJson(expectedFrame(emission)))
    },
  )
})
