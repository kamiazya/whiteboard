import { vi } from 'vitest'
import type { WorkspaceDocumentEntry } from '../components/workspace-files/document-entry.js'
import type { WorkspaceFilesSource } from '../components/workspace-files/files-source.js'

/** Every method a `vi.fn`, so call assertions need no casts. */
export interface FakeFilesSource extends WorkspaceFilesSource {
  listDocuments: ReturnType<typeof vi.fn<() => Promise<readonly WorkspaceDocumentEntry[]>>>
  createDocument: ReturnType<typeof vi.fn<WorkspaceFilesSource['createDocument']>>
  renameDocumentPath: ReturnType<typeof vi.fn<WorkspaceFilesSource['renameDocumentPath']>>
  setDocumentName: ReturnType<typeof vi.fn<WorkspaceFilesSource['setDocumentName']>>
  loadMarkdown: ReturnType<typeof vi.fn<WorkspaceFilesSource['loadMarkdown']>>
  loadSpatialSnapshot: ReturnType<typeof vi.fn<WorkspaceFilesSource['loadSpatialSnapshot']>>
}

/**
 * A `WorkspaceFilesSource` whose every method is a spy, prefilled with the
 * quietest possible answers. Override per test with plain async functions —
 * they are wrapped in `vi.fn` here so call assertions work either way.
 */
export function fakeFilesSource(overrides: Partial<WorkspaceFilesSource> = {}): FakeFilesSource {
  return {
    listDocuments: vi.fn(overrides.listDocuments ?? (async () => [])),
    createDocument: vi.fn(overrides.createDocument ?? (async () => {})),
    renameDocumentPath: vi.fn(overrides.renameDocumentPath ?? (async () => {})),
    setDocumentName: vi.fn(overrides.setDocumentName ?? (async () => {})),
    loadMarkdown: vi.fn(overrides.loadMarkdown ?? (async () => '')),
    loadSpatialSnapshot: vi.fn(overrides.loadSpatialSnapshot ?? (async () => new Uint8Array())),
  } as FakeFilesSource
}
