/**
 * Backup/restore refuses a target outside its allowed roots. One table names
 * each shape of target the guard has to tell apart. A symlink is followed and
 * judged by where it lands, because callers reach the data directory through
 * one.
 */
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BackupError, backupDataDir } from './backup-restore.js'

type Outcome = 'allowed' | 'outside'

let base: string
let srcRoot: string

beforeEach(async () => {
  // Resolved, so a platform whose temp dir is itself a symlink does not turn
  // every case into a symlink case.
  base = await realpath(await mkdtemp(join(tmpdir(), 'whiteboard-path-guard-')))
  srcRoot = await realpath(await mkdtemp(join(tmpdir(), 'whiteboard-path-guard-src-')))
  await mkdir(join(srcRoot, 'src'))
  await writeFile(join(srcRoot, 'src', 'file.txt'), 'x')
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
  await rm(srcRoot, { recursive: true, force: true })
})

async function viaBackup(target: string, roots: readonly string[]): Promise<Outcome> {
  try {
    // The source is allowed through a root of its own, so only the TARGET
    // decides the outcome.
    await backupDataDir(join(srcRoot, 'src'), target, { allowedRoots: [...roots, srcRoot] })
    return 'allowed'
  } catch (err) {
    if (err instanceof BackupError && /not inside an allowed root/.test(err.message)) {
      return 'outside'
    }
    throw err
  }
}

interface Case {
  readonly name: string
  /** Builds the layout under `base`; returns the target and the roots, as paths under `base`. */
  readonly arrange: () => Promise<{ target: string; roots: string[] }>
  readonly backup: Outcome
}

const at = (...parts: string[]): string => join(base, ...parts)

const CASES: readonly Case[] = [
  {
    name: 'a sibling whose name starts with the root`s is outside it',
    arrange: async () => {
      await mkdir(at('b'))
      await mkdir(at('bc'))
      return { target: at('bc', 'x'), roots: [at('b')] }
    },
    backup: 'outside',
  },
  {
    name: 'the root itself is inside it',
    arrange: async () => {
      await mkdir(at('b'))
      return { target: at('b'), roots: [at('b')] }
    },
    backup: 'allowed',
  },
  {
    name: 'a missing tail below the root is inside it',
    arrange: async () => {
      await mkdir(at('b'))
      return { target: at('b', 'x', 'y'), roots: [at('b')] }
    },
    backup: 'allowed',
  },
  {
    name: 'a root that does not exist yet still contains what is written below it',
    arrange: async () => ({ target: at('missing', 'x'), roots: [at('missing')] }),
    backup: 'allowed',
  },
  {
    name: 'a missing root does not hide a later root that matches',
    arrange: async () => {
      await mkdir(at('b'))
      return { target: at('b', 'x'), roots: [at('missing'), at('b')] }
    },
    backup: 'allowed',
  },
  {
    name: 'a symlinked parent that leaves the root is outside it',
    arrange: async () => {
      await mkdir(at('b'))
      await mkdir(at('out'))
      await symlink(at('out'), at('b', 'link'))
      return { target: at('b', 'link', 'x'), roots: [at('b')] }
    },
    backup: 'outside',
  },
  {
    name: 'a symlinked parent that stays in the root is followed',
    arrange: async () => {
      await mkdir(at('b', 'real'), { recursive: true })
      await symlink(at('b', 'real'), at('b', 'link'))
      return { target: at('b', 'link', 'x'), roots: [at('b')] }
    },
    backup: 'allowed',
  },
  {
    name: 'a `..` that climbs out of the root is outside it',
    arrange: async () => {
      await mkdir(at('b'))
      await mkdir(at('out'))
      return { target: join(at('b'), '..', 'out', 'x'), roots: [at('b')] }
    },
    backup: 'outside',
  },
  {
    name: 'a `..` that stays in the root is inside it',
    arrange: async () => {
      await mkdir(at('b'))
      return { target: join(at('b'), 'x', '..', 'y'), roots: [at('b')] }
    },
    backup: 'allowed',
  },
  {
    name: 'no roots allow nothing',
    arrange: async () => {
      await mkdir(at('b'))
      return { target: at('b', 'x'), roots: [] }
    },
    backup: 'outside',
  },
]

describe('the allowed-root guard of backup', () => {
  it('covers each shape of target the guard has to tell apart', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(10)
    expect(new Set(CASES.map((one) => one.backup))).toEqual(new Set(['outside', 'allowed']))
  })

  it.each(CASES)('backup: $name', async ({ arrange, backup }) => {
    const { target, roots } = await arrange()
    expect(await viaBackup(target, roots)).toBe(backup)
  })

  it('leaves nothing written outside the allowed roots when it refuses', async () => {
    await mkdir(at('b'))
    await mkdir(at('bc'))
    expect(await viaBackup(at('bc', 'x'), [at('b')])).toBe('outside')
    await expect(realpath(at('bc', 'x'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
