/**
 * Server mode's `/mcp` content slot is held for as long as the call it was
 * taken for is still being answered — including a modern-era call whose
 * answer is a `text/event-stream` handed back while the tool still runs.
 * Releasing at the handler's return would free the slot the moment the
 * stream opened, leaving concurrent calls uncapped.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createContainer, resolveServerDeps } from '../di/container.js'
import { storeMemoryModule } from '../shared/test-utils/store-memory.module.js'
import {
  bearerNamesItsSubject,
  ISSUER,
  PUBLIC_URL,
  serverModePeople,
} from './_test-server-mode-harness.js'
import type { ServerModeAppOptions } from './app.js'
import { CONTENT_REQUEST_CAPS } from './content-slots.js'
import { testDataLayout } from './routes/_test-helpers.js'
import { createIsolatedDb } from './store/db/test-helpers.js'

let tempDir: string

vi.mock('./config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  getDataDir: () => tempDir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
  DIST_WEB_APP_DIR: '/tmp/whiteboard/dist/web-app',
}))

const { createApp } = await import('./app.js')
const { getLogger } = await import('./log.js')

const MODERN = '2026-07-28'
const WORKSPACE = 'plans'

/**
 * Deps whose `listDocuments` — reached by `wb_document_list` — holds every
 * call once `arm()` has been called, until `release()`, having first logged a
 * record. A call that opted into in-call logging is sent that record before
 * its result, which is what turns its answer into an open event stream while
 * the tool is still held. `entered(n)` resolves once n calls are held.
 */
function gatedDeps() {
  const base = resolveServerDeps(createContainer(storeMemoryModule))
  let armed = false
  let held = 0
  const waiters: Array<{ n: number; resolve: () => void }> = []
  let release: () => void = () => {}
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  const index = base.documentIndex
  const documentIndex = new Proxy(index, {
    get(target, key, receiver) {
      if (key === 'listDocuments') {
        return async (input: Parameters<typeof index.listDocuments>[0]) => {
          if (armed) {
            getLogger('mcp-content-slot').warning('held in the tool')
            held += 1
            for (const w of waiters) if (held >= w.n) w.resolve()
            await released
          }
          return target.listDocuments(input)
        }
      }
      const value = Reflect.get(target, key, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const deps: ServerDeps = { ...base, documentIndex }
  const entered = (n: number) =>
    new Promise<void>((resolve) => {
      if (held >= n) resolve()
      else waiters.push({ n, resolve })
    })
  return {
    deps,
    arm: () => {
      armed = true
    },
    entered,
    release,
  }
}

let handle: Awaited<ReturnType<typeof createIsolatedDb>>
let gate: ReturnType<typeof gatedDeps>
let app: ReturnType<typeof createApp>

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'wb-server-mode-mcp-content-slot-'))
  handle = await createIsolatedDb({ dataDir: tempDir })
  const stores = serverModePeople(handle.db, tempDir)
  await stores.members.ensureProfile({
    binding: { authenticator: ISSUER, subject: 'ada' },
    displayName: 'ada',
  })
  gate = gatedDeps()
  const options: ServerModeAppOptions = {
    authMode: 'server-mode',
    publicBaseUrl: PUBLIC_URL,
    allowedOrigins: [PUBLIC_URL],
    authStrategy: bearerNamesItsSubject,
    serverDeps: gate.deps,
    dataLayout: testDataLayout(),
    people: stores.people,
    touch: () => {},
    getStatus: () => {
      throw new Error('not read by these routes')
    },
  }
  app = createApp(options)
})
afterEach(async () => {
  gate.release()
  await handle.dispose()
  await rm(tempDir, { recursive: true, force: true })
})

/**
 * A modern-era MCP client for `subject`. `answers` and `contentTypes` record
 * every `tools/call` POST's answer, in order, so a refusal is read off the
 * wire rather than off the client's error wording.
 */
async function modernClientOf(subject: string) {
  const answers: number[] = []
  const contentTypes: Array<string | null> = []
  const client = new Client({ name: `agent-${subject}`, version: '1' }, {
    versionNegotiation: { mode: { pin: MODERN } },
  } as never)
  const transport = new StreamableHTTPClientTransport(new URL(`${PUBLIC_URL}/mcp`), {
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers)
      headers.set('Authorization', `Bearer ${subject}`)
      const response = await app.request(input instanceof URL ? input.toString() : String(input), {
        ...init,
        headers,
      })
      if (typeof init?.body === 'string' && init.body.includes('"tools/call"')) {
        answers.push(response.status)
        contentTypes.push(response.headers.get('content-type'))
      }
      return response
    },
  })
  await client.connect(transport)
  return { client, answers, contentTypes, close: () => transport.close() }
}

/**
 * The HTTP status `send`'s `tools/call` was answered with, read off the wire
 * as soon as it arrives — a call let through is held in the tool, so waiting
 * for its result would hang rather than fail.
 */
async function answerTo(
  caller: Awaited<ReturnType<typeof modernClientOf>>,
  send: () => Promise<unknown>,
): Promise<number | undefined> {
  const before = caller.answers.length
  void send().catch(() => undefined)
  await vi.waitFor(() => expect(caller.answers.length).toBeGreaterThan(before))
  return caller.answers[before]
}

