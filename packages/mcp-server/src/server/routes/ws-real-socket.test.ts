// Regression test for tmp/issues/ws-real-socket-e2e-needs-injectable-data-dir.md:
// exercises a REAL WebSocketServer + real `ws` client (not the FakeWebSocket
// used elsewhere in ws.test.ts) so a Loro binary update travels over an
// actual loopback TCP socket into saveCanvas's real filesystem write path.
// DATA_DIR is redirected via the getDataDir() test-injection seam
// (setDataDirForTests) instead of a hand-rolled per-file mock, proving the
// seam is sufficient to keep a real-socket persistence test off the
// developer's real home directory.
//
// Home-dir isolation is asserted against a mocked, per-test fake home
// directory rather than statSync(realHome).mtimeMs. Directory mtime changes
// whenever ANY process (a parallel test worker, an unrelated tool) adds or
// removes a direct child of the real home, so sampling it before/after and
// asserting equality is a race against every other process on the machine,
// not a property of this test's own behavior. Mocking `node:os`'s homedir()
// to a scratch directory this test alone controls makes the check immune to
// concurrent writers while staying at least as strong: any in-process code
// path that resolves the home dir directly (bypassing the getDataDir() seam)
// would still visibly create a `.whiteboard` directory under the fake home.

import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoroDoc, LoroMap } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'

let scratchDir: string
let fakeHomeDir: string

const { getFakeHomeDir, setFakeHomeDir } = vi.hoisted(() => {
  let dir = ''
  return {
    getFakeHomeDir: (): string => dir,
    setFakeHomeDir: (next: string): void => {
      dir = next
    },
  }
})

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return {
    ...actual,
    homedir: () => getFakeHomeDir(),
  }
})

vi.mock('../config.js', async () => {
  const actual = await import('../../shared/data-dir-secure.js')
  return {
    get DATA_DIR() {
      return actual.getDataDir()
    },
    getDataDir: actual.getDataDir,
    setDataDirForTests: actual.setDataDirForTests,
    resetDataDirForTests: actual.resetDataDirForTests,
    WHITEBOARD_ROOT: '/tmp/whiteboard',
    REPO_ROOT: '/tmp',
  }
})

const { setDataDirForTests, resetDataDirForTests } = await import('../../shared/data-dir-secure.js')
const { clearCache } = await import('../store/doc-cache.js')
const { loadCanvas } = await import('../store/canvas-store.js')
const { handleWsUpgrade, setOnPersistedForTests } = await import('./ws.js')

function connectAndWaitForOpen(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

// Attaches the message listener at socket-creation time, not after `open`
// resolves. With two connections opened sequentially, the first one's
// initial snapshot frame can already have arrived (and be dropped, since
// `ws`'s 'message' event has no listener-less buffering) by the time the
// caller gets around to registering a `.once('message', ...)` for it.
function connectAndCaptureSnapshot(
  url: string,
): Promise<{ ws: WebSocket; snapshot: Promise<Buffer> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const snapshot = new Promise<Buffer>((resolveSnapshot) => {
      ws.once('message', (data: Buffer) => resolveSnapshot(data))
    })
    ws.once('open', () => resolve({ ws, snapshot }))
    ws.once('error', reject)
  })
}

// Resolves once the WS persistence path signals it has finished saving for
// this exact (workspaceId, slug) — a deterministic completion event instead
// of polling loadCanvas() until an expectation happens to pass.
function waitForPersisted(workspaceId: string, slug: string): Promise<void> {
  return new Promise((resolve) => {
    setOnPersistedForTests((persistedWorkspaceId, persistedSlug) => {
      if (persistedWorkspaceId === workspaceId && persistedSlug === slug) {
        setOnPersistedForTests(undefined)
        resolve()
      }
    })
  })
}

