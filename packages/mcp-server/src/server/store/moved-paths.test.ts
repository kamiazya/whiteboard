import {
  createWorkspaceDocumentAtPath,
  moveWorkspaceNodeToPath,
} from '@kamiazya/whiteboard-loro-adapter'
import { generateDocumentId } from '@kamiazya/whiteboard-model'
import { LoroDoc } from 'loro-crdt'
import { afterEach, describe, expect, it } from 'vitest'
import { clearDocCacheForTests, getOrLoad, peekDoc } from './doc-cache.js'
import { moveEvictingCache } from './moved-paths.js'
import { globalStoreScope } from './store-scope.js'

const WORKSPACE = 'ws'

function workspaceWith(paths: readonly string[]): LoroDoc {
  const doc = new LoroDoc()
  for (const path of paths) {
    createWorkspaceDocumentAtPath(doc, { path, documentId: generateDocumentId(), kind: 'spatial' })
  }
  return doc
}

async function cacheAll(paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    await getOrLoad(WORKSPACE, path, async () => new LoroDoc(), globalStoreScope)
  }
}

const cached = (path: string): boolean => peekDoc(WORKSPACE, path, globalStoreScope) !== undefined

afterEach(clearDocCacheForTests)

describe('moveEvictingCache', () => {
  it('evicts every source path of the subtree and every destination path, and nothing beside it', async () => {
    const workspaceDoc = workspaceWith(['a/b', 'a/c', 'a-sibling'])
    const touched = ['a/b', 'a/c', 'x/b', 'x/c']
    const untouched = ['a-sibling', 'other']
    await cacheAll([...touched, ...untouched])

    await moveEvictingCache(WORKSPACE, 'a', 'x', globalStoreScope, workspaceDoc, async () => {})

    expect(touched.filter(cached)).toEqual([])
    expect(untouched.filter(cached)).toEqual(untouched)
  })

  it('reads the subtree before the move rewrites it', async () => {
    const workspaceDoc = workspaceWith(['a/b'])
    await cacheAll(['a/b', 'x/b'])

    await moveEvictingCache(WORKSPACE, 'a', 'x', globalStoreScope, workspaceDoc, async () => {
      moveWorkspaceNodeToPath(workspaceDoc, 'a', 'x')
    })

    expect(cached('a/b')).toBe(false)
    expect(cached('x/b')).toBe(false)
  })

  it('still runs the move when no workspace record is stored', async () => {
    let moved = false
    await moveEvictingCache(WORKSPACE, 'a', 'x', globalStoreScope, null, async () => {
      moved = true
    })
    expect(moved).toBe(true)
  })
})