// Opted into in-call logging, so the record the gate logs is streamed to the
// caller before the result.
const listCall = {
  name: 'wb_document_list',
  arguments: { workspaceId: WORKSPACE },
  _meta: { 'io.modelcontextprotocol/logLevel': 'debug' },
}

async function adaWithWorkspace() {
  const ada = await modernClientOf('ada')
  const created = (await ada.client.callTool({
    name: 'wb_workspace_edit',
    arguments: {
      workspaceId: WORKSPACE,
      createWorkspace: true,
      ops: [{ op: 'document.create', path: 'notes', kind: 'markdown', markdown: 'hello' }],
    },
  })) as { isError?: boolean }
  expect(created.isError).toBeFalsy()
  return ada
}

/** `count` streamed list calls from `caller`, each held in the tool with its stream open. */
async function holding(caller: Awaited<ReturnType<typeof modernClientOf>>, count: number) {
  gate.arm()
  const answered = caller.answers.length
  const calls = Array.from({ length: count }, () =>
    caller.client.callTool(listCall).catch(() => 'gone' as const),
  )
  await gate.entered(count)
  // The premise rather than the fix: every held call's answer is an open
  // event stream, so the handler has already returned.
  await vi.waitFor(() => expect(caller.answers.slice(answered)).toEqual(Array(count).fill(200)))
  expect(caller.contentTypes.slice(answered)).toEqual(Array(count).fill('text/event-stream'))
  return calls
}

const MODERN_META = {
  'io.modelcontextprotocol/protocolVersion': MODERN,
  'io.modelcontextprotocol/clientInfo': { name: 'raw', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {},
}

/** A raw modern-era POST naming `method` in its `Mcp-Method` header, carrying `message`. */
function rawModern(subject: string, method: string, message: Record<string, unknown>) {
  return Promise.resolve(
    app.request(`${PUBLIC_URL}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${subject}`,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-method': method,
        'mcp-protocol-version': MODERN,
        ...(message.method === 'tools/call' ? { 'mcp-name': 'wb_document_list' } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...message }),
    }),
  )
}

const streamedListCall = {
  method: 'tools/call',
  params: { ...listCall, _meta: { ...listCall._meta, ...MODERN_META } },
}

const listen = {
  method: 'subscriptions/listen',
  params: { notifications: {}, _meta: MODERN_META },
}

describe('server mode — /mcp content slot over a modern-era stream', () => {
  it('holds the slot while a streamed tool call is still running', async () => {
    const ada = await adaWithWorkspace()
    try {
      const held = await holding(ada, CONTENT_REQUEST_CAPS.perUser)

      expect(await answerTo(ada, () => ada.client.callTool(listCall))).toBe(429)

      gate.release()
      for (const call of await Promise.all(held)) {
        expect((call as { isError?: boolean }).isError).toBeFalsy()
      }
      const after = (await ada.client.callTool(listCall)) as { isError?: boolean }
      expect(after.isError).toBeFalsy()
    } finally {
      await ada.close()
    }
  })

  it('frees the slot of a call whose client went away mid-stream', async () => {
    const ada = await adaWithWorkspace()
    gate.arm()
    // Raw calls whose streams nobody reads, cancelled the way the HTTP server
    // cancels a response whose client disconnected.
    const leavers = await Promise.all(
      Array.from({ length: CONTENT_REQUEST_CAPS.perUser }, () =>
        rawModern('ada', 'tools/call', streamedListCall),
      ),
    )
    try {
      await gate.entered(CONTENT_REQUEST_CAPS.perUser)
      for (const stream of leavers) {
        expect(stream.headers.get('content-type')).toContain('text/event-stream')
      }
      expect(await answerTo(ada, () => ada.client.callTool(listCall))).toBe(429)

      await Promise.all(leavers.map((stream) => stream.body?.cancel('client went away')))

      // The departed calls' tools are still held in the gate, so only their
      // streams ending can have freed these slots.
      const next = ada.client.callTool(listCall)
      await gate.entered(CONTENT_REQUEST_CAPS.perUser + 1)
      gate.release()
      expect(((await next) as { isError?: boolean }).isError).toBeFalsy()
    } finally {
      await ada.close()
    }
  })

  it('takes no slot for the life of a subscriptions/listen stream', async () => {
    const ada = await adaWithWorkspace()
    const streams = await Promise.all(
      Array.from({ length: CONTENT_REQUEST_CAPS.perUser }, () =>
        rawModern('ada', 'subscriptions/listen', listen),
      ),
    )
    try {
      for (const stream of streams) {
        expect(stream.status).toBe(200)
        expect(stream.headers.get('content-type')).toContain('text/event-stream')
      }
      const call = (await ada.client.callTool(listCall)) as { isError?: boolean }
      expect(call.isError).toBeFalsy()
    } finally {
      await Promise.all(streams.map((stream) => stream.body?.cancel()))
      await ada.close()
    }
  })

  it('refuses a tool call that names itself a listen, so the header cannot carry one past the cap', async () => {
    await adaWithWorkspace()
    const disguised = await rawModern('ada', 'subscriptions/listen', streamedListCall)
    expect(disguised.status).toBeGreaterThanOrEqual(400)
    expect(disguised.headers.get('content-type')).not.toContain('text/event-stream')
  })
})