describe('handleWsUpgrade over a real WebSocketServer + real ws client', () => {
  beforeEach(async () => {
    fakeHomeDir = await mkdtemp(join(tmpdir(), 'whiteboard-ws-real-socket-fake-home-'))
    setFakeHomeDir(fakeHomeDir)
    scratchDir = await mkdtemp(join(tmpdir(), 'whiteboard-ws-real-socket-'))
    await mkdir(join(scratchDir, 'session1'), { recursive: true })
    setDataDirForTests(scratchDir)
    clearCache()
  })

  afterEach(async () => {
    resetDataDirForTests()
    clearCache()
    setOnPersistedForTests(undefined)
    await rm(scratchDir, { recursive: true, force: true })
    await rm(fakeHomeDir, { recursive: true, force: true })
  })

  it('persists a binary Loro update under the injected scratch dir and never touches the real home dir', async () => {
    const server = createServer()
    const wss = new WebSocketServer({ server })
    wss.on('connection', (ws, req) => {
      void handleWsUpgrade(req, ws)
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') {
      throw new Error('expected server to bind to a TCP port')
    }
    const { port } = address

    const client = await connectAndWaitForOpen(`ws://127.0.0.1:${port}/ws/session1/canvas-a`)
    try {
      // First frame off the wire is always the initial snapshot; wait for
      // it before sending an update so the client doc's version vector is
      // based on the server's starting state.
      const snapshotBytes = await new Promise<Buffer>((resolve) => {
        client.once('message', (data: Buffer) => resolve(data))
      })
      const serverDoc = new LoroDoc()
      serverDoc.import(new Uint8Array(snapshotBytes))
      const prevVV = serverDoc.version()

      const clientDoc = new LoroDoc()
      clientDoc.import(new Uint8Array(snapshotBytes))
      const list = clientDoc.getMovableList('elements')
      const map = list.insertContainer(0, new LoroMap())
      map.set('id', 'real-socket-elem')
      map.set('type', 'rectangle')
      clientDoc.commit()

      const update = Buffer.from(clientDoc.export({ mode: 'update', from: prevVV }) as Uint8Array)
      const persisted = waitForPersisted('session1', 'canvas-a')
      client.send(update)
      await persisted

      const saved = await loadCanvas('session1', 'canvas-a')
      const elements = saved.getMovableList('elements').toJSON() as Array<{ id: string }>
      expect(elements.map((entry) => entry.id)).toContain('real-socket-elem')
    } finally {
      client.close()
      wss.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }

    // Persistence landed under the injected scratch dir: the sqlite db plus
    // the canvas blob artifact tree, not just the top-level file.
    expect(existsSync(join(scratchDir, 'whiteboard.db'))).toBe(true)
    const blobDir = join(scratchDir, 'blobs', 'session1', 'canvas')
    expect(existsSync(blobDir)).toBe(true)
    const blobFiles = await readdir(blobDir)
    expect(blobFiles.length).toBeGreaterThan(0)

    // Nothing wrote to the (fake, per-test) home dir. No concurrent process
    // can perturb this directory the way the real ~/.whiteboard can.
    expect(existsSync(join(fakeHomeDir, '.whiteboard'))).toBe(false)
  })

  it('closes only the offending socket with 1003 on a malformed binary frame while the daemon and concurrent connections survive', async () => {
    const server = createServer()
    const wss = new WebSocketServer({ server })
    wss.on('connection', (ws, req) => {
      void handleWsUpgrade(req, ws)
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') {
      throw new Error('expected server to bind to a TCP port')
    }
    const { port } = address

    const { ws: clientA, snapshot: snapshotA } = await connectAndCaptureSnapshot(
      `ws://127.0.0.1:${port}/ws/session1/canvas-a`,
    )
    const { ws: clientB, snapshot: snapshotB } = await connectAndCaptureSnapshot(
      `ws://127.0.0.1:${port}/ws/session1/canvas-a`,
    )
    try {
      // Drain each client's initial snapshot frame before sending anything else.
      await snapshotA
      const snapshotBytesB = await snapshotB

      const closeEvent = new Promise<{ code: number; reason: string }>((resolve) => {
        clientA.once('close', (code, reasonBuf) => resolve({ code, reason: reasonBuf.toString() }))
      })

      // Not a valid Loro update — Loro's decoder should reject this outright.
      clientA.send(Buffer.from([1, 2, 3]))

      const { code, reason } = await closeEvent
      expect(code).toBe(1003)
      expect(reason).toBe('Malformed canvas update')

      // The daemon and the concurrent connection must survive the bad frame.
      expect(clientB.readyState).toBe(WebSocket.OPEN)

      const clientDoc = new LoroDoc()
      clientDoc.import(new Uint8Array(snapshotBytesB))
      const prevVV = clientDoc.version()
      const list = clientDoc.getMovableList('elements')
      const map = list.insertContainer(0, new LoroMap())
      map.set('id', 'survivor-elem')
      map.set('type', 'rectangle')
      clientDoc.commit()
      const update = Buffer.from(clientDoc.export({ mode: 'update', from: prevVV }) as Uint8Array)
      const persisted = waitForPersisted('session1', 'canvas-a')
      clientB.send(update)
      await persisted

      // Only B's element made it to disk; A's malformed bytes never
      // decoded into anything that could be persisted.
      const saved = await loadCanvas('session1', 'canvas-a')
      const elements = saved.getMovableList('elements').toJSON() as Array<{ id: string }>
      expect(elements.map((entry) => entry.id)).toEqual(['survivor-elem'])
    } finally {
      clientA.close()
      clientB.close()
      wss.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
