// @vitest-environment node
import {
  canonicalUlidArbitrary,
  workspaceSegmentArbitrary,
} from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect } from 'vitest'
import {
  documentSnapshotUrl,
  documentSyncKey,
  documentUpdateUrl,
  workspaceHandleOfSyncKey,
  workspaceIdOfSyncKey,
} from './sync-key.js'
import { fc, fcTest, withDefaults } from './test-utils/fast-check.js'

// A handle is a workspace segment or a canonical id (ADR-0019); neither
// contains '/' or ':'. A path is any non-empty string: slashes are the normal
// case, and arbitrary characters (including ':' and a leading 'workspace:')
// must not change which workspace the key names; only the URL builders refuse
// a dot segment.
const handleArb = fc.oneof(workspaceSegmentArbitrary, canonicalUlidArbitrary)
const pathArb = fc.oneof(
  fc.string({ minLength: 1 }),
  fc.array(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 5 }).map((s) => s.join('/')),
  fc.constantFrom('workspace:x', 'a/b/c', '/lead', 'trail/', 'a:b/c'),
)

describe('a per-document sync key names the workspace it was built from', () => {
  fcTest.prop([handleArb, pathArb], withDefaults())(
    'workspaceHandleOfSyncKey(documentSyncKey(h, p)) is h, and no workspace-scope id',
    (handle, path) => {
      const key = documentSyncKey(handle, path)
      expect(workspaceHandleOfSyncKey(key)).toBe(handle)
      expect(workspaceIdOfSyncKey(key)).toBeNull()
    },
  )

  // A dot segment is no document path, and the URL builders refuse one.
  const addressablePathArb = pathArb.filter((path) =>
    path.split('/').every((segment) => segment !== '.' && segment !== '..'),
  )

  fcTest.prop([handleArb, addressablePathArb], withDefaults())(
    'the update and snapshot routes address the same handle the key was built from',
    (handle, path) => {
      const key = documentSyncKey(handle, path)
      expect(documentUpdateUrl('http://d', key)).toMatch(
        new RegExp(`^http://d/api/w/${handle}/document/.+/update$`),
      )
      expect(documentSnapshotUrl('http://d', key)).toMatch(
        new RegExp(`^http://d/api/w/${handle}/document/.+/snapshot$`),
      )
    },
  )
})
