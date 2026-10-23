/**
 * The browser keeper's write of the tag library (ADR-0040 decision 5): the
 * document at `tags`, created when the workspace has none and otherwise
 * edited in place, read back by the same source's `readTagLibrary`.
 */
import 'fake-indexeddb/auto'
import { TAG_LIBRARY_PATH } from '@kamiazya/whiteboard-plugin-visual'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { createBrowserFilesSource } from './browser-files-source.js'

claimIsolatedWhiteboardDb('browser-files-source-tag-library')

describe('createBrowserFilesSource writeTagLibrary', () => {
  beforeEach(clearWhiteboardDb)

  it('creates the tags document when the workspace has none, and reads the library back', async () => {
    const source = createBrowserFilesSource()
    const library = { kind: { values: { service: { color: '5' as const } } } }
    await source.writeTagLibrary?.(library)
    await expect(source.readTagLibrary?.()).resolves.toEqual(library)
    const listed = await source.listDocuments()
    expect(listed.filter((entry) => entry.path === TAG_LIBRARY_PATH)).toHaveLength(1)
    expect(listed.find((entry) => entry.path === TAG_LIBRARY_PATH)?.kind).toBe('markdown')
  })

  it('replaces the library in the existing document rather than creating a second', async () => {
    const source = createBrowserFilesSource()
    await source.writeTagLibrary?.({ kind: { values: { service: { color: '5' } } } })
    await source.writeTagLibrary?.({ kind: { values: { service: { color: '1' } } } })
    await expect(source.readTagLibrary?.()).resolves.toEqual({
      kind: { values: { service: { color: '1' } } },
    })
    const listed = await source.listDocuments()
    expect(listed.filter((entry) => entry.path === TAG_LIBRARY_PATH)).toHaveLength(1)
  })
})
