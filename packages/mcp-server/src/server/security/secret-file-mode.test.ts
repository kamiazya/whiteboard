import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assertSecretFileIsOwnerOnly, writeSecretFileAtomicSync } from './secret-file-mode.js'

// PROBED, never inferred, for `can-deny-file-read.ts`'s reason one step over:
// these tests need a mode they SET to be a mode they READ BACK. Windows mode
// bits are close to meaningless and some mounts drop chmod entirely, and a
// test whose premise the filesystem cannot establish reports a broken guard
// rather than an unavailable one. Note this is NOT the root question — these
// read `statSync().mode` rather than attempting a denied read, so uid 0
// changes nothing here.
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

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wb-secret-file-mode-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const modeOf = (path: string) => statSync(path).mode & 0o777

describe('assertSecretFileIsOwnerOnly', () => {
  it.skipIf(!CHMOD_IS_OBSERVABLE)('accepts an owner-only file', () => {
    const file = join(dir, 'key.json')
    writeFileSync(file, '{}')
    chmodSync(file, 0o600)

    expect(() => assertSecretFileIsOwnerOnly(file)).not.toThrow()
  })

  it.skipIf(!CHMOD_IS_OBSERVABLE)(
    'refuses a group-readable file, naming the path and the fix',
    () => {
      const file = join(dir, 'key.json')
      writeFileSync(file, '{}')
      chmodSync(file, 0o640)

      expect(() => assertSecretFileIsOwnerOnly(file)).toThrow(/group or other/i)
      expect(() => assertSecretFileIsOwnerOnly(file)).toThrow(
        new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      )
      expect(() => assertSecretFileIsOwnerOnly(file)).toThrow(/chmod 600/)
    },
  )

  it.skipIf(!CHMOD_IS_OBSERVABLE)('refuses an other-readable file', () => {
    const file = join(dir, 'key.json')
    writeFileSync(file, '{}')
    chmodSync(file, 0o604)

    expect(() => assertSecretFileIsOwnerOnly(file)).toThrow(/group or other/i)
  })

  // Absence is the caller's business — both key stores answer it by
  // generating a fresh secret, and a guard that turned "no key yet" into a
  // startup failure would break first boot.
  it('says nothing about a file that does not exist', () => {
    expect(() => assertSecretFileIsOwnerOnly(join(dir, 'absent.json'))).not.toThrow()
  })
})

describe('writeSecretFileAtomicSync', () => {
  it.skipIf(!CHMOD_IS_OBSERVABLE)('creates the file owner-only', () => {
    const file = join(dir, 'key.json')
    writeSecretFileAtomicSync(file, '{"a":1}\n')

    expect(readFileSync(file, 'utf8')).toBe('{"a":1}\n')
    expect(modeOf(file)).toBe(0o600)
  })

  // The defect this helper exists for, measured rather than argued:
  // `writeFileSync`'s `mode` option applies only when the file is CREATED, so
  // a leftover `<file>.tmp` from a crashed write keeps whatever bits it had
  // and the rename carries them onto the secret. Verified against Node: a
  // 0o644 file rewritten with `{ mode: 0o600 }` reads back 0o644.
  it.skipIf(!CHMOD_IS_OBSERVABLE)(
    'tightens a leftover temp file instead of inheriting its bits',
    () => {
      const file = join(dir, 'key.json')
      const leftover = `${file}.tmp`
      writeFileSync(leftover, 'stale')
      chmodSync(leftover, 0o644)

      writeSecretFileAtomicSync(file, '{"a":1}\n')

      expect(modeOf(file)).toBe(0o600)
      expect(readFileSync(file, 'utf8')).toBe('{"a":1}\n')
    },
  )

  it.skipIf(!CHMOD_IS_OBSERVABLE)(
    'tightens a pre-existing directory instead of inheriting its bits',
    () => {
      const nested = join(dir, 'data')
      mkdirSync(nested)
      chmodSync(nested, 0o755)

      writeSecretFileAtomicSync(join(nested, 'key.json'), '{}\n')

      expect(modeOf(nested)).toBe(0o700)
    },
  )

  /**
   * The ATOMIC half of the name, which nothing watched until a mutation check
   * found it: replacing the temp-file-and-rename with a direct write left all
   * three callers' suites green — daemon-identity, macaroon-root-key and the
   * server-mode record alike.
   *
   * The inode is the discriminator, and it is the property rather than an
   * implementation detail. A direct write opens the destination `O_TRUNC`, so
   * the same inode is empty for as long as the write takes and a concurrent
   * reader sees a truncated file; a rename swaps a fully-written inode in, so
   * a reader sees the old bytes or the new ones and never a half file.
   * Measured: a direct rewrite keeps the inode, a rename changes it.
   */
  it('swaps a new inode into place rather than truncating the old one', () => {
    const file = join(dir, 'key.json')
    writeSecretFileAtomicSync(file, 'old')
    const before = statSync(file).ino

    writeSecretFileAtomicSync(file, 'new')

    expect(readFileSync(file, 'utf8')).toBe('new')
    expect(statSync(file).ino).not.toBe(before)
  })

  it('leaves no temp file behind', () => {
    const file = join(dir, 'key.json')
    writeSecretFileAtomicSync(file, 'contents')
    expect(existsSync(`${file}.tmp`)).toBe(false)
  })

  it.skipIf(!CHMOD_IS_OBSERVABLE)('replaces an existing secret and leaves it owner-only', () => {
    const file = join(dir, 'key.json')
    writeFileSync(file, 'old')
    chmodSync(file, 0o644)

    writeSecretFileAtomicSync(file, 'new')

    expect(readFileSync(file, 'utf8')).toBe('new')
    expect(modeOf(file)).toBe(0o600)
  })
})
