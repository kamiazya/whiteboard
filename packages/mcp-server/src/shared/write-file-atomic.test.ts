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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CHMOD_IS_OBSERVABLE } from './test-utils/chmod-is-observable.js'
import { writeFileAtomic } from './write-file-atomic.js'

// The chmod after the write is best-effort, so a test can refuse it to see
// what the write carried on its own.
const chmodGate = vi.hoisted(() => ({ refuse: false }))
vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>()
  return {
    ...real,
    chmod: (...args: Parameters<typeof real.chmod>) =>
      chmodGate.refuse
        ? Promise.reject(Object.assign(new Error('operation not permitted'), { code: 'EPERM' }))
        : real.chmod(...args),
  }
})

/**
 * The mode a file asking for 0o666 is born with under this process's umask.
 * PROBED: the two mode cases below only distinguish anything when the umask
 * narrows a new file, and still leaves it looser than owner-only.
 */
function probeBornMode(): number {
  const probeDir = mkdtempSync(join(tmpdir(), 'wb-umask-probe-'))
  try {
    const file = join(probeDir, 'f')
    writeFileSync(file, 'x', { mode: 0o666 })
    return statSync(file).mode & 0o777
  } finally {
    rmSync(probeDir, { recursive: true, force: true })
  }
}
const BORN_MODE = probeBornMode()
const UMASK_NARROWS = CHMOD_IS_OBSERVABLE && BORN_MODE !== 0o666
const UMASK_LEAVES_GROUP_OR_OTHER = CHMOD_IS_OBSERVABLE && (BORN_MODE & 0o066) !== 0

describe('writeFileAtomic', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'write-file-atomic-'))
  })
  afterEach(() => {
    chmodGate.refuse = false
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

  it.skipIf(!CHMOD_IS_OBSERVABLE)('honours the mode when one is given', async () => {
    const target = join(dir, 'secret.json')
    await writeFileAtomic(target, '{}', { mode: 0o600 })
    expect(statSync(target).mode & 0o777).toBe(0o600)
  })

  it.skipIf(!CHMOD_IS_OBSERVABLE)('honours the mode when replacing a looser file', async () => {
    const target = join(dir, 'secret.json')
    writeFileSync(target, 'old', { mode: 0o644 })
    await writeFileAtomic(target, '{}', { mode: 0o600 })
    expect(statSync(target).mode & 0o777).toBe(0o600)
  })

  it.skipIf(!UMASK_NARROWS)(
    'applies a mode wider than the umask lets a new file have',
    async () => {
      const target = join(dir, 'shared.json')
      await writeFileAtomic(target, '{}', { mode: 0o666 })
      expect(statSync(target).mode & 0o777).toBe(0o666)
    },
  )

  it.skipIf(!UMASK_LEAVES_GROUP_OR_OTHER)(
    'carries the mode in the write itself, so a refused chmod still leaves it owner-only',
    async () => {
      chmodGate.refuse = true
      const target = join(dir, 'secret.json')
      await writeFileAtomic(target, '{}', { mode: 0o600 })
      expect(statSync(target).mode & 0o777).toBe(0o600)
    },
  )

  // Both premises hold under every umask a CI runner uses (0022 or 0002), so
  // the two cases above cannot quietly skip there.
  it.runIf(process.env.CI === 'true')('can observe both mode premises on CI', () => {
    expect({ UMASK_NARROWS, UMASK_LEAVES_GROUP_OR_OTHER }).toEqual({
      UMASK_NARROWS: true,
      UMASK_LEAVES_GROUP_OR_OTHER: true,
    })
  })
})
