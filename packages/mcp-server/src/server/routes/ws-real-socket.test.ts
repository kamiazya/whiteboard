// Regression test for tmp/issues/ws-real-socket-e2e-needs-injectable-data-dir.md:
// exercises a REAL WebSocketServer + real `ws` client (not the FakeWebSocket
// used elsewhere in ws.test.ts) so a Loro binary update travels over an
// actual loopback TCP socket into saveDocument's real filesystem write path.
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

import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoroDoc, LoroMap } from 'loro-crdt'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

// Seed a real, writable fake home dir synchronously, before the
// `await import('../../shared/data-dir-secure.js')` below can run.
// data-dir-secure.ts resolves a module-load-time `DATA_DIR` constant via
// `resolveDataDir()` as a side effect of being imported, and at that point
// `beforeEach` has not run yet, so the mocked homedir() would still return
// the initial `''`. `resolveDataDir` would then resolve `'.whiteboard'`
// against the process cwd (the checkout) and canWriteDir's mkdirSync would
// actually create it there — a leak the final assertion never inspects
// because it only checks this test's per-test fakeHomeDir.
const initialFakeHomeDir = mkdtempSync(join(tmpdir(), 'whiteboard-ws-real-socket-fake-home-init-'))
setFakeHomeDir(initialFakeHomeDir)

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
const { loadDocument, saveDocument } = await import('../store/document-store.js')
const { handleWsUpgrade, setOnPersistedForTests } = await import('./ws.js')

// Snapshot of initialFakeHomeDir's contents immediately after the
// data-dir-secure import above resolves its module-load DATA_DIR (the only
// expected write: canWriteDir's eager `mkdirSync` of `.whiteboard`). Any
// code path that still reads the frozen module-load DATA_DIR instead of the
// getDataDir() seam would write here too, but the final fakeHomeDir
// assertion alone can't see it — comparing this snapshot against the same
// listing in afterAll closes that gap. `recursive: true` is required: a
// leaking write lands *inside* `.whiteboard` (e.g. `.whiteboard/whiteboard.db`
// or `.whiteboard/blobs/...`), which a non-recursive listing of
// initialFakeHomeDir would never see since `.whiteboard` itself is expected
// to already exist in both snapshots.
const initialFakeHomeDirSnapshotAfterModuleLoad = readdirSync(initialFakeHomeDir, {
  recursive: true,
}).sort()

// Starts a real HTTP + WebSocket server bound to an ephemeral loopback port
// and wired to handleWsUpgrade, resolving once it is listening.
function startWsServer(): Promise<{ server: Server; wss: WebSocketServer; port: number }> {
  const server = createServer()
  const wss = new WebSocketServer({ server })
  wss.on('connection', (ws, req) => {
    void handleWsUpgrade(req, ws)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        throw new Error('expected server to bind to a TCP port')
      }
      resolve({ server, wss, port: address.port })
    })
  })
}

function closeWsServer(server: Server, wss: WebSocketServer): Promise<void> {
  wss.close()
  return new Promise((resolve) => server.close(() => resolve()))
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

// How long to wait for the WS persistence path to signal completion before
// failing with a clear diagnostic instead of hanging until Vitest's global
// test timeout (which reports no information about which (workspaceId, path)
// never arrived).
const PERSISTED_SIGNAL_TIMEOUT_MS = 5_000

// Resolves once the WS persistence path signals it has finished saving for
// this exact (workspaceId, path) — a deterministic completion event instead
// of polling loadDocument() until an expectation happens to pass. Rejects if
// that signal never arrives within PERSISTED_SIGNAL_TIMEOUT_MS (e.g.
// saveDocument throws, or a regression changes/drops the callback args), so a
// broken persistence path fails fast with a clear message instead of hanging.
function waitForPersisted(workspaceId: string, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      setOnPersistedForTests(undefined)
      reject(
        new Error(
          `waitForPersisted timed out after ${PERSISTED_SIGNAL_TIMEOUT_MS}ms waiting for ` +
            `(workspaceId=${workspaceId}, path=${path}) to persist`,
        ),
      )
    }, PERSISTED_SIGNAL_TIMEOUT_MS)

    setOnPersistedForTests((persistedWorkspaceId, persistedPath) => {
      if (persistedWorkspaceId === workspaceId && persistedPath === path) {
        clearTimeout(timer)
        setOnPersistedForTests(undefined)
        resolve()
      }
    })
  })
}

