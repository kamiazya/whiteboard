import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeFileAtomic } from './write-file-atomic.js'

// Probed rather than inferred from the platform: whether a requested mode
// survives is a property of the filesystem under tmpdir, not of the OS name.
const CAN_EXPRESS_MODE = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'mode-probe-'))
  try {
    const probe = join(dir, 'probe')
    writeFileSync(probe, '', { mode: 0o640 })
    return (statSync(probe).mode & 0o777) === 0o640
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})()

describe('writeFileAtomic', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'write-file-atomic-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('leaves the file holding the bytes, and nothing else beside it', async () => {
    const target = join(dir, 'out.bin')
    await writeFileAtomic(target, new Uint8Array([1, 2, 3]))
    expect([...readFileSync(target)]).toEqual([1, 2, 3])
    expect(readdirSync(dir)).toEqual(['out.bin'])
  })

  it('accepts a string and replaces an existing file whole', async () => {
    const target = join(dir, 'out.txt')
    writeFileSync(target, 'a much longer previous body')
    await writeFileAtomic(target, 'short')
    expect(readFileSync(target, 'utf-8')).toBe('short')
    expect(readdirSync(dir)).toEqual(['out.txt'])
  })

  it('two concurrent writes to one target never interleave', async () => {
    const target = join(dir, 'race.txt')
    const a = 'a'.repeat(200_000)
    const b = 'b'.repeat(200_000)
    await Promise.all([writeFileAtomic(target, a), writeFileAtomic(target, b)])
    expect([a, b]).toContain(readFileSync(target, 'utf-8'))
    expect(readdirSync(dir)).toEqual(['race.txt'])
  })

  it('removes its temp file and rethrows when the rename fails', async () => {
    const target = join(dir, 'is-a-dir')
    mkdirSync(target)
    await expect(writeFileAtomic(target, 'x')).rejects.toThrow()
    expect(readdirSync(dir)).toEqual(['is-a-dir'])
  })

  it.skipIf(!CAN_EXPRESS_MODE)('honours the mode when one is given', async () => {
    const target = join(dir, 'secret.json')
    await writeFileAtomic(target, '{}', { mode: 0o600 })
    expect(statSync(target).mode & 0o777).toBe(0o600)
  })

  it.skipIf(!CAN_EXPRESS_MODE)('honours the mode when replacing a looser file', async () => {
    const target = join(dir, 'secret.json')
    writeFileSync(target, 'old', { mode: 0o644 })
    await writeFileAtomic(target, '{}', { mode: 0o600 })
    expect(statSync(target).mode & 0o777).toBe(0o600)
  })

  it('can express a file mode on CI, so the mode cases cannot all skip silently', () => {
    if (process.env.CI) expect(CAN_EXPRESS_MODE).toBe(true)
  })
})
