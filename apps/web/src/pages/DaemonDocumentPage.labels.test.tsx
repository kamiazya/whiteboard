/**
 * What the daemon page calls an open document where it is not the title: the
 * base of an exported file's name and the node-editor overlay's header. Both
 * read the name the workspace record holds, the way the title box does, and
 * fall back to the document's path only when nobody named it.
 */

import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  setWorkspaceDocumentName,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { act, cleanup, waitFor } from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as daemonApiClient from '../lib/daemon-api-client.js'
import { renderInRouter } from '../test-utils/daemon-page-harness.js'
import { jsonResponse } from '../test-utils/json-response.js'

const DOCUMENT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const PATH = 'notes/untitled-3'

/** The last value each label reached its consumer with. */
const seen = vi.hoisted(() => ({
  filenameBase: undefined as string | undefined,
  overlayTitle: undefined as string | undefined,
}))

vi.mock('../components/workspace-top-bar/useSceneExport.js', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('../components/workspace-top-bar/useSceneExport.js')>()
  return {
    useSceneExport: (options: Parameters<typeof real.useSceneExport>[0]) => {
      seen.filenameBase = options.filenameBase
      return real.useSceneExport(options)
    },
  }
})

vi.mock('../components/document-editor/SpatialEditorPane.js', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('../components/document-editor/SpatialEditorPane.js')>()
  return {
    ...real,
    SpatialEditorPane: (props: Parameters<typeof real.SpatialEditorPane>[0]) => {
      seen.overlayTitle = props.overlayTitle
      return real.SpatialEditorPane(props)
    },
  }
})

vi.mock('../lib/daemon-api-client.js', async (importOriginal) =>
  (await import('../test-utils/daemon-page-harness.js')).daemonApiClientMock(importOriginal, [
    'listWorkspaces',
    'listDocuments',
  ]),
)

const daemon = vi.hoisted(() => ({ name: undefined as string | undefined }))

vi.mock('@kamiazya/whiteboard-daemon-client/sse-backend', async () =>
  (await import('../test-utils/daemon-page-harness.js')).fakeSseBackendModule({
    snapshotFor: () => {
      const record = new LoroDoc()
      createWorkspaceDocumentAtPath(record, {
        path: PATH,
        documentId: DOCUMENT_ID,
        kind: 'spatial',
      })
      writeSpatialCanvas(documentContainers(record, DOCUMENT_ID), { nodes: [], edges: [] })
      record.commit()
      if (daemon.name !== undefined) {
        setWorkspaceDocumentName(record, { documentId: DOCUMENT_ID, name: daemon.name })
      }
      return record.export({ mode: 'snapshot' })
    },
  }),
)

vi.mock('../lib/replica-refresh.js', async () =>
  (await import('../test-utils/daemon-page-harness.js')).replicaRefreshMock(),
)

const { DaemonDocumentPage } = await import('./DaemonDocumentPage.js')
const { daemonDocumentLabels } = await import('./daemon-document-slots.js')

describe('DaemonDocumentPage labels', () => {
  beforeEach(() => {
    window.localStorage.clear()
    seen.filenameBase = undefined
    seen.overlayTitle = undefined
    daemon.name = undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes('/names')
          ? jsonResponse({ documents: {}, pinned: [] })
          : jsonResponse({}, 404),
      ),
    )
    vi.mocked(daemonApiClient.listWorkspaces).mockResolvedValue({
      workspaces: [{ workspaceId: 'w1' }],
    })
    vi.mocked(daemonApiClient.listDocuments).mockResolvedValue({
      documents: [
        { path: PATH, documentId: DOCUMENT_ID, updatedAt: '2026-01-01', kind: 'spatial' },
      ],
    })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  async function openPage(): Promise<void> {
    await act(async () => {
      renderInRouter(
        <DaemonDocumentPage daemonBaseUrl="http://127.0.0.1:3099" workspaceId="w1" path={PATH} />,
        { container: document.body },
      )
    })
  }

  it('exports and heads the overlay with the recorded name', async () => {
    daemon.name = 'Weekly review'
    await openPage()

    await waitFor(() => expect(seen.overlayTitle).toBe('Weekly review'))
    expect(seen.filenameBase).toBe('Weekly review')
  })

  it('falls back to the path for a document nobody named', async () => {
    await openPage()

    await waitFor(() => expect(seen.overlayTitle).toBe(PATH))
    expect(seen.filenameBase).toBe('notes-untitled-3')
  })
})

describe('daemonDocumentLabels names', () => {
  const canvas = { workspaceId: 'w1', path: PATH }
  const nameOf = (names: Parameters<typeof daemonDocumentLabels>[1]) => {
    const labels = daemonDocumentLabels(canvas, names)
    expect(labels.exportFilenameBase).toBe(labels.overlayTitle)
    return labels.overlayTitle
  }

  it("takes the listing's name until the record has been read", () => {
    expect(nameOf({ recorded: undefined, listed: 'Weekly review' })).toBe('Weekly review')
  })

  it('takes the recorded name over the listing once the record is read', () => {
    expect(nameOf({ recorded: 'Renamed', listed: 'Weekly review' })).toBe('Renamed')
  })

  it("lets a record holding no name overrule the listing's older one", () => {
    expect(nameOf({ recorded: null, listed: 'Weekly review' })).toBe(PATH)
  })
})
