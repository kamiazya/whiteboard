/**
 * Every text frame the daemon emits is one the browser reads.
 *
 * The emitters in `ws.ts` are hand-written literals sent as
 * `JSON.stringify(message)`; the browser parses each frame with
 * `serverTextMessageSchema` and DROPS one it refuses, warning into a
 * console nobody watches. A property over the schema alone cannot see a
 * drift here — the generator would narrow with the schema — so this one
 * drives the emitters themselves with what their parameters admit and
 * parses what reached a connected socket the way the browser does.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { versionEntrySchema } from '@kamiazya/whiteboard-daemon-client/api-contracts/document'
import {
  agentActivityMessageSchema,
  headChangedMessageSchema,
  serverTextMessageSchema,
  viewportRequestParamsSchema,
} from '@kamiazya/whiteboard-daemon-client/ws-messages'
import { arbitraryForSchema } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { afterAll, beforeAll, describe, expect, vi } from 'vitest'
import { fc, fcTest, withDefaults } from '../../shared/test-utils/fast-check.js'

let tempDir: string

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  getDataDir: () => tempDir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { clearCache } = await import('../store/doc-cache.js')
const { saveDocument } = await import('../store/document-store.js')
const {
  handleWsUpgrade,
  sendAgentActivity,
  sendHeadChanged,
  sendRestoreEvent,
  sendVersionCreated,
  sendViewportRequest,
} = await import('./ws.js')

class FakeWebSocket {
  sent: string[] = []
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  send(data: string | Uint8Array | ArrayBuffer): void {
    if (typeof data === 'string') this.sent.push(data)
  }
  on(event: string, handler: (...args: unknown[]) => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), handler])
  }
  close(): void {}
  async emitMessage(data: Buffer, isBinary: boolean): Promise<void> {
    for (const handler of this.listeners.get('message') ?? []) await handler(data, isBinary)
  }
}

const WORKSPACE = 'session1'
// `ws.ts` keys its registries by `<workspaceId>/<path>` as module state, so
// this canvas is one no other file's test connects to.
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
const socket = new FakeWebSocket()

describe('every text frame the daemon emits is one the browser reads', () => {
  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-ws-emitters-'))
    await mkdir(join(tempDir, WORKSPACE), { recursive: true })
    await saveDocument(WORKSPACE, 'registered-seed', new LoroDoc())
    clearCache()
    await handleWsUpgrade(
      { url: `/ws/${WORKSPACE}/${CANVAS}`, headers: { host: 'localhost:3099' } } as never,
      socket as never,
    )
    await socket.emitMessage(Buffer.from(JSON.stringify({ type: 'client_ready' })), false)
  })

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true })
    clearCache()
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
    'the frame parses under the browser schema, equal to what was asked',
    (emission) => {
      kinds.set(emission.kind, (kinds.get(emission.kind) ?? 0) + 1)
      const before = socket.sent.length
      emit(emission)
      const frames = socket.sent.slice(before)
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
