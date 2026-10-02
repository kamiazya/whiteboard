import { type Mock, vi } from 'vitest'
import type { VersionStore } from '../version-store.js'

/** Every `VersionStore` verb as a spy, so a test can assert on the verb it cares about. */
export type VersionStoreMock = { [K in keyof VersionStore]: Mock<VersionStore[K]> }

/**
 * A `VersionStore` whose verbs are all spies, for a test that drives a route
 * or a scheduler and observes what it asked of the store.
 *
 * Typed against `VersionStore` rather than written out by hand per test: the
 * hand-written doubles each kept the verbs the store had when they were
 * written, and a retired verb stayed in them while a new one was missing.
 * The defaults are the realistic quiet answers (no version cut, nothing to
 * prune); a test that cares about one overrides it.
 */
export function versionStoreMock(overrides: Partial<VersionStoreMock> = {}): VersionStoreMock {
  return {
    save: vi.fn(),
    load: vi.fn(),
    loadWorkspaceAt: vi.fn(),
    list: vi.fn(),
    earliestWorkspaceFrontiers: vi.fn().mockResolvedValue(null),
    getFrontiersBase64: vi.fn(),
    isUnchangedSinceLastVersion: vi.fn().mockResolvedValue(false),
    pruneSandwichedAutoVersions: vi.fn().mockResolvedValue({ deletedCount: 0, deletedIds: [] }),
    ...overrides,
  }
}
