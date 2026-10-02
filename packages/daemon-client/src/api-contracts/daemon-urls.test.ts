import { describe, expect, it } from 'vitest'
import * as urls from './daemon-urls.js'
import { workspaceDocumentApiUrl } from './document-url.js'

// The literal strings the clients built by hand before the builders existed:
// moving a call onto a builder must not change a byte on the wire.
const WS = 'ws a'
const PATH = 'notes/a b/é'
const ENC_WS = 'ws%20a'
const ENC_PATH = 'notes/a%20b/%C3%A9'

describe('daemon URL builders keep the bytes clients sent before', () => {
  it.each([
    ['workspacesApiUrl', urls.workspacesApiUrl(), '/api/workspaces'],
    ['workspaceApiUrl', urls.workspaceApiUrl(WS), `/api/workspaces/${ENC_WS}`],
    ['workspaceNamesApiUrl', urls.workspaceNamesApiUrl(WS), `/api/workspaces/${ENC_WS}/names`],
    [
      'workspaceDocumentsApiUrl',
      urls.workspaceDocumentsApiUrl(WS),
      `/api/workspaces/${ENC_WS}/documents`,
    ],
    [
      'documentRecordApiUrl',
      urls.documentRecordApiUrl(WS, PATH),
      `/api/workspaces/${ENC_WS}/documents/${ENC_PATH}`,
    ],
    [
      'documentPathApiUrl',
      urls.documentPathApiUrl(WS, PATH),
      `/api/workspaces/${ENC_WS}/documents/${ENC_PATH}/path`,
    ],
    [
      'documentNameApiUrl',
      urls.documentNameApiUrl(WS, PATH),
      `/api/workspaces/${ENC_WS}/documents/${ENC_PATH}/name`,
    ],
    [
      'documentPinApiUrl',
      urls.documentPinApiUrl(WS, PATH),
      `/api/workspaces/${ENC_WS}/documents/${ENC_PATH}/pin`,
    ],
    [
      'documentVersionsApiUrl',
      urls.documentVersionsApiUrl(WS, PATH),
      `/api/workspaces/${ENC_WS}/documents/${ENC_PATH}/versions`,
    ],
    [
      'versionDocumentApiUrl',
      urls.versionDocumentApiUrl(WS, PATH, 'v/1'),
      `/api/workspaces/${ENC_WS}/documents/${ENC_PATH}/versions/v%2F1/document`,
    ],
    [
      'versionRestoreApiUrl',
      urls.versionRestoreApiUrl(WS, PATH, 'v/1'),
      `/api/workspaces/${ENC_WS}/documents/${ENC_PATH}/versions/v%2F1/restore`,
    ],
    ['trashApiUrl', urls.trashApiUrl(WS), `/api/workspaces/${ENC_WS}/trash`],
    [
      'trashRestoreApiUrl',
      urls.trashRestoreApiUrl(WS, 'd/1'),
      `/api/workspaces/${ENC_WS}/trash/d%2F1/restore`,
    ],
    [
      'optimizeAllApiUrl',
      urls.optimizeAllApiUrl(WS),
      `/api/workspaces/${ENC_WS}/documents/optimize-all`,
    ],
    [
      'pruneSandwichedApiUrl',
      urls.pruneSandwichedApiUrl(WS),
      `/api/workspaces/${ENC_WS}/versions/prune-sandwiched`,
    ],
    [
      'purgeDanglingApiUrl',
      urls.purgeDanglingApiUrl(WS),
      `/api/workspaces/${ENC_WS}/files/purge-dangling`,
    ],
    ['storageReportApiUrl', urls.storageReportApiUrl(), '/api/runtime/storage'],
    ['logsPruneApiUrl', urls.logsPruneApiUrl(), '/api/runtime/logs/prune'],
    ['documentsV1ApiUrl', urls.documentsV1ApiUrl(WS), `/api/v1/workspaces/${ENC_WS}/documents`],
    [
      'documentBacklinksApiUrl',
      urls.documentBacklinksApiUrl(WS, 'd/1'),
      `/api/v1/workspaces/${ENC_WS}/documents/d%2F1/backlinks`,
    ],
    [
      'linkifyMentionsApiUrl',
      urls.linkifyMentionsApiUrl(WS, 'd/1'),
      `/api/v1/workspaces/${ENC_WS}/documents/d%2F1/linkify-mentions`,
    ],
    [
      'documentOkfApiUrl',
      urls.documentOkfApiUrl(WS, 'd/1'),
      `/api/v1/workspaces/${ENC_WS}/documents/d%2F1/okf`,
    ],
    [
      'documentTagsApiUrl',
      urls.documentTagsApiUrl(WS),
      `/api/v1/workspaces/${ENC_WS}/document-tags`,
    ],
    [
      'searchApiUrl',
      urls.searchApiUrl(WS, { query: 'plan x', limit: 10 }),
      `/api/v1/workspaces/${ENC_WS}/search?q=plan+x&limit=10`,
    ],
    ['fontsApiUrl', urls.fontsApiUrl(), '/api/fonts'],
    ['fontInstallApiUrl', urls.fontInstallApiUrl('f/1'), '/api/fonts/f%2F1/install'],
    ['fontFileApiUrl', urls.fontFileApiUrl('f/1'), '/api/fonts/f%2F1/file'],
    [
      'workspaceDocumentApiUrl',
      workspaceDocumentApiUrl(WS, 'promote'),
      `/api/w/${ENC_WS}/workspace-document/promote`,
    ],
  ])('%s', (_name, built, before) => {
    expect(built).toBe(before)
  })
})
