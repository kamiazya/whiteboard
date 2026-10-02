/**
 * Backup/restore and the support-bundle writer both refuse a target outside
 * their allowed roots, and used to answer it with two hand-written walks that
 * differed where nobody could see. One table, run against both, says where
 * they agree and where they deliberately do not.
 *
 * They differ in one stated way: the support-bundle writer also refuses a
 * target whose deepest existing component is a symlink (it writes through
 * that entry), while backup/restore follows a symlink and judges where it
 * lands, because its callers reach the data directory through one.
 */
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildSupportBundle, SupportBundleError } from '../shared/diagnostics/support-bundle.js'
import { writeSupportBundle } from '../shared/diagnostics/support-bundle-writer.js'
import { BackupError, backupDataDir } from './backup-restore.js'

type Outcome = 'allowed' | 'outside' | 'symlink'

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

async function viaSupportBundle(target: string, roots: readonly string[]): Promise<Outcome> {
  try {
    await writeSupportBundle(
      buildSupportBundle({
        createdAt: '2026-05-10T00:00:00.000Z',
        packageVersion: '0.0.4',
        platform: { os: 'linux', nodeVersion: 'v22.0.0' },
        status: { ok: true, reason: null, recordFound: false, recordFresh: false },
        doctor: { ok: true, status: 'ok', checks: [] },
      }),
      target,
      { allowedRoots: [...roots] },
    )
    return 'allowed'
  } catch (err) {
    if (!(err instanceof SupportBundleError)) throw err
    if (/not inside an allowed root/.test(err.message)) return 'outside'
    if (/symlink/.test(err.message)) return 'symlink'
    throw err
  }
}

interface Case {
  readonly name: string
  /** Builds the layout under `base`; returns the target and the roots, as paths under `base`. */
  readonly arrange: () => Promise<{ target: string; roots: string[] }>
  readonly backup: Outcome
  readonly bundle: Outcome
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
    bundle: 'outside',
  },
  {
    name: 'the root itself is inside it',
    arrange: async () => {
      await mkdir(at('b'))
      return { target: at('b'), roots: [at('b')] }
    },
    backup: 'allowed',
    bundle: 'allowed',
  },
  {
    name: 'a missing tail below the root is inside it',
    arrange: async () => {
      await mkdir(at('b'))
      return { target: at('b', 'x', 'y'), roots: [at('b')] }
    },
    backup: 'allowed',
    bundle: 'allowed',
  },
  {
    name: 'a root that does not exist yet still contains what is written below it',
    arrange: async () => ({ target: at('missing', 'x'), roots: [at('missing')] }),
    backup: 'allowed',
    bundle: 'allowed',
  },
  {
    name: 'a missing root does not hide a later root that matches',
    arrange: async () => {
      await mkdir(at('b'))
      return { target: at('b', 'x'), roots: [at('missing'), at('b')] }
    },
    backup: 'allowed',
    bundle: 'allowed',
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
    bundle: 'symlink',
  },
  {
    name: 'a symlinked parent that stays in the root is followed by backup and refused by the bundle writer',
    arrange: async () => {
      await mkdir(at('b', 'real'), { recursive: true })
      await symlink(at('b', 'real'), at('b', 'link'))
      return { target: at('b', 'link', 'x'), roots: [at('b')] }
    },
    backup: 'allowed',
    bundle: 'symlink',
  },
  {
    name: 'a `..` that climbs out of the root is outside it',
    arrange: async () => {
      await mkdir(at('b'))
      await mkdir(at('out'))
      return { target: join(at('b'), '..', 'out', 'x'), roots: [at('b')] }
    },
    backup: 'outside',
    bundle: 'outside',
  },
  {
    name: 'a `..` that stays in the root is inside it',
    arrange: async () => {
      await mkdir(at('b'))
      return { target: join(at('b'), 'x', '..', 'y'), roots: [at('b')] }
    },
    backup: 'allowed',
    bundle: 'allowed',
  },
  {
    name: 'no roots allow nothing',
    arrange: async () => {
      await mkdir(at('b'))
      return { target: at('b', 'x'), roots: [] }
    },
    backup: 'outside',
    bundle: 'outside',
  },
]

describe('the allowed-root guard of backup and of the support bundle', () => {
  it('covers each shape of target the guard has to tell apart', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(10)
    expect(new Set(CASES.map((one) => `${one.backup}/${one.bundle}`))).toEqual(
      new Set(['outside/outside', 'allowed/allowed', 'outside/symlink', 'allowed/symlink']),
    )
  })

  it.each(CASES)('backup: $name', async ({ arrange, backup }) => {
    const { target, roots } = await arrange()
    expect(await viaBackup(target, roots)).toBe(backup)
  })

  it.each(CASES)('support bundle: $name', async ({ arrange, bundle }) => {
    const { target, roots } = await arrange()
    expect(await viaSupportBundle(target, roots)).toBe(bundle)
  })

  it('leaves nothing written outside the allowed roots when it refuses', async () => {
    await mkdir(at('b'))
    await mkdir(at('bc'))
    expect(await viaBackup(at('bc', 'x'), [at('b')])).toBe('outside')
    expect(await viaSupportBundle(at('bc', 'x'), [at('b')])).toBe('outside')
    await expect(realpath(at('bc', 'x'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
