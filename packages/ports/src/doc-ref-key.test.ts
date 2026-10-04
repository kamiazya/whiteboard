import { workspaceIdSchema } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { docRefKey, workspaceIdOfStoredDocKey } from './doc-ref-key.js'
import { fc, fcTest, withDefaults } from './test-utils/fast-check.js'

const workspaceIdArbitrary = fc.stringMatching(/^[a-zA-Z0-9_-]{1,40}$/)
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
      const workspaceId = workspaceIdOfStoredDocKey(key)
      if (workspaceId === null) return
      expect(workspaceIdSchema.safeParse(workspaceId).success).toBe(true)
      expect(docRefKey({ kind: 'workspace-tree', workspaceId })).toBe(key)
    },
  )

  it.each([
    ['an empty id', 'workspace-tree:'],
    ['an id that is not path-safe', 'workspace-tree:a/b'],
    ['an id with a second separator', 'workspace-tree:a:b'],
    ['the prefix without its separator', 'workspace-tree'],
    ['a prefix in the middle', 'x-workspace-tree:a'],
    ['a different case', 'Workspace-Tree:a'],
    ['an unrelated key', 'blob:abc'],
    ['an empty key', ''],
  ])('answers null for %s', (_what, key) => {
    expect(workspaceIdOfStoredDocKey(key)).toBeNull()
  })
})
