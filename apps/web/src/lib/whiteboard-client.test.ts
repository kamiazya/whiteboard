// @vitest-environment node
import { documentIdSchema } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { documentSnapshotSchema } from './whiteboard-client.js'

const row = {
  documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  workspaceId: 'local',
  path: 'design/login',
  name: 'Login flow',
  updatedAt: '2026-05-01T12:00:00.000Z',
  kind: 'markdown' as const,
}

describe('documentSnapshotSchema', () => {
  // The whole point of the shape change: a local document is addressed the
  // way the daemon addresses one, so the same port contracts can describe
  // both. `DocRef` takes a ULID; a UUID cannot satisfy it.
  it('addresses a document by ULID, workspace and path', () => {
    const parsed = documentSnapshotSchema.parse(row)
    expect(() => documentIdSchema.parse(parsed.documentId)).not.toThrow()
    expect(parsed.workspaceId).toBe('local')
    expect(parsed.path).toBe('design/login')
  })

  // Every one of the three is required. A row missing any of them cannot be
  // turned into a `DocRef`, which is the entire reason the shape changed —
  // and the fixture above passes all three, so only their ABSENCE reaches
  // the rule.
  it.each(['documentId', 'workspaceId', 'path'])('requires %s', (field) => {
    const { [field]: _missing, ...without } = row as Record<string, unknown>
    expect(() => documentSnapshotSchema.parse(without)).toThrow()
  })

  // A UUID parses as a string but is not a document id anywhere else in the
  // system — accepting one here is how the two halves drifted apart.
  it('refuses an id that is not a document id', () => {
    expect(() =>
      documentSnapshotSchema.parse({ ...row, documentId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479' }),
    ).toThrow()
  })

  // Uppercase IS allowed — the daemon's own segment pattern is
  // `[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?`. What it refuses is an empty
  // segment or a non-ASCII one, which is what makes `..` traversal
  // unexpressible once segments are joined.
  it('refuses a path the daemon would refuse, and allows one it would not', () => {
    expect(() => documentSnapshotSchema.parse({ ...row, path: 'Design/Login' })).not.toThrow()
    expect(() => documentSnapshotSchema.parse({ ...row, path: '' })).toThrow()
    expect(() => documentSnapshotSchema.parse({ ...row, path: 'design/' })).toThrow()
    expect(() => documentSnapshotSchema.parse({ ...row, path: 'design//login' })).toThrow()
    expect(() => documentSnapshotSchema.parse({ ...row, path: '設計' })).toThrow()
  })

  // Kind still defaults, for the same reason it always did: rows written
  // before it existed are spatial, and the content lives in the Loro doc
  // either way.
  it('still defaults the kind to spatial', () => {
    const { kind: _dropped, ...withoutKind } = row
    expect(documentSnapshotSchema.parse(withoutKind).kind).toBe('spatial')
  })

  // Elements are canonical in the Loro doc. This row is metadata, and the
  // day it grows a scene field the two stores start disagreeing.
  it('refuses a scene field outright', () => {
    expect(() => documentSnapshotSchema.parse({ ...row, scene: { nodes: [] } })).toThrow()
  })
})