describe('handleWsUpgrade over a real WebSocketServer + real ws client', () => {
  afterAll(async () => {
    // Nothing wrote to initialFakeHomeDir beyond the eager module-load
    // creation captured above, across the whole suite — a stronger check
    // than the fakeHomeDir-only assertion below, which never inspects this
    // directory. Recursive listing so a leak nested under `.whiteboard`
    // (rather than a new direct child of initialFakeHomeDir) is caught too.
    expect(readdirSync(initialFakeHomeDir, { recursive: true }).sort()).toEqual(
      initialFakeHomeDirSnapshotAfterModuleLoad,
    )
    await rm(initialFakeHomeDir, { recursive: true, force: true })
  })

  beforeEach(async () => {
    fakeHomeDir = await mkdtemp(join(tmpdir(), 'whiteboard-ws-real-socket-fake-home-'))
    setFakeHomeDir(fakeHomeDir)
    scratchDir = await mkdtemp(join(tmpdir(), 'whiteboard-ws-real-socket-'))
    await mkdir(join(scratchDir, 'session1'), { recursive: true })
    setDataDirForTests(scratchDir)
    // A connect requires a REGISTERED workspace (an unregistered one is
    // refused 4404 instead of served a phantom) — the shape production
    // always has, since a canvas is created before any tab opens it.
    await saveDocument('session1', 'registered-seed', new LoroDoc())
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
    const { server, wss, port } = await startWsServer()

    const { ws: client, snapshot } = await connectAndCaptureSnapshot(
      `ws://127.0.0.1:${port}/ws/session1/canvas-a`,
    )
    try {
      // First frame off the wire is always the initial snapshot; wait for
      // it before sending an update so the client doc's version vector is
      // based on the server's starting state.
      const snapshotBytes = await snapshot
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

      const saved = await loadDocument('session1', 'canvas-a')
      const elements = saved.getMovableList('elements').toJSON() as Array<{ id: string }>
      expect(elements.map((entry) => entry.id)).toContain('real-socket-elem')
    } finally {
      client.close()
      await closeWsServer(server, wss)
    }

    // Persistence landed under the injected scratch dir: the sqlite db file,
    // plus a real Libsql snapshot row for the canvas the socket wrote to
    // (content lives in the db now, not a separate blob artifact tree).
    expect(existsSync(join(scratchDir, 'whiteboard.db'))).toBe(true)
    const { getDb } = await import('../store/db/index.js')
    const { getDocumentIdByPath } = await import('../store/db/upsert-workspace.js')
    const db = await getDb(scratchDir)
    const documentId = await getDocumentIdByPath(db, 'session1', 'canvas-a')
    expect(documentId).not.toBeNull()
    const snapshotRow = await db
      .selectFrom('documentSnapshots')
      .select(['docKey'])
      .where('docKey', '=', 'workspace-tree:session1')
      .executeTakeFirst()
    expect(snapshotRow).toBeDefined()

    // Nothing wrote to the (fake, per-test) home dir. No concurrent process
    // can perturb this directory the way the real ~/.whiteboard can.
    expect(existsSync(join(fakeHomeDir, '.whiteboard'))).toBe(false)
  })

  it('closes only the offending socket with 1003 on a malformed binary frame while the daemon and concurrent connections survive', async () => {
    const { server, wss, port } = await startWsServer()

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
      const saved = await loadDocument('session1', 'canvas-a')
      const elements = saved.getMovableList('elements').toJSON() as Array<{ id: string }>
      expect(elements.map((entry) => entry.id)).toEqual(['survivor-elem'])
    } finally {
      clientA.close()
      clientB.close()
      await closeWsServer(server, wss)
    }
  })
})
