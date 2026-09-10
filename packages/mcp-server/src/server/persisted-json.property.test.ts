/**
 * Every JSON this package writes to disk or to a child's stdout is read back
 * through a Zod schema, and each schema is declared once — so the shapes
 * cannot drift at the TYPE level. What the type cannot see is a value the
 * writer produces that the schema's runtime checks refuse: a fractional
 * number under `.int()`, an origin the refinement will not accept, a field
 * `JSON.stringify` drops. Each reader here fails soft (empty store, `null`,
 * "not in progress"), so the drift would surface as data quietly going
 * missing rather than as an error anyone sees.
 *
 * So each pair is exercised end to end: a record drawn from the schema (or
 * from the writer's own input space, where the writer builds the record),
 * written by the production writer, read by the production reader, and
 * compared modulo JSON's own identities (`-0` is `0` once written).
 */
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { arbitraryForSchema } from '@kamiazya/whiteboard-model/test-utils'
import { afterAll, beforeAll, describe, expect } from 'vitest'
import { parseDaemonRecord } from '../daemon/daemon-record.js'
import { daemonRecordSchema } from '../daemon/daemon-record-schema.js'
import { loadDaemonRecord, saveDaemonRecord } from '../daemon/daemon-registry.js'
import { fc, fcTest, withDefaults } from '../shared/test-utils/fast-check.js'
import { createPairingGrantStore } from './security/pairing-grant-store.js'
import {
  readServerModeRecord,
  serverModeRecordSchema,
  writeServerModeRecord,
} from './security/server-mode-record.js'
import { mirrorBlobsIntoBackup, readBackupBlobManifest } from './store/backup-blob-mirror.js'
import { backupIsInProgress, withBackupMarker } from './store/backup-in-progress.js'
import { serverBackupResultSchema } from './store/backup-pass.js'
import { runBackupInSubprocess } from './store/backup-subprocess.js'
import {
  readDatabaseLocationRecord,
  writeDatabaseLocationRecord,
} from './store/db/location-record.js'
import { FsBlobStore } from './store/fs/fs-blob-store.js'

const viaJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value))

let root: string
let seq = 0
async function freshDir(label: string): Promise<string> {
  const dir = join(root, `${label}-${++seq}`)
  await mkdir(dir, { recursive: true })
  return dir
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'whiteboard-persisted-json-'))
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

/** ISO 8601 with a `Z` or an offset, with and without milliseconds, as the producers write it. */
const timestampArb = fc
  .tuple(
    fc.date({ min: new Date(0), max: new Date('2100-01-01T00:00:00Z'), noInvalidDate: true }),
    fc.constantFrom('Z', '+09:00', '-05:30'),
    fc.boolean(),
  )
  .map(([date, offset, millis]) => {
    const iso = date.toISOString()
    const base = millis ? iso.slice(0, -1) : iso.slice(0, 19)
    return `${base}${offset}`
  })

describe('the server-mode record', () => {
  const recordArb = arbitraryForSchema(serverModeRecordSchema, {
    override: (path) => (path === '$.startedAt' ? timestampArb : undefined),
  })

  fcTest.prop([recordArb], withDefaults({ numRuns: 100 }))(
    'reads back as what `server run` wrote',
    async (record) => {
      const dataDir = await freshDir('server-mode')
      writeServerModeRecord(dataDir, record)
      expect(readServerModeRecord(dataDir)).toEqual({ kind: 'ok', record: viaJson(record) })
    },
  )
})

describe('the daemon record', () => {
  const recordArb = arbitraryForSchema(daemonRecordSchema)

  fcTest.prop([recordArb], withDefaults({ numRuns: 100 }))(
    'reads back through both readers as what the daemon wrote',
    async (record) => {
      const dataDir = await freshDir('daemon')
      await saveDaemonRecord(record, dataDir)
      expect(await loadDaemonRecord(dataDir)).toEqual(viaJson(record))
      expect(await parseDaemonRecord(dataDir)).toEqual({ kind: 'valid', record: viaJson(record) })
    },
  )

  fcTest.prop([recordArb, fc.constantFrom('', undefined)], withDefaults({ numRuns: 40 }))(
    'is reported token-missing, with the rest intact, when the token is empty or absent',
    async (record, token) => {
      const dataDir = await freshDir('daemon-tokenless')
      const { token: _dropped, ...base } = record
      await saveDaemonRecord({ ...base, token: token as string }, dataDir)
      expect(await loadDaemonRecord(dataDir)).toBeNull()
      expect(await parseDaemonRecord(dataDir)).toEqual({
        kind: 'token-missing',
        record: viaJson(base),
      })
    },
  )
})

