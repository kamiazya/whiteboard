import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from 'vitest'
import { readProcessStartMs } from '../shared/process-identity.js'
import { CAN_DENY_FILE_READ } from '../shared/test-utils/can-deny-file-read.js'
import { answeringDaemonSocket } from './_test-daemon-socket.js'
import type { DaemonRecordWrite } from './daemon-record-schema.js'
import {
  deleteDaemonRecord,
  getDaemonRecordPath,
  loadDaemonRecord,
  saveDaemonRecord,
} from './daemon-registry.js'

// ESRCH on every platform: no pid is this large.
const DEAD_PID = 999_999_999
// A fake pid's liveness is the double's, never a real process's under that number.
const gone = { isAlive: () => false }

describe('daemon-registry', () => {
  let dataDir: string

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'excalidraw-daemon-registry-'))
  })

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true })
  })

  it('saves and loads daemon.json records', async () => {
    await saveDaemonRecord(
      {
        pid: 123,
        socketPath: '/run/user/1000/whiteboard/d.sock',
        token: 'secret',
        version: '0.1.0',
        startedAt: '2026-04-23T00:00:00.000Z',
        launch: 'built',
      },
      dataDir,
    )

    await expect(loadDaemonRecord(dataDir, gone)).resolves.toEqual({
      record: {
        pid: 123,
        socketPath: '/run/user/1000/whiteboard/d.sock',
        token: 'secret',
        version: '0.1.0',
        startedAt: '2026-04-23T00:00:00.000Z',
        launch: 'built',
      },
      liveness: { state: 'dead' },
    })
  })

  it('loads a record written before launch existed, with no launch', async () => {
    // Written directly: saveDaemonRecord takes no record without its launch,
    // but a daemon still running from before the field existed left one.
    const legacy = {
      pid: 123,
      socketPath: '/run/user/1000/whiteboard/d.sock',
      token: 'secret',
      version: '0.1.0',
      startedAt: '2026-04-23T00:00:00.000Z',
    }
    await writeFile(getDaemonRecordPath(dataDir), JSON.stringify(legacy))
    const loaded = await loadDaemonRecord(dataDir, gone)
    expect(loaded?.record).toEqual(legacy)
    expect(loaded?.record).not.toHaveProperty('launch')
  })

  it.skipIf(!CAN_DENY_FILE_READ)(
    'throws for a daemon.json it cannot READ, rather than answering none is running',
    async () => {
      // A caller reads null as "none running" and starts a new daemon under a
      // fresh record. For a record that was merely unreadable, that orphans
      // the daemon that is still running under it.
      await saveDaemonRecord(
        {
          pid: 123,
          socketPath: '/run/user/1000/whiteboard/d.sock',
          token: 'secret',
          version: '0.1.0',
          startedAt: '2026-04-23T00:00:00.000Z',
          launch: 'source',
        },
        dataDir,
      )
      const path = getDaemonRecordPath(dataDir)
      await chmod(path, 0o000)
      try {
        await expect(loadDaemonRecord(dataDir)).rejects.toThrow(/daemon\.json|daemon record/i)
      } finally {
        await chmod(path, 0o600)
      }
    },
  )

  // The dev wrapper reads a record without `launch` as watch-mode source, so
  // only a reader may meet one: the writer's own signature refuses it.
  it('takes only a record that states its launch', () => {
    expectTypeOf(saveDaemonRecord).parameter(0).toEqualTypeOf<DaemonRecordWrite>()
  })

  it('returns null when there is no daemon.json at all', async () => {
    await expect(loadDaemonRecord(dataDir)).resolves.toBeNull()
  })

  it('returns null for malformed daemon.json content', async () => {
    await writeFile(getDaemonRecordPath(dataDir), '{"pid":"oops"}')
    await expect(loadDaemonRecord(dataDir)).resolves.toBeNull()
  })

  it('returns null for a daemon.json with an empty-string token (fail-closed)', async () => {
    await writeFile(
      getDaemonRecordPath(dataDir),
      JSON.stringify({
        pid: DEAD_PID,
        socketPath: '/run/user/1000/whiteboard/d.sock',
        token: '',
        version: '0.1.0',
        startedAt: '2026-04-23T00:00:00.000Z',
      }),
    )
    await expect(loadDaemonRecord(dataDir)).resolves.toBeNull()
  })

  it('returns null for a daemon.json with a missing token', async () => {
    await writeFile(
      getDaemonRecordPath(dataDir),
      JSON.stringify({
        pid: DEAD_PID,
        socketPath: '/run/user/1000/whiteboard/d.sock',
        version: '0.1.0',
        startedAt: '2026-04-23T00:00:00.000Z',
      }),
    )
    await expect(loadDaemonRecord(dataDir)).resolves.toBeNull()
  })

  it('returns null for a record it cannot interpret whose process is gone', async () => {
    await writeFile(
      getDaemonRecordPath(dataDir),
      JSON.stringify({
        pid: DEAD_PID,
        socketPath: '/run/user/1000/whiteboard/d.sock',
        token: 7,
        version: '9.0.0',
      }),
    )
    await expect(loadDaemonRecord(dataDir)).resolves.toBeNull()
  })

  it('throws for a record it cannot interpret whose process is still running', async () => {
    // Likeliest from ANOTHER version's daemon. Read as none, a caller would
    // delete it and start a second daemon beside the one still serving.
    await writeFile(
      getDaemonRecordPath(dataDir),
      JSON.stringify({
        pid: process.pid,
        socketPath: '/run/user/1000/whiteboard/d.sock',
        token: 7,
        version: '9.0.0',
      }),
    )
    await expect(loadDaemonRecord(dataDir)).rejects.toThrow(
      new RegExp(`daemon record .* \\(pid ${process.pid}\\) is still running`),
    )
  })

  it('throws for a record with no token whose process is running, blaming the token', async () => {
    await writeFile(
      getDaemonRecordPath(dataDir),
      JSON.stringify({
        pid: process.pid,
        socketPath: '/run/user/1000/whiteboard/d.sock',
        version: '0.1.0',
        startedAt: new Date().toISOString(),
      }),
    )
    const refused = loadDaemonRecord(dataDir)
    await expect(refused).rejects.toThrow(/carries no token/)
    await expect(refused).rejects.not.toThrow(/this version/)
  })

  it("asks liveness through the caller's seams", async () => {
    await writeFile(
      getDaemonRecordPath(dataDir),
      JSON.stringify({
        pid: DEAD_PID,
        socketPath: join(dataDir, 'x.sock'),
        token: 7,
        version: '9.0.0',
      }),
    )
    await expect(
      loadDaemonRecord(dataDir, { isAlive: () => true, startMs: () => null }),
    ).rejects.toThrow(new RegExp(`\\(pid ${DEAD_PID}\\) is still running`))
  })

  // A record dated before its pid's process started was written by a daemon
  // that died: the pid now belongs to whatever took it, and nothing answers
  // on the record's socket.
  it.skipIf(readProcessStartMs(process.pid) === null)(
    'returns null for a record it cannot interpret whose pid a later process took',
    async () => {
      await writeFile(
        getDaemonRecordPath(dataDir),
        JSON.stringify({
          pid: process.pid,
          socketPath: join(dataDir, 'nobody.sock'),
          startedAt: '2024-01-01T00:00:00.000Z',
          token: 7,
          version: '9.0.0',
        }),
      )
      await expect(loadDaemonRecord(dataDir)).resolves.toBeNull()
    },
  )

  it.skipIf(readProcessStartMs(process.pid) === null)(
    'throws for a record it cannot interpret while a process holds its socket',
    async () => {
      const daemon = await answeringDaemonSocket(process.pid + 1, 'tok')
      await writeFile(
        getDaemonRecordPath(dataDir),
        JSON.stringify({
          pid: process.pid,
          socketPath: daemon.socketPath,
          startedAt: '2024-01-01T00:00:00.000Z',
          token: 7,
          version: '9.0.0',
        }),
      )
      // The record's token is not a string, so the socket refuses the ask and
      // names no pid: nothing there is known to be a daemon answering.
      const refused = loadDaemonRecord(dataDir)
      await expect(refused).rejects.toThrow(
        `a process holds its socket ${daemon.socketPath} but did not confirm it is pid ${process.pid}`,
      )
      await expect(refused).rejects.not.toThrow(/answers/)
    },
  )

  it('writes atomically via a temp file that does not remain afterwards', async () => {
    await saveDaemonRecord(
      {
        pid: 321,
        socketPath: '/run/user/1000/whiteboard/d.sock',
        token: 'abc',
        version: '0.2.0',
        startedAt: '2026-04-23T00:00:00.000Z',
        launch: 'source',
      },
      dataDir,
    )

    const contents = await readFile(getDaemonRecordPath(dataDir), 'utf-8')
    expect(JSON.parse(contents)).toMatchObject({
      pid: 321,
      socketPath: '/run/user/1000/whiteboard/d.sock',
    })
    await expect(readFile(`${getDaemonRecordPath(dataDir)}.tmp`, 'utf-8')).rejects.toThrow()
  })

  it('deletes daemon.json if present', async () => {
    await saveDaemonRecord(
      {
        pid: 1,
        socketPath: '/run/user/1000/whiteboard/d.sock',
        token: 't',
        version: 'v',
        startedAt: '2026-04-23T00:00:00.000Z',
        launch: 'source',
      },
      dataDir,
    )

    await deleteDaemonRecord(dataDir)
    await expect(loadDaemonRecord(dataDir)).resolves.toBeNull()
  })
})
