import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { canonicalizeWithMissingTail, isWithinAllowedRoots } from './path-containment.js'

let base: string

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'whiteboard-path-containment-')))
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

describe('canonicalizeWithMissingTail', () => {
  it('appends the missing segments to the real path of the deepest existing ancestor', async () => {
    await mkdir(join(base, 'real'))
    await symlink(join(base, 'real'), join(base, 'link'))
    expect(await canonicalizeWithMissingTail(join(base, 'link', 'a', 'b'))).toBe(
      join(base, 'real', 'a', 'b'),
    )
  })

  it('answers the real path itself when nothing is missing', async () => {
    expect(await canonicalizeWithMissingTail(join(base, 'x', '..'))).toBe(base)
  })

  it('refuses a symlink at the deepest existing component only when asked to', async () => {
    await mkdir(join(base, 'real'))
    await symlink(join(base, 'real'), join(base, 'link'))
    const refusal = () => new Error('refused')
    await expect(
      canonicalizeWithMissingTail(join(base, 'link', 'x'), { symlinkRefusal: refusal }),
    ).rejects.toThrow('refused')
    await expect(
      canonicalizeWithMissingTail(join(base, 'link'), { symlinkRefusal: refusal }),
    ).rejects.toThrow('refused')
    // A symlink ABOVE the deepest existing component is followed, not refused.
    await mkdir(join(base, 'real', 'sub'))
    expect(
      await canonicalizeWithMissingTail(join(base, 'link', 'sub', 'x'), {
        symlinkRefusal: refusal,
      }),
    ).toBe(join(base, 'real', 'sub', 'x'))
  })
})

describe('isWithinAllowedRoots', () => {
  it('compares whole path segments, so a sibling sharing a prefix is outside', async () => {
    expect(await isWithinAllowedRoots(join(base, 'bc'), [join(base, 'b')])).toBe(false)
    expect(await isWithinAllowedRoots(join(base, 'b', 'c'), [join(base, 'b')])).toBe(true)
    expect(await isWithinAllowedRoots(join(base, 'b'), [join(base, 'b')])).toBe(true)
  })

  it('accepts everything below the filesystem root when that is the allowed root', async () => {
    const fsRoot = parse(base).root
    expect(await isWithinAllowedRoots(join(base, 'x'), [fsRoot])).toBe(true)
  })

  it('judges a root that does not exist yet by where its existing ancestor really is', async () => {
    await mkdir(join(base, 'real'))
    await symlink(join(base, 'real'), join(base, 'link'))
    expect(
      await isWithinAllowedRoots(join(base, 'real', 'new', 'x'), [join(base, 'link', 'new')]),
    ).toBe(true)
  })
})