describe('the pairing grants file', () => {
  /** What a consent page can be asked for: any http(s) URL, at the spellings the origin refinement is strictest about. */
  const originInputArb = fc.oneof(
    { weight: 4, arbitrary: fc.webUrl() },
    {
      weight: 1,
      arbitrary: fc.constantFrom(
        'http://[::1]:3000/pair',
        'https://EXAMPLE.com:443/',
        'http://example.com:80/x?y#z',
        'http://müller.de/',
        'https://xn--mller-kva.de:8443',
        'http://localhost:3099',
        'http://127.0.0.1:1',
        'http://example.com./',
      ),
    },
  )

  fcTest.prop(
    [fc.array(originInputArb, { minLength: 1, maxLength: 6 }), fc.nat()],
    withDefaults({ numRuns: 100 }),
  )('lists after a restart exactly the grants it listed before', async (inputs, revokeSeed) => {
    const dataDir = await freshDir('grants')
    const store = createPairingGrantStore(dataDir)
    const granted = inputs.map((input) => store.addGrant(input))
    // A grant survives a restart, and a revocation does too.
    const revoked = granted[revokeSeed % granted.length]
    if (revoked !== undefined && revokeSeed % 2 === 0) store.revoke(revoked.grantId)

    const reopened = createPairingGrantStore(dataDir)
    expect(reopened.list()).toEqual(store.list())
    expect(reopened.origins()).toEqual(store.origins())
    for (const origin of reopened.origins()) {
      // The stored spelling is the canonical one, or the refinement rejects the whole file.
      expect(new URL(origin).origin).toBe(origin)
    }
    expect(new Set(reopened.origins()).size).toBe(reopened.origins().length)
  })
})

describe('the database location record', () => {
  fcTest.prop([fc.boolean()], withDefaults({ numRuns: 4 }))(
    'reads back what the store wrote',
    async (inDataDir) => {
      const dataDir = await freshDir('location')
      await writeDatabaseLocationRecord(dataDir, inDataDir)
      expect(await readDatabaseLocationRecord(dataDir)).toEqual({ inDataDir })
    },
  )
})

describe('the backup-in-progress marker', () => {
  /** Whole and fractional lifetimes: the option is a number, and the schema says `.int()`. */
  const ttlArb = fc.oneof(
    fc.integer({ min: 1, max: 600_000 }),
    fc.double({ min: 0.5, max: 600_000, noNaN: true, noDefaultInfinity: true }),
  )

  fcTest.prop([ttlArb], withDefaults({ numRuns: 60 }))(
    'is in progress for its whole lifetime and gone afterwards',
    async (ttlMs) => {
      const dataDir = await freshDir('marker')
      const before = Date.now()
      await withBackupMarker(
        dataDir,
        async () => {
          const afterWrite = Date.now()
          expect(await backupIsInProgress(dataDir, before)).toBe(true)
          // The writer rounds the deadline up to a whole millisecond.
          expect(await backupIsInProgress(dataDir, Math.ceil(afterWrite + ttlMs))).toBe(false)
        },
        { ttlMs, refreshEveryMs: 60_000 },
      )
      expect(await backupIsInProgress(dataDir)).toBe(false)
    },
  )
})

describe('the blob envelope', () => {
  fcTest.prop(
    [fc.uint8Array({ maxLength: 4096 }), fc.option(fc.string(), { nil: undefined })],
    withDefaults({ numRuns: 100 }),
  )('gives back the bytes and content type that were put', async (bytes, contentType) => {
    const store = new FsBlobStore(await freshDir('blobs'))
    const { ref } = await store.put({ bytes, contentType })
    expect(await store.put({ bytes, contentType })).toEqual({ ref })
    expect(await store.has({ ref })).toEqual({ exists: true })
    const got = await store.get({ ref })
    expect(got).not.toBeNull()
    expect(Buffer.from(got?.bytes ?? []).equals(Buffer.from(bytes))).toBe(true)
    expect(got?.contentType).toBe(contentType)
  })
})

describe('the blob manifest', () => {
  fcTest.prop(
    [
      fc.array(fc.uint8Array({ minLength: 1, maxLength: 64 }), { maxLength: 6 }),
      fc.constantFrom('self', 'parent'),
    ],
    withDefaults({ numRuns: 40 }),
  )('records exactly the blobs the mirror found', async (blobs, mirror) => {
    const dataDir = await freshDir('mirror-src')
    const store = new FsBlobStore(dataDir)
    const digests = new Set<string>()
    for (const bytes of blobs) digests.add((await store.put({ bytes })).ref.digestHex)

    const backupDir = join(await freshDir('mirror-dst'), 'backup')
    const backupRoot = mirror === 'self' ? backupDir : dirname(backupDir)
    const references = await mirrorBlobsIntoBackup(dataDir, backupRoot, {
      manifestInto: backupDir,
      mirror,
    })
    expect(references).toEqual({ blobs: digests, files: {}, mirror })
    expect(await readBackupBlobManifest(backupDir)).toEqual(references)
  })
})

describe('the backup result', () => {
  const resultArb = arbitraryForSchema(serverBackupResultSchema)

  function childPrinting(stdout: string, stderr: string) {
    return () => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: Readable
        stderr: Readable
        kill: () => boolean
      }
      child.stdout = Readable.from([stdout])
      child.stderr = Readable.from([stderr])
      child.kill = () => true
      queueMicrotask(() => setTimeout(() => child.emit('close', 0), 0))
      return child
    }
  }

  fcTest.prop([resultArb, fc.string({ maxLength: 40 })], withDefaults({ numRuns: 60 }))(
    'crosses the process boundary the way the CLI prints it',
    async (result, note) => {
      const outcome = await runBackupInSubprocess({
        dataDir: '/data',
        outputDir: '/out',
        env: {},
        // `writeJsonObject` is one object and a newline; the note about a
        // store the product does not cover goes to stderr beside it.
        spawnBackup: childPrinting(`${JSON.stringify(result)}\n`, note),
      })
      expect(outcome).toEqual({ kind: 'ok', result: viaJson(result) })
    },
  )
})
