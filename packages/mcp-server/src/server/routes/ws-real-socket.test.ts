// Regression test for tmp/issues/ws-real-socket-e2e-needs-injectable-data-dir.md:
// exercises a REAL WebSocketServer + real `ws` client (not the FakeWebSocket
// used elsewhere in ws.test.ts) so a Loro binary update travels over an
// actual loopback TCP socket into saveCanvas's real filesystem write path.
// DATA_DIR is redirected via the getDataDir() test-injection seam
// (setDataDirForTests) instead of a hand-rolled per-file mock, proving the
// seam is sufficient to keep a real-socket persistence test off the
// developer's real home directory.

import { existsSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoroDoc, LoroMap } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'

let scratchDir: string

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
const { handleWsUpgrade } = await import('./ws.js')

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

describe('handleWsUpgrade over a real WebSocketServer + real ws client', () => {
  const realHomeWhiteboard = join(homedir(), '.whiteboard')
  let realHomeStatBefore: ReturnType<typeof statSync> | undefined

  beforeEach(async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'whiteboard-ws-real-socket-'))
    await mkdir(join(scratchDir, 'session1'), { recursive: true })
    setDataDirForTests(scratchDir)
    clearCache()
    realHomeStatBefore = existsSync(realHomeWhiteboard) ? statSync(realHomeWhiteboard) : undefined
  })

  afterEach(async () => {
    resetDataDirForTests()
    clearCache()
    await rm(scratchDir, { recursive: true, force: true })
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
      client.send(update)

      // saveCanvas is awaited inside the message handler; poll briefly for
      // the write to land instead of pinning to a specific timeout value.
      await vi.waitFor(async () => {
        const saved = await loadCanvas('session1', 'canvas-a')
        const elements = saved.getMovableList('elements').toJSON() as Array<{ id: string }>
        expect(elements.map((entry) => entry.id)).toContain('real-socket-elem')
      })
    } finally {
      client.close()
      wss.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }

    // Persistence landed under the injected scratch dir, not the real home.
    expect(existsSync(join(scratchDir, 'whiteboard.db'))).toBe(true)
    const realHomeStatAfter = existsSync(realHomeWhiteboard)
      ? statSync(realHomeWhiteboard)
      : undefined
    expect(realHomeStatAfter?.mtimeMs).toBe(realHomeStatBefore?.mtimeMs)
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
      clientB.send(update)

      await vi.waitFor(async () => {
        const saved = await loadCanvas('session1', 'canvas-a')
        const elements = saved.getMovableList('elements').toJSON() as Array<{ id: string }>
        expect(elements.map((entry) => entry.id)).toContain('survivor-elem')
      })

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
