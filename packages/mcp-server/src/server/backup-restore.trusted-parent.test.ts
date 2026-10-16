/**
 * Which directories may hold a symlink the path guard follows. Staging a
 * directory ANOTHER user owns takes the privilege to chown, so the
 * filesystem-level case in `backup-restore.output-path.test.ts` runs only as
 * root; the table here holds the same decision on every runner.
 */
import { lstatSync, readlinkSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { describe, expect, it } from 'vitest'
import { inspectOutputPath, trustsLinkParent } from './backup-restore.js'

const SELF = 1000
const OTHER = 1001
const ROOT = 0
const DIR = 0o040000

const owners = [
  { owner: 'this user', uid: SELF, trusted: true },
  { owner: 'root', uid: ROOT, trusted: true },
  { owner: 'another user', uid: OTHER, trusted: false },
] as const

const modes = [
  { mode: 0o700, writableByOthers: false },
  { mode: 0o755, writableByOthers: false },
  { mode: 0o1755, writableByOthers: false },
  { mode: 0o775, writableByOthers: true },
  { mode: 0o757, writableByOthers: true },
  { mode: 0o777, writableByOthers: true },
  { mode: 0o1777, writableByOthers: true },
] as const

describe('trustsLinkParent', () => {
  for (const { owner, uid, trusted } of owners) {
    for (const { mode, writableByOthers } of modes) {
      const expected = trusted && !writableByOthers
      it(`${expected ? 'trusts' : 'refuses'} a ${mode.toString(8)} directory ${owner} owns`, () => {
        expect(trustsLinkParent({ uid, mode: DIR | mode }, SELF)).toBe(expected)
      })
    }
  }

  it('trusts no directory where there are no POSIX owners to ask', () => {
    for (const { uid } of owners) {
      expect(trustsLinkParent({ uid, mode: DIR | 0o700 }, undefined)).toBe(false)
    }
  })

  it('trusts a directory root owns when root is the current user', () => {
    expect(trustsLinkParent({ uid: ROOT, mode: DIR | 0o755 }, ROOT)).toBe(true)
    expect(trustsLinkParent({ uid: OTHER, mode: DIR | 0o755 }, ROOT)).toBe(false)
  })
})

// The operating system's own link in `/` (merged-/usr Linux: `/bin -> usr/bin`),
// whose directory only root may write. PROBED rather than assumed: the case
// needs that link, an owner and mode on `/` the rule trusts, and a target
// that resolves.
function probeOsLinkInRoot(): string | undefined {
  if (process.getuid === undefined) return undefined
  const link = '/bin'
  try {
    if (!lstatSync(link).isSymbolicLink()) return undefined
    if (isAbsolute(readlinkSync(link))) return undefined
    const root = statSync('/')
    if (root.uid !== 0 || (root.mode & 0o022) !== 0) return undefined
    return statSync(link).isDirectory() ? link : undefined
  } catch {
    return undefined
  }
}
const OS_LINK_IN_ROOT = probeOsLinkInRoot()

describe('a link the operating system ships in a root-owned /', () => {
  it.skipIf(OS_LINK_IN_ROOT === undefined)(
    'is followed, for a user who is not root too',
    async () => {
      expect(
        await inspectOutputPath(`${OS_LINK_IN_ROOT}/wb-missing-entry`, { requireDirectory: true }),
      ).toBe('missing')
    },
  )

  // CI is an ordinary user over ubuntu's merged /usr, the one runner where
  // only the root-owned arm of the rule can trust `/`.
  it.runIf(process.env.CI && process.platform === 'linux')('is present on linux CI', () => {
    expect(
      OS_LINK_IN_ROOT,
      'no /bin link in a root-owned, unwritable / was found, so the case above is skipped on CI — find out why before trusting this run',
    ).toBe('/bin')
  })
})
