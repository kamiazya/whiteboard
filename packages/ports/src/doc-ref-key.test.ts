import { workspaceCanonicalIdSchema } from '@kamiazya/whiteboard-model'
import { canonicalUlidArbitrary } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { docRefKey, workspaceIdOfStoredDocKey } from './doc-ref-key.js'
import { fc, fcTest, withDefaults } from './test-utils/fast-check.js'

const workspaceIdArbitrary = canonicalUlidArbitrary
const documentIdArbitrary = fc.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/)

describe('workspaceIdOfStoredDocKey', () => {
  fcTest.prop([workspaceIdArbitrary], withDefaults())(
    'answers the workspace id docRefKey wrote for a workspace-tree ref',
    (workspaceId) => {
      expect(workspaceIdOfStoredDocKey(docRefKey({ kind: 'workspace-tree', workspaceId }))).toBe(
        workspaceId,
      )
    },
  )

  fcTest.prop([workspaceIdArbitrary, documentIdArbitrary], withDefaults())(
    'answers null for the key of a document ref',
    (workspaceId, documentId) => {
      expect(
        workspaceIdOfStoredDocKey(docRefKey({ kind: 'document', workspaceId, documentId })),
      ).toBeNull()
    },
  )

  fcTest.prop([fc.string({ maxLength: 60 })], withDefaults())(
    'answers a workspace id only for a key docRefKey could have written',
    (key) => {
      let workspaceId: string | null
      try {
        workspaceId = workspaceIdOfStoredDocKey(key)
      } catch (err) {
        expect(err).toMatchObject({ code: 'stored_workspace_key_refused' })
        return
      }
      if (workspaceId === null) return
      expect(workspaceCanonicalIdSchema.safeParse(workspaceId).success).toBe(true)
      expect(docRefKey({ kind: 'workspace-tree', workspaceId })).toBe(key)
    },
  )

  // A record keyed before the re-key onto ULIDs is an old stored shape, and
  // a reader asking which workspace it belongs to is refused by name rather
  // than told it is not a workspace record at all.
  it.each([
    ['a legacy daemon id', 'workspace-tree:default'],
    ['a nanoid-minted id', 'workspace-tree:V1StGXR8_Z5jdHi6B-myT'],
    ['an empty id', 'workspace-tree:'],
    ['an id that is not path-safe', 'workspace-tree:a/b'],
    ['an id with a second separator', 'workspace-tree:a:b'],
  ])('refuses %s', (_what, key) => {
    expect(() => workspaceIdOfStoredDocKey(key)).toThrow(
      expect.objectContaining({ code: 'stored_workspace_key_refused', key }),
    )
  })

  it.each([
    ['the prefix without its separator', 'workspace-tree'],
    ['a prefix in the middle', 'x-workspace-tree:a'],
    ['a different case', 'Workspace-Tree:a'],
    ['an unrelated key', 'blob:abc'],
    ['an empty key', ''],
  ])('answers null for %s', (_what, key) => {
    expect(workspaceIdOfStoredDocKey(key)).toBeNull()
  })
})
