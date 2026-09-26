import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CAN_DENY_FILE_READ } from '../../shared/test-utils/can-deny-file-read.js'
import { captureLogsForTests, getLogger } from '../log.js'
import { mintMacaroon, verifyMacaroon } from './macaroon.js'
import { createMacaroonRootKey } from './macaroon-root-key.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wb-macaroon-root-key-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const filepath = () => join(dir, 'macaroon-root-key.json')

describe('createMacaroonRootKey', () => {
  it('generates a persisted 32-byte key, owner-only, on first start', () => {
    const { rootKey } = createMacaroonRootKey({ dataDir: dir })

    expect(rootKey).toHaveLength(32)
    expect(statSync(filepath()).mode & 0o777).toBe(0o600)
  })

  it.skipIf(!CAN_DENY_FILE_READ)(
    'refuses to start on a root key it cannot READ, rather than replacing it',
    () => {
      // A replaced root key silently invalidates every macaroon issued
      // under the old one; only a key that is truly absent may be minted.
      createMacaroonRootKey({ dataDir: dir })
      const before = readFileSync(filepath(), 'utf8')
      chmodSync(filepath(), 0o000)
      try {
        expect(() => createMacaroonRootKey({ dataDir: dir })).toThrow()
      } finally {
        chmodSync(filepath(), 0o600)
      }
      expect(readFileSync(filepath(), 'utf8')).toBe(before)
    },
  )

  it('reloads the SAME key across restarts', () => {
    const first = createMacaroonRootKey({ dataDir: dir })
    const second = createMacaroonRootKey({ dataDir: dir })

    expect([...second.rootKey]).toEqual([...first.rootKey])
  })

  it('generates a key nobody else would guess', () => {
    const a = createMacaroonRootKey({ dataDir: dir }).rootKey
    const other = mkdtempSync(join(tmpdir(), 'wb-macaroon-root-key-'))
    try {
      expect([...createMacaroonRootKey({ dataDir: other }).rootKey]).not.toEqual([...a])
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })
})

describe('createMacaroonRootKey — an unreadable file rotates', () => {
  it.each([
    ['not JSON', 'nope{'],
    ['JSON of the wrong shape', JSON.stringify({ version: 1 })],
    [
      'a key of the wrong length',
      JSON.stringify({ version: 1, alg: 'HMAC-SHA-256', rootKey: 'AA' }),
    ],
  ])('regenerates and says why when the file is %s', (_label, contents) => {
    const logs = captureLogsForTests('warning')
    try {
      writeFileSync(filepath(), contents, { mode: 0o600 })
      const { rootKey } = createMacaroonRootKey({ dataDir: dir })

      expect(rootKey).toHaveLength(32)
      expect(logs.records.map((record) => record.msg)).toContain(
        'macaroon root key unreadable; generating a fresh one (every issued token stops verifying)',
      )
    } finally {
      logs.restore()
    }
  })

  // The rotation semantics the docblock promises, asserted rather than
  // described: this is the daemon's only way to invalidate an act-plane token
  // before it expires, and it invalidates every one of them.
  it('stops every previously issued token verifying', async () => {
    const before = createMacaroonRootKey({ dataDir: dir })
    const token = await mintMacaroon({ rootKey: before.rootKey, tokenId: 'tok-1' })
    const context = { requiredScopes: [], now: 0 } as const

    await expect(
      verifyMacaroon({ token, rootKey: before.rootKey, context }),
    ).resolves.toMatchObject({ ok: true })

    const logs = captureLogsForTests('warning')
    try {
      writeFileSync(filepath(), 'corrupt', { mode: 0o600 })
      const after = createMacaroonRootKey({ dataDir: dir })

      await expect(verifyMacaroon({ token, rootKey: after.rootKey, context })).resolves.toEqual({
        ok: false,
        reason: 'bad-signature',
      })
    } finally {
      logs.restore()
    }
  })
})

describe('createMacaroonRootKey — the key does not reach the log', () => {
  // `log.ts`'s redaction is the net rather than the plan, so this asserts the
  // net is actually strung for THIS field name: pino redaction does not infer
  // field names, and a new secret-bearing field is invisible to it until its
  // path is listed.
  it('redacts a rootKey logged as a structured field', () => {
    const { rootKey } = createMacaroonRootKey({ dataDir: dir })
    const secret = Buffer.from(rootKey).toString('base64url')
    const logs = captureLogsForTests('warning')
    try {
      const log = getLogger('macaroon-root-key-test')
      log.warning({ rootKey: secret }, 'top level')
      log.warning({ config: { rootKey: secret } }, 'one level down')

      const serialized = JSON.stringify(logs.records)
      expect(serialized).not.toContain(secret)
      expect(serialized.match(/\[redacted\]/g)).toHaveLength(2)
    } finally {
      logs.restore()
    }
  })

  it('never writes the key into the warning it emits on a corrupt file', () => {
    const { rootKey } = createMacaroonRootKey({ dataDir: dir })
    const secret = Buffer.from(rootKey).toString('base64url')
    // A corrupt file whose contents happen to carry the real key: a handler
    // that logged its parse error, or its input, would leak it here.
    const logs = captureLogsForTests('warning')
    try {
      writeFileSync(filepath(), `${readFileSync(filepath(), 'utf8')}trailing`, { mode: 0o600 })
      createMacaroonRootKey({ dataDir: dir })

      expect(JSON.stringify(logs.records)).not.toContain(secret)
    } finally {
      logs.restore()
    }
  })
})

// PROBED, never inferred: these need a mode they SET to be a mode the store
// READS BACK. Not the root question — the guard reads `statSync().mode`
// rather than attempting a denied read, so uid 0 changes nothing.
function probeChmodIsObservable(): boolean {
  const probeDir = mkdtempSync(join(tmpdir(), 'wb-mode-probe-'))
  try {
    const file = join(probeDir, 'f')
    writeFileSync(file, 'x')
    chmodSync(file, 0o644)
    return (statSync(file).mode & 0o777) === 0o644
  } catch {
    return false
  } finally {
    rmSync(probeDir, { recursive: true, force: true })
  }
}
const CHMOD_IS_OBSERVABLE = probeChmodIsObservable()

// The reachability half of `secret-file-mode.test.ts`: that module's own
// tests pass whether or not either key store ever calls it, which is the
// exact shape that let this PR ship a verification path with no production
// caller. These two assert the CALL.
describe('createMacaroonRootKey refuses a leaked key file', () => {
  it.skipIf(!CHMOD_IS_OBSERVABLE)(
    'throws on a group-readable root key instead of rotating past it',
    () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'wb-macaroon-leaked-'))
      try {
        const { rootKey } = createMacaroonRootKey({ dataDir })
        const filepath = join(dataDir, 'macaroon-root-key.json')
        chmodSync(filepath, 0o640)

        expect(() => createMacaroonRootKey({ dataDir })).toThrow(/group or other/i)
        // Not rotated: the file the operator has to chmod is still the one
        // every issued token chains from.
        chmodSync(filepath, 0o600)
        expect(createMacaroonRootKey({ dataDir }).rootKey).toEqual(rootKey)
      } finally {
        rmSync(dataDir, { recursive: true, force: true })
      }
    },
  )

  it.skipIf(!CHMOD_IS_OBSERVABLE)(
    'writes the key owner-only even over a leftover temp file',
    () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'wb-macaroon-tmp-'))
      try {
        const filepath = join(dataDir, 'macaroon-root-key.json')
        writeFileSync(`${filepath}.tmp`, 'stale')
        chmodSync(`${filepath}.tmp`, 0o644)

        createMacaroonRootKey({ dataDir })

        expect(statSync(filepath).mode & 0o777).toBe(0o600)
      } finally {
        rmSync(dataDir, { recursive: true, force: true })
      }
    },
  )
})
