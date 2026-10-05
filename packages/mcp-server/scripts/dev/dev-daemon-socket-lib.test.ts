import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { arbitraryForSchema } from '@kamiazya/whiteboard-model/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { daemonRecordSchema } from '../../src/daemon/daemon-record-schema.js'
import { isPidAlive as daemonIsPidAlive } from '../../src/shared/process-alive.js'
import { fc, fcTest, withDefaults } from '../../src/shared/test-utils/fast-check.js'
import { isPidAlive, readDaemonRecord } from './dev-daemon-socket-lib.mjs'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function dataDirWith(contents: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-socket-lib-'))
  dirs.push(dir)
  if (contents !== null) writeFileSync(join(dir, 'daemon.json'), contents)
  return dir
}

// The dev scripts cannot import `daemonRecordSchema` (they run under bare node
// before any build), so the reader restates the two fields they act on. This
// holds the restatement to the schema: whatever the daemon can write, the
// reader accepts.
describe('readDaemonRecord against the daemon record schema', () => {
  fcTest.prop([arbitraryForSchema(daemonRecordSchema)], withDefaults({ numRuns: 50 }))(
    'accepts every record the daemon can write, unchanged',
    (record) => {
      expect(readDaemonRecord(dataDirWith(JSON.stringify(record)))).toEqual(record)
    },
  )

  fcTest.prop(
    [arbitraryForSchema(daemonRecordSchema), fc.constantFrom('pid', 'socketPath')],
    withDefaults({ numRuns: 30 }),
  )('refuses a record missing a field the scripts act on', (record, field) => {
    const { [field as 'pid' | 'socketPath']: _dropped, ...rest } = record
    expect(readDaemonRecord(dataDirWith(JSON.stringify(rest)))).toBeNull()
  })

  it('refuses the shape of the old port-based record, and what is not a record', () => {
    expect(
      readDaemonRecord(dataDirWith(JSON.stringify({ port: 4000, token: 't', pid: 1 }))),
    ).toBeNull()
    expect(readDaemonRecord(dataDirWith(JSON.stringify({ pid: 1, socketPath: '' })))).toBeNull()
    expect(readDaemonRecord(dataDirWith(JSON.stringify({ pid: 0, socketPath: '/s' })))).toBeNull()
    expect(readDaemonRecord(dataDirWith('[]'))).toBeNull()
    expect(readDaemonRecord(dataDirWith('{not json'))).toBeNull()
    expect(readDaemonRecord(dataDirWith(null))).toBeNull()
  })
})

// The dev wrapper refuses to start beside a live record by the same rule
// `whiteboard daemon run` does, so the two liveness checks must agree — on a
// running pid, a reaped one, and the pids that address a process GROUP.
describe("isPidAlive against the daemon's own", () => {
  it('gives the same answer for every kind of pid', () => {
    const reaped = spawnSync(process.execPath, ['-e', '']).pid
    const pids = [process.pid, process.ppid, reaped, 0, -1, -process.pid, Number.NaN, Infinity]
    expect(pids.map(isPidAlive)).toEqual(pids.map(daemonIsPidAlive))
    expect(isPidAlive(process.pid)).toBe(true)
    expect(isPidAlive(0)).toBe(false)
  })
})
