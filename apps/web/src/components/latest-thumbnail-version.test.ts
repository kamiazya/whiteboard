// @vitest-environment node
import type { VersionEntry } from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
import { describe, expect, it } from 'vitest'
import { latestThumbnailVersion } from './MergeDialog.js'

function version(overrides: Partial<VersionEntry> & Pick<VersionEntry, 'id'>): VersionEntry {
  return {
    path: 'canvas-a',
    createdAt: '2026-01-01T00:00:00Z',
    elementCount: 0,
    auto: true,
    hasThumbnail: true,
    branchName: 'main',
    ...overrides,
  }
}

describe('latestThumbnailVersion', () => {
  it('picks the latest hasThumbnail match on the branch, wherever it sits in the array', () => {
    const versions = [
      version({ id: 'mid', createdAt: '2026-01-02T00:00:00Z' }),
      version({ id: 'oldest', createdAt: '2026-01-01T00:00:00Z' }),
      version({ id: 'newest', createdAt: '2026-01-03T00:00:00Z' }),
    ]
    expect(latestThumbnailVersion(versions, 'main')?.id).toBe('newest')
  })

  it('picks the FIRST array entry on a createdAt tie, preserving stable-sort-desc[0] semantics', () => {
    const versions = [
      version({ id: 'first', createdAt: '2026-01-01T00:00:00Z' }),
      version({ id: 'second', createdAt: '2026-01-01T00:00:00Z' }),
    ]
    expect(latestThumbnailVersion(versions, 'main')?.id).toBe('first')
  })

  it('excludes entries with hasThumbnail: false', () => {
    const versions = [version({ id: 'no-thumb', hasThumbnail: false })]
    expect(latestThumbnailVersion(versions, 'main')).toBeNull()
  })

  it('excludes entries on a different branch', () => {
    const versions = [version({ id: 'other-branch', branchName: 'feature' })]
    expect(latestThumbnailVersion(versions, 'main')).toBeNull()
  })

  it('returns null when no version matches', () => {
    expect(latestThumbnailVersion([], 'main')).toBeNull()
  })
})
