import { vi } from 'vitest'
import { searchDocuments as matchLoadedDocuments } from '../components/workspace-files/search-documents.js'
import type { WorkspaceDocumentEntry } from '../lib/document-entry.js'
import type { WorkspaceFilesSource } from '../lib/files-source.js'

/** Every method a `vi.fn`, so call assertions need no casts. */
export interface FakeFilesSource extends WorkspaceFilesSource {
  listDocuments: ReturnType<typeof vi.fn<() => Promise<readonly WorkspaceDocumentEntry[]>>>
  createDocument: ReturnType<typeof vi.fn<WorkspaceFilesSource['createDocument']>>
  renameDocumentPath: ReturnType<typeof vi.fn<WorkspaceFilesSource['renameDocumentPath']>>
  searchDocuments: ReturnType<typeof vi.fn<WorkspaceFilesSource['searchDocuments']>>
  setDocumentName: ReturnType<typeof vi.fn<WorkspaceFilesSource['setDocumentName']>>
  loadMarkdown: ReturnType<typeof vi.fn<WorkspaceFilesSource['loadMarkdown']>>
  loadSpatialSnapshot: ReturnType<typeof vi.fn<WorkspaceFilesSource['loadSpatialSnapshot']>>
  /** Present only when the test asked for it — see the note in `fakeFilesSource`. */
  setPinned?: ReturnType<typeof vi.fn<NonNullable<WorkspaceFilesSource['setPinned']>>>
}

/**
 * A `WorkspaceFilesSource` whose every method is a spy, prefilled with the
 * quietest possible answers. Override per test with plain async functions —
 * they are wrapped in `vi.fn` here so call assertions work either way.
 *
 * `setPinned` is the exception: it is optional on the seam, and its ABSENCE
 * is what hides the pin affordance (the browser has nowhere to keep a
 * pin). Defaulting it to a spy would make every test look like a daemon.
 *
 * `searchDocuments` is the other: its default answers from whatever
 * `listDocuments` returns rather than from nothing. `[]` looks like the
 * quietest possible answer and is really a source contradicting its own
 * listing — and the panel believes the source, showing a client-side match
 * only while the answer is in flight. A test that typed a query therefore
 * saw its results for ~150ms and then watched them vanish, passing or
 * failing on whether its queries beat the debounce.
 */
export function fakeFilesSource(overrides: Partial<WorkspaceFilesSource> = {}): FakeFilesSource {
  return {
    listDocuments: vi.fn(overrides.listDocuments ?? (async () => [])),
    createDocument: vi.fn(overrides.createDocument ?? (async () => {})),
    renameDocumentPath: vi.fn(overrides.renameDocumentPath ?? (async () => {})),
    searchDocuments: vi.fn(
      overrides.searchDocuments ??
        (async (query: string, limit = 20) => {
          const listed = await (overrides.listDocuments?.() ?? Promise.resolve([]))
          // 1-based `lexicalRank`, because a name/path match IS a keyword
          // hit: without it the fake would be modelling the other kind — a
          // row found by meaning alone, which the panel deliberately renders
          // without a highlight.
          return matchLoadedDocuments(listed, query)
            .slice(0, limit)
            .map((document, index) => ({ document, contexts: [], lexicalRank: index + 1 }))
        }),
    ),
    setDocumentName: vi.fn(overrides.setDocumentName ?? (async () => {})),
    loadMarkdown: vi.fn(overrides.loadMarkdown ?? (async () => '')),
    loadSpatialSnapshot: vi.fn(overrides.loadSpatialSnapshot ?? (async () => new Uint8Array())),
    ...(overrides.setPinned === undefined ? {} : { setPinned: vi.fn(overrides.setPinned) }),
  } as FakeFilesSource
}
