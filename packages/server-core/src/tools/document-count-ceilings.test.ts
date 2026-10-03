// The per-request document ceilings of `wb_document_get` (20) and
// `wb_version_save` (50). Both are part of the published input schema, so the
// numbers are pinned as literals rather than imported.

import { describe, expect, test } from 'vitest'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { createDocumentGetTool } from './document-get.js'
import { versionSaveInputSchema } from './version-save.js'

const ids = (count: number) =>
  Array.from({ length: count }, (_, i) => `01H8XJZ9K5N4M3P2Q1R0S9T8${String(i).padStart(2, '0')}`)

describe('wb_document_get — documents per request', () => {
  const schema = createDocumentGetTool(makeTestDeps()).inputSchema
  const request = (count: number) => ({ workspaceId: 'ws-1', documentIds: ids(count) })

  test('accepts 20 documents', () => {
    expect(schema.safeParse(request(20)).success).toBe(true)
  })

  test('refuses 21 documents', () => {
    expect(schema.safeParse(request(21)).success).toBe(false)
  })
})

describe('wb_version_save — documents per request', () => {
  const request = (count: number) => ({
    workspaceId: 'ws-1',
    label: 'checkpoint',
    documentIds: ids(count),
  })

  test('accepts 50 documents', () => {
    expect(versionSaveInputSchema.safeParse(request(50)).success).toBe(true)
  })

  test('refuses 51 documents', () => {
    expect(versionSaveInputSchema.safeParse(request(51)).success).toBe(false)
  })
})
