import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  documentDuplicateByIdApiUrl,
  documentNameByIdApiUrl,
  documentPathByIdApiUrl,
  documentPinByIdApiUrl,
  documentRecordByIdApiUrl,
  documentVersionsByIdApiUrl,
  documentVersionsPageByIdApiUrl,
  versionDocumentByIdApiUrl,
  versionRestoreByIdApiUrl,
} from './daemon-urls.js'
import {
  type DocumentApiAction,
  documentByIdApiUrl,
  documentFileByIdApiUrl,
} from './document-url.js'

const WS = '01TFTP6SMY23MTM63TK63WD2YX'
const ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const BASE = `/api/workspaces/${WS}/documents/${ID}`

describe('document id URL builders', () => {
  it('builds the action routes from the one action vocabulary', () => {
    expect(documentByIdApiUrl(WS, ID, 'snapshot')).toBe(`${BASE}/snapshot`)
    expect(documentByIdApiUrl(WS, ID, 'export-svg')).toBe(`${BASE}/export-svg`)
    expect(documentByIdApiUrl('a b', ID, 'client-count')).toBe(
      `/api/workspaces/a%20b/documents/${ID}/client-count`,
    )
    expectTypeOf<Parameters<typeof documentByIdApiUrl>[2]>().toEqualTypeOf<DocumentApiAction>()
  })

  it('encodes a file id as data', () => {
    expect(documentFileByIdApiUrl(WS, ID, 'abc')).toBe(`${BASE}/files/abc`)
    expect(documentFileByIdApiUrl(WS, ID, 'a/b')).toBe(`${BASE}/files/a%2Fb`)
  })

  it('builds the record family', () => {
    expect(documentRecordByIdApiUrl(WS, ID)).toBe(BASE)
    expect(documentPathByIdApiUrl(WS, ID)).toBe(`${BASE}/path`)
    expect(documentNameByIdApiUrl(WS, ID)).toBe(`${BASE}/name`)
    expect(documentPinByIdApiUrl(WS, ID)).toBe(`${BASE}/pin`)
    expect(documentDuplicateByIdApiUrl(WS, ID)).toBe(`${BASE}/duplicate`)
    expect(documentVersionsByIdApiUrl(WS, ID)).toBe(`${BASE}/versions`)
  })

  it('builds a versions page query and encodes the version id', () => {
    expect(documentVersionsPageByIdApiUrl(WS, ID)).toBe(`${BASE}/versions`)
    expect(documentVersionsPageByIdApiUrl(WS, ID, { cursor: 'c 1', limit: 5 })).toBe(
      `${BASE}/versions?cursor=c+1&limit=5`,
    )
    expect(versionDocumentByIdApiUrl(WS, ID, 'v/1')).toBe(`${BASE}/versions/v%2F1/document`)
    expect(versionRestoreByIdApiUrl(WS, ID, 'v1')).toBe(`${BASE}/versions/v1/restore`)
  })

  it('refuses a dot segment instead of resolving it away', () => {
    expect(() => documentRecordByIdApiUrl(WS, '..')).toThrow(/dot segment/)
    expect(() => documentFileByIdApiUrl(WS, ID, '.')).toThrow(/dot segment/)
  })
})
