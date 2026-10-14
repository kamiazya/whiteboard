// @vitest-environment node
import { writeMarkdownBody, writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import type { DocumentKind } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserVersionStore } from './browser-version-store.js'
import { createBrowserVersionsBackend } from './browser-versions-backend.js'
import {
  resetBrowserWorkspaceIdForTests,
  setBrowserWorkspaceIdForTests,
} from './browser-workspace-id.js'

// A past state as the browser store answers it: content only, so it names no
// kind of its own and carries both halves, as a markdown note's record does.
function pastState(): LoroDoc {
  const doc = new LoroDoc()
  writeMarkdownBody(doc, '# plan')
  writeSpatialCanvas(doc, {
    nodes: [textNode({ id: 'n1', x: 0, y: 0, width: 10, height: 10, text: 'hi' })],
    edges: [],
  })
  doc.commit()
  return doc
}

function backendOf(kind: DocumentKind) {
  const store = { loadPast: async () => pastState() } as unknown as BrowserVersionStore
  return createBrowserVersionsBackend({
    store,
    record: { readRecord: () => null, applyRestore: async () => {} },
    kind,
  })
}

describe('the browser versions backend reads a past state as the entry kind says', () => {
  it('answers a markdown entry its body', async () => {
    expect(await backendOf('markdown').loadPast('ws', 'note', 'v1')).toEqual({
      kind: 'markdown',
      body: '# plan',
    })
  })

  it('answers a spatial entry its canvas', async () => {
    const past = await backendOf('spatial').loadPast('ws', 'sketch', 'v1')
    expect(past?.kind).toBe('spatial')
    expect(past?.kind === 'spatial' && past.canvas.nodes.map((node) => node.id)).toEqual(['n1'])
  })
})

/**
 * The backend over a store whose writes are recorded, and a record whose
 * restores are. `bookmarkFails` rejects only the save a restore leaves behind,
 * so the restore itself still lands.
 */
function recordingBackend({ bookmarkFails = false } = {}) {
  const save = vi.fn(async (_workspaceId: string, _path: string, opts: object) => {
    if (bookmarkFails && 'restoredFrom' in opts) throw new Error('quota exceeded')
    return { id: 'v-new' }
  })
  const store = {
    save,
    list: async () => [{ id: 'v1', label: 'Before the rewrite' }],
    loadPast: async () => pastState(),
  } as unknown as BrowserVersionStore
  const applyRestore = vi.fn(async (_past: LoroDoc, _label?: string) => {})
  const backend = createBrowserVersionsBackend({
    store,
    record: { readRecord: () => null, applyRestore },
    kind: 'spatial',
  })
  return { backend, save, applyRestore }
}

describe('the browser versions backend files saves and restores', () => {
  beforeEach(() => setBrowserWorkspaceIdForTests('ws-browser'))
  afterEach(() => resetBrowserWorkspaceIdForTests())

  // The timeline names a version's author from its operator: `human` reads
  // as "You", and a version without one names nobody.
  it('files a save as the person at this browser, under their label', async () => {
    const { backend, save } = recordingBackend()
    await backend.save('ignored', 'sketch', { label: 'Mine' })
    expect(save).toHaveBeenCalledWith('ws-browser', 'sketch', {
      label: 'Mine',
      operator: { kind: 'human' },
    })
  })

  it("hands a restore the restored version's label", async () => {
    const { backend, applyRestore } = recordingBackend()
    await backend.restore('ignored', 'sketch', 'v1')
    expect(applyRestore.mock.calls.map(([, label]) => label)).toEqual(['Before the rewrite'])
  })

  // The content has already landed when the bookmark is written, so failing
  // the restore would report a rewritten document as untouched.
  it('resolves a restore whose bookmark could not be saved', async () => {
    const { backend, save, applyRestore } = recordingBackend({ bookmarkFails: true })
    await expect(backend.restore('ignored', 'sketch', 'v1')).resolves.toBeUndefined()
    expect(applyRestore).toHaveBeenCalledOnce()
    expect(save).toHaveBeenCalledWith('ws-browser', 'sketch', { restoredFrom: 'v1' })
  })
})
