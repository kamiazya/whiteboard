import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildSupportBundle,
  SupportBundleError,
  type SupportBundleInput,
} from './support-bundle.js'
import { writeSupportBundle } from './support-bundle-writer.js'

const FIXED_TS = '2026-05-10T00:00:00.000Z'

const minimalInput: SupportBundleInput = {
  createdAt: FIXED_TS,
  packageVersion: '0.0.4',
  platform: { os: 'darwin', nodeVersion: 'v22.0.0' },
  status: { ok: true, reason: null, recordFound: false, recordFresh: false },
  doctor: { ok: true, status: 'ok', checks: [] },
  logs: [
    {
      timestamp: FIXED_TS,
      level: 'info',
      source: 'daemon',
      message: 'startup',
      fields: { pid: 1234, port: 3099, status: 'ok' },
    },
  ],
}

let root: string
let bundle: ReturnType<typeof buildSupportBundle>

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'whiteboard-support-bundle-writer-'))
  bundle = buildSupportBundle(minimalInput)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('writeSupportBundle', () => {
  it('missing target directory: creates it and writes exactly the four bundle files in stable order', async () => {
    const target = join(root, 'bundle-1')
    const result = await writeSupportBundle(bundle, target, { allowedRoots: [root] })
    expect(result.outputDir).toBe(target)
    expect(result.files).toEqual(['status.json', 'doctor.json', 'logs.jsonl', 'manifest.json'])

    const entries = (await readdir(target)).sort()
    expect(entries).toEqual(['doctor.json', 'logs.jsonl', 'manifest.json', 'status.json'])

    // Each file matches the in-memory bundle byte-for-byte.
    for (const name of ['manifest.json', 'status.json', 'doctor.json', 'logs.jsonl'] as const) {
      const onDisk = await readFile(join(target, name), 'utf-8')
      expect(onDisk).toBe(bundle.files[name])
    }
  })

  it('existing empty directory: writes the four files into it without complaining', async () => {
    const target = join(root, 'bundle-empty')
    await mkdir(target, { recursive: true })
    await writeSupportBundle(bundle, target, { allowedRoots: [root] })
    expect((await readdir(target)).sort()).toEqual([
      'doctor.json',
      'logs.jsonl',
      'manifest.json',
      'status.json',
    ])
  })

  it('existing non-empty directory: throws SupportBundleError and preserves the canary file untouched', async () => {
    const target = join(root, 'bundle-nonempty')
    await mkdir(target, { recursive: true })
    const canaryPath = join(target, 'pre-existing.txt')
    await writeFile(canaryPath, 'canary-content')

    await expect(
      writeSupportBundle(bundle, target, { allowedRoots: [root] }),
    ).rejects.toBeInstanceOf(SupportBundleError)

    // The canary survives, and no bundle files were written.
    expect(await readFile(canaryPath, 'utf-8')).toBe('canary-content')
    expect((await readdir(target)).sort()).toEqual(['pre-existing.txt'])
  })

  it('target path is a regular file: throws and does not overwrite', async () => {
    const target = join(root, 'not-a-dir.txt')
    await writeFile(target, 'preexisting')
    await expect(
      writeSupportBundle(bundle, target, { allowedRoots: [root] }),
    ).rejects.toBeInstanceOf(SupportBundleError)
    expect(await readFile(target, 'utf-8')).toBe('preexisting')
  })

  it('target path is a symlink: throws with the dedicated symlink-not-allowed error and does not follow', async () => {
    const realDir = join(root, 'real')
    await mkdir(realDir, { recursive: true })
    const target = join(root, 'link')
    await symlink(realDir, target)
    let caught: unknown
    try {
      await writeSupportBundle(bundle, target, { allowedRoots: [root] })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(SupportBundleError)
    // Pin the dedicated symlink branch — a regression that drops it
    // and falls through to the "not a directory" path would still
    // reject (lstat reports !isDirectory for a symlink) but lose
    // the documented symlink-aware message that future log readers
    // rely on.
    expect((caught as Error).message).toMatch(/symlink/i)
    expect((await readdir(realDir)).sort()).toEqual([])
  })

  it('path guard: ancestor symlink pointing outside allowedRoots is rejected, outside dir untouched', async () => {
    // Reproduce the bypass: <root>/link → <outside>; the caller
    // asks for <root>/link/bundle. A naive string-prefix containment
    // check passes (the path starts with <root>/), but a real walk
    // through realpath places the target inside <outside>. The writer
    // must reject and leave <outside> untouched.
    const outside = await mkdtemp(join(tmpdir(), 'whiteboard-support-bundle-writer-outside-'))
    try {
      await symlink(outside, join(root, 'link'))
      const target = join(root, 'link', 'bundle')

      let caught: unknown
      try {
        await writeSupportBundle(bundle, target, { allowedRoots: [root] })
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(SupportBundleError)
      const msg = (caught as Error).message
      // Generic — never echo the leaky absolute paths.
      expect(msg).not.toContain(outside)
      expect(msg).not.toContain(root)

      // Outside dir untouched: no bundle files materialised through
      // the symlinked traversal.
      expect((await readdir(outside)).sort()).toEqual([])
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('path guard: target outside allowedRoots throws and does not echo the resolved path', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'whiteboard-support-bundle-writer-other-'))
    try {
      let caught: unknown
      try {
        await writeSupportBundle(bundle, join(outside, 'bundle'), { allowedRoots: [root] })
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(SupportBundleError)
      const msg = (caught as Error).message
      expect(msg).not.toContain(outside)
      expect(msg).not.toContain(root)
      expect(msg).toMatch(/not inside an allowed root/i)
      // Outside dir untouched.
      expect((await readdir(outside)).sort()).toEqual([])
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('on-disk files inherit the bundle redaction contract: no Authorization / Bearer / token / paths leak', async () => {
    const leaky = buildSupportBundle({
      ...minimalInput,
      status: {
        ...minimalInput.status,
        reason: 'Authorization: Bearer secret-token-XYZ at /opt/wb/server.ts:42',
      },
      logs: [
        {
          timestamp: FIXED_TS,
          level: 'error',
          source: 'daemon',
          message: 'Authorization: Bearer secret-token-XYZ at /Users/me/db.sqlite',
          fields: { status: 'process-not-running' },
        },
      ],
    })
    const target = join(root, 'leaky-bundle')
    await writeSupportBundle(leaky, target, { allowedRoots: [root] })
    const concatenated = (
      await Promise.all(
        ['manifest.json', 'status.json', 'doctor.json', 'logs.jsonl'].map((n) =>
          readFile(join(target, n), 'utf-8'),
        ),
      )
    ).join('')
    expect(concatenated).not.toContain('secret-token-XYZ')
    expect(concatenated).not.toMatch(/Authorization/i)
    expect(concatenated).not.toMatch(/Bearer/i)
    expect(concatenated).not.toMatch(/\/opt\//)
    expect(concatenated).not.toMatch(/\/Users\//)
    expect(concatenated).not.toMatch(/\.ts:\d/)
  })

  it('manifest.sections matches the on-disk file set minus the manifest itself', async () => {
    const target = join(root, 'bundle-sections')
    await writeSupportBundle(bundle, target, { allowedRoots: [root] })
    const manifest = JSON.parse(await readFile(join(target, 'manifest.json'), 'utf-8'))
    const onDiskSections = (await readdir(target)).filter((n) => n !== 'manifest.json').sort()
    expect([...manifest.sections].sort()).toEqual(onDiskSections)
  })
})
