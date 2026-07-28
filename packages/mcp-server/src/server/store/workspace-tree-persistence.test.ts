import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoroDoc } from 'loro-crdt'
import { WorkspaceTree } from '@kamiazya/whiteboard-canvas-workspace'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createIsolatedDb } from './db/test-helpers.js'
import { LibsqlCanvasDocStore } from './libsql/libsql-canvas-doc-store.js'
import { loadWorkspaceTree, saveWorkspaceTree } from './workspace-tree-persistence.js'

let tempDir: string
let handle: Awaited<ReturnType<typeof createIsolatedDb>>
let store: LibsqlCanvasDocStore

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-ws-tree-persist-test-'))
  handle = await createIsolatedDb({ dataDir: tempDir })
  store = new LibsqlCanvasDocStore(handle.db)
})

afterEach(async () => {
  await handle.dispose()
  await rm(tempDir, { recursive: true, force: true })
})

describe('workspace tree persistence', () => {
  it('returns null when no tree has been saved', async () => {
    const result = await loadWorkspaceTree(store, 'ws-nonexistent')
    expect(result).toBeNull()
  })

  it('round-trips a workspace tree through save and load', async () => {
    const doc = new LoroDoc()
    const tree = new WorkspaceTree(doc)
    const folderId = tree.createNode('folder-canvas', 'projects')
    tree.createNode('c-alpha', 'alpha', folderId)
    tree.createNode('c-beta', 'beta', folderId)

    await saveWorkspaceTree(store, 'ws-1', tree)

    const restored = await loadWorkspaceTree(store, 'ws-1')
    expect(restored).not.toBeNull()

    const roots = restored!.children()
    expect(roots).toHaveLength(1)
    expect(roots[0]!.segment).toBe('projects')

    const kids = restored!.children(roots[0]!.id)
    expect(kids).toHaveLength(2)
    expect(kids.map((k) => k.segment).sort()).toEqual(['alpha', 'beta'])
  })

  it('preserves alias resolution after round-trip', async () => {
    const doc = new LoroDoc()
    const tree = new WorkspaceTree(doc)
    const folderId = tree.createNode('f', 'docs')
    tree.createNode('c-readme', 'readme', folderId)

    await saveWorkspaceTree(store, 'ws-alias', tree)
    const restored = await loadWorkspaceTree(store, 'ws-alias')

    const found = restored!.findByAlias('docs/readme')
    expect(found).toBeDefined()
    expect(found!.canvasId).toBe('c-readme')
    expect(restored!.resolveAlias(found!.id)).toBe('docs/readme')
  })

  it('overwrites a previously saved tree', async () => {
    const doc = new LoroDoc()
    const tree = new WorkspaceTree(doc)
    tree.createNode('c-1', 'first')
    await saveWorkspaceTree(store, 'ws-overwrite', tree)

    tree.createNode('c-2', 'second')
    await saveWorkspaceTree(store, 'ws-overwrite', tree)

    const restored = await loadWorkspaceTree(store, 'ws-overwrite')
    const roots = restored!.children()
    expect(roots).toHaveLength(2)
    expect(roots.map((r) => r.segment).sort()).toEqual(['first', 'second'])
  })

  it('isolates trees by workspace id', async () => {
    const doc1 = new LoroDoc()
    const tree1 = new WorkspaceTree(doc1)
    tree1.createNode('c-a', 'from-ws1')
    await saveWorkspaceTree(store, 'ws-a', tree1)

    const doc2 = new LoroDoc()
    const tree2 = new WorkspaceTree(doc2)
    tree2.createNode('c-b', 'from-ws2')
    await saveWorkspaceTree(store, 'ws-b', tree2)

    const restoredA = await loadWorkspaceTree(store, 'ws-a')
    const restoredB = await loadWorkspaceTree(store, 'ws-b')

    expect(restoredA!.children().map((n) => n.segment)).toEqual(['from-ws1'])
    expect(restoredB!.children().map((n) => n.segment)).toEqual(['from-ws2'])
  })
})
