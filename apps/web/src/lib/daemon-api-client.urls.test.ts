import { describe, expect, it, vi } from 'vitest'
import {
  deleteDocument,
  fetchFontFile,
  getDocumentBacklinks,
  getDocumentOkfV1,
  getWorkspaceDocumentTags,
  getWorkspaceNames,
  linkifyDocumentMentions,
  listFonts,
  renameDocumentPath,
  searchWorkspaceDocuments,
  setDocumentDisplayName,
  setDocumentPinned,
} from './daemon-api-client.js'
import { createDaemonVersionsBackend } from './versions-backend.js'

// The URL each client function put on the wire before its path moved onto the
// shared builders, written out literally: the move must not change a byte.
const BASE = 'http://daemon.test'
const WS = 'ws a'
const PATH = 'notes/a b'

async function urlOf(call: (fetchFn: typeof fetch) => Promise<unknown>): Promise<string> {
  let seen = ''
  const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
    seen = String(input)
    return new Response('{}', { status: 500 })
  })
  await call(fetchFn as unknown as typeof fetch).catch(() => undefined)
  return seen
}

describe('daemon-api-client request URLs', () => {
  it.each([
    [
      'renameDocumentPath',
      (f: typeof fetch) => renameDocumentPath(f, BASE, WS, PATH, 'x'),
      `${BASE}/api/workspaces/ws%20a/documents/notes/a%20b/path`,
    ],
    [
      'deleteDocument',
      (f: typeof fetch) => deleteDocument(f, BASE, WS, PATH),
      `${BASE}/api/workspaces/ws%20a/documents/notes/a%20b`,
    ],
    [
      'setDocumentPinned',
      (f: typeof fetch) => setDocumentPinned(f, BASE, WS, PATH, true),
      `${BASE}/api/workspaces/ws%20a/documents/notes/a%20b/pin`,
    ],
    [
      'setDocumentDisplayName',
      (f: typeof fetch) => setDocumentDisplayName(f, BASE, WS, PATH, 'n'),
      `${BASE}/api/workspaces/ws%20a/documents/notes/a%20b/name`,
    ],
    [
      'getWorkspaceNames',
      (f: typeof fetch) => getWorkspaceNames(f, BASE, WS),
      `${BASE}/api/workspaces/ws%20a/names`,
    ],
    [
      'getDocumentBacklinks',
      (f: typeof fetch) => getDocumentBacklinks(f, BASE, WS, 'd/1'),
      `${BASE}/api/v1/workspaces/ws%20a/documents/d%2F1/backlinks`,
    ],
    [
      'searchWorkspaceDocuments',
      (f: typeof fetch) => searchWorkspaceDocuments(f, BASE, WS, 'plan x', 7),
      `${BASE}/api/v1/workspaces/ws%20a/search?q=plan+x&limit=7`,
    ],
    [
      'getWorkspaceDocumentTags',
      (f: typeof fetch) => getWorkspaceDocumentTags(f, BASE, WS),
      `${BASE}/api/v1/workspaces/ws%20a/document-tags`,
    ],
    [
      'linkifyDocumentMentions',
      (f: typeof fetch) => linkifyDocumentMentions(f, BASE, WS, 'd/1', 'd/2'),
      `${BASE}/api/v1/workspaces/ws%20a/documents/d%2F1/linkify-mentions`,
    ],
    [
      'getDocumentOkfV1',
      (f: typeof fetch) => getDocumentOkfV1(f, BASE, WS, 'd/1'),
      `${BASE}/api/v1/workspaces/ws%20a/documents/d%2F1/okf`,
    ],
    ['listFonts', (f: typeof fetch) => listFonts(f, BASE), `${BASE}/api/fonts`],
    [
      'fetchFontFile',
      (f: typeof fetch) => fetchFontFile(f, BASE, 'f/1'),
      `${BASE}/api/fonts/f%2F1/file`,
    ],
  ])('%s', async (_name, call, before) => {
    expect(await urlOf(call)).toBe(before)
  })

  it('addresses the versions routes the way the daemon backend always has', async () => {
    const seen: string[] = []
    const capture = createDaemonVersionsBackend((async (input: RequestInfo | URL) => {
      seen.push(String(input))
      return new Response('{}', { status: 500 })
    }) as typeof fetch)
    await capture.list(WS, PATH).catch(() => undefined)
    await capture.loadPast(WS, PATH, 'v/1').catch(() => undefined)
    await capture.save(WS, PATH, { label: 'l' }).catch(() => undefined)
    await capture.restore(WS, PATH, 'v/1').catch(() => undefined)
    expect(seen).toEqual([
      '/api/workspaces/ws%20a/documents/notes/a%20b/versions',
      '/api/workspaces/ws%20a/documents/notes/a%20b/versions/v%2F1/document',
      '/api/workspaces/ws%20a/documents/notes/a%20b/versions',
      '/api/workspaces/ws%20a/documents/notes/a%20b/versions/v%2F1/restore',
    ])
  })
})
