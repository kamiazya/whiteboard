/**
 * The second line of defence behind the id validators: whatever a caller
 * builds a path out of, it must still land inside the directory it named.
 *
 * Exercised directly. It used to be reached through
 * `version-store.loadThumbnail` with the validators mocked out of the way, so
 * that the guard rather than the validator would be the thing to fire — and
 * when the version thumbnail was retired, the one caller that test knew went
 * with it and the guard was left with no coverage at all. Nothing about
 * `assertPathWithinDir` needed a store to state, so it no longer has one.
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertPathWithinDir } from './path-guard.js'

const ROOT = '/data/blobs'

describe('assertPathWithinDir', () => {
  it('returns the path it was given when it resolves inside the directory', () => {
    // The PATH is returned, not the resolved form: callers pass this straight
    // to `readFile`, and handing back a resolved copy would quietly change
    // what a relative caller opens.
    const inside = join(ROOT, 'ws-1', 'ab', 'cdef')
    expect(assertPathWithinDir(inside, ROOT, 'blob path')).toBe(inside)
    expect(assertPathWithinDir(ROOT, ROOT, 'blob path')).toBe(ROOT)
  })

  it('refuses a path that climbs out, however it is spelled', () => {
    for (const climbing of [
      join(ROOT, '..', 'secrets'),
      join(ROOT, 'ws-1', '..', '..', 'secrets'),
      '/etc/passwd',
    ]) {
      expect(() => assertPathWithinDir(climbing, ROOT, 'blob path')).toThrowError(
        expect.objectContaining({ name: 'ValidationError', error: 'invalid_path' }),
      )
    }
  })

  // `/data/blobs-other` starts with `/data/blobs` as a STRING and is a
  // different directory. A prefix check without the separator lets it
  // through, which is the classic way this guard is written wrong.
  it('refuses a sibling directory whose name merely starts with the same characters', () => {
    expect(() => assertPathWithinDir('/data/blobs-other/x', ROOT, 'blob path')).toThrowError(
      expect.objectContaining({ error: 'invalid_path' }),
    )
  })

  it('names the label and both paths, so a refusal says what was refused', () => {
    expect(() => assertPathWithinDir('/etc/passwd', ROOT, 'version path')).toThrowError(
      /Invalid version path.*\/etc\/passwd.*outside.*\/data\/blobs/,
    )
  })
})
