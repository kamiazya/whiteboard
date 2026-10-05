/**
 * Roundtrip serialization tests for the canvas api-contract schemas.
 *
 * Each test verifies three invariants:
 *   1. A well-formed value parses successfully.
 *   2. JSON stringify → parse → schema.parse produces an equal result
 *      (no field drift through the wire format).
 *   3. A malformed / missing-required value is rejected by safeParse.
 *
 * z.infer type alignment is checked at the TypeScript level by annotating
 * parsed results with the exported type aliases.
 */
import { versionLabelSchema, workspaceSegmentSchema } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import {
  type CompactWorkspaceResult,
  compactWorkspaceResultSchema,
  createWorkspaceRequestSchema,
  DAEMON_DEFAULT_SEGMENT,
  type DocumentSummary,
  documentSummarySchema,
  type ListDocumentsResponse,
  type ListVersionsResponse,
  type ListWorkspacesResponse,
  listDocumentsResponseSchema,
  listVersionsResponseSchema,
  listWorkspacesResponseSchema,
  type OperatorInfo,
  operatorInfoSchema,
  type PruneSandwichedVersionsResponse,
  pruneSandwichedVersionsResponseSchema,
  purgeResultSchema,
  renameWorkspaceRequestSchema,
  restoreVersionRequestSchema,
  restoreVersionResponseSchema,
  type SaveVersionResponse,
  saveVersionRequestSchema,
  saveVersionResponseSchema,
  setNameRequestSchema,
  setPinnedRequestSchema,
  type VersionEntry,
  versionEntrySchema,
  type WorkspaceSummary,
  workspaceSummarySchema,
} from './document.js'
import { roundtrip } from './roundtrip.test-helper.js'

describe('setNameRequestSchema', () => {
  it('parses a non-empty name', () => {
    const result = setNameRequestSchema.parse({ name: 'My Canvas' })
    expect(result.name).toBe('My Canvas')
  })

  it('parses an empty string (delete-name semantics)', () => {
    const result = setNameRequestSchema.parse({ name: '' })
    expect(result.name).toBe('')
  })

  it('roundtrip preserves name', () => {
    const valid = { name: 'My Canvas' }
    const result = roundtrip(setNameRequestSchema, valid)
    expect(result).toEqual(valid)
  })

  it('rejects missing name', () => {
    expect(setNameRequestSchema.safeParse({}).success).toBe(false)
  })
})

describe('setPinnedRequestSchema', () => {
  it('parses pinned: true', () => {
    const result = setPinnedRequestSchema.parse({ pinned: true })
    expect(result.pinned).toBe(true)
  })

  it('roundtrip preserves pinned: false', () => {
    const valid = { pinned: false }
    const result = roundtrip(setPinnedRequestSchema, valid)
    expect(result).toEqual(valid)
  })

  it('rejects missing pinned', () => {
    expect(setPinnedRequestSchema.safeParse({}).success).toBe(false)
  })
})

describe('operatorInfoSchema', () => {
  const valid: OperatorInfo = { kind: 'ai', actor: 'process:peer-1' }

  it('parses a well-formed value', () => {
    const result: OperatorInfo = operatorInfoSchema.parse(valid)
    expect(result.kind).toBe('ai')
  })

  it('roundtrip with all optional fields', () => {
    const full: OperatorInfo = {
      kind: 'human',
      actor: 'human:alice',
      displayName: 'Alice',
      agentId: 'agent-x',
      workspaceId: 'ws-1',
    }
    const result: OperatorInfo = roundtrip(operatorInfoSchema, full)
    expect(result).toEqual(full)
  })

  it('rejects invalid kind', () => {
    expect(operatorInfoSchema.safeParse({ kind: 'bot', actor: 'process:p' }).success).toBe(false)
  })

  // An actor is OKF's, so the schema is model's `okfActorSchema` rather
  // than a second opinion about what a party looks like: blank and
  // multi-line are what it refuses.
  it('rejects an actor that is not a single non-blank line', () => {
    expect(operatorInfoSchema.safeParse({ kind: 'ai', actor: '' }).success).toBe(false)
    expect(operatorInfoSchema.safeParse({ kind: 'ai', actor: 'a\nb' }).success).toBe(false)
  })

  // The keeper without a device identity — a browser today — records the
  // kind and no actor. Absent is a legal answer; inventing one is what this
  // field stopped doing.
  it('accepts a kind with no actor at all', () => {
    expect(operatorInfoSchema.safeParse({ kind: 'human' }).success).toBe(true)
  })

  // Load-bearing, and the cost of getting it wrong is somebody's whole
  // history. apps/web's `versionRowSchema` is `.strict()` and its reader
  // SKIPS a row that fails to parse, so this object being strict would turn
  // every IndexedDB row written before `peerId` became `actor` into a row
  // that silently does not exist. Stripping the stale key is the behaviour
  // that has to hold.
  it('drops an identifier from before the rename rather than refusing the value', () => {
    const parsed = operatorInfoSchema.safeParse({ kind: 'human', peerId: 'browser' })
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data).toEqual({ kind: 'human' })
  })
})

describe('saveVersionRequestSchema', () => {
  // The request half of the operator is derived from the full one by
  // omission, so a field added to `operatorInfoSchema` is stateable by a
  // caller unless someone deliberately takes it away. `actor` is the one
  // taken away: it names the device, and only the keeper can back that name
  // with a key. Refused rather than stripped, so a caller learns its value
  // did not take effect.
  it('refuses an operator that names the device', () => {
    const parsed = saveVersionRequestSchema.safeParse({
      operator: { kind: 'ai', actor: 'did:key:z6Mkf5rGMoatrSj1f4CyvuHBeXJELe9RPdzo2PKGNCKVtZxP' },
    })
    expect(parsed.success).toBe(false)
  })

  it('accepts the half a caller legitimately knows', () => {
    const parsed = saveVersionRequestSchema.safeParse({
      operator: { kind: 'human', displayName: 'Alice', agentId: 'a-1', workspaceId: 'ws-1' },
    })
    expect(parsed.success).toBe(true)
  })

  it('parses an empty body', () => {
    const result = saveVersionRequestSchema.parse({})
    expect(result.label).toBeUndefined()
  })

  // `wb_version_save` holds the same definition, so a label one surface would
  // refuse cannot be stored through the other and then re-sent with every
  // listing of the document's history.
  it.each([
    ['empty', ''],
    ['one character past the limit', 'x'.repeat(201)],
  ])('refuses a %s label, as the shared label schema does', (_name, label) => {
    expect(versionLabelSchema.safeParse(label).success).toBe(false)
    expect(saveVersionRequestSchema.safeParse({ label }).success).toBe(false)
  })

  it('accepts a label of exactly 200 characters', () => {
    expect(saveVersionRequestSchema.safeParse({ label: 'x'.repeat(200) }).success).toBe(true)
  })

  it('roundtrip with label and operator', () => {
    const valid = {
      label: 'v1.0',
      operator: { kind: 'human' as const, displayName: 'Alice' },
    }
    const result = roundtrip(saveVersionRequestSchema, valid)
    expect(result).toEqual(valid)
  })
})

describe('restoreVersionRequestSchema', () => {
  it('parses an empty body', () => {
    const result = restoreVersionRequestSchema.parse({})
    expect(result.targetPath).toBeUndefined()
  })

  it('roundtrip with targetPath and overwrite', () => {
    const valid = { targetPath: 'new-canvas', overwrite: true }
    const result = roundtrip(restoreVersionRequestSchema, valid)
    expect(result).toEqual(valid)
  })

  it('rejects empty targetPath', () => {
    expect(restoreVersionRequestSchema.safeParse({ targetPath: '' }).success).toBe(false)
    expect(restoreVersionRequestSchema.safeParse({ targetPath: '   ' }).success).toBe(false)
  })
})

describe('restoreVersionResponseSchema', () => {
  it('names the restored target by its ULID and refuses a workspace/path key', () => {
    expect(
      restoreVersionResponseSchema.safeParse({
        documentId: '01H8XJZ9K5N4M3P2Q1R0S9T8V7',
        elementCount: 2,
      }).success,
    ).toBe(true)
    expect(
      restoreVersionResponseSchema.safeParse({ documentId: 'session1/canvas-b', elementCount: 2 })
        .success,
    ).toBe(false)
  })
})

describe('versionEntrySchema', () => {
  const valid: VersionEntry = {
    id: 'ver-1',
    path: 'my-canvas',
    createdAt: '2024-01-01T00:00:00.000Z',
    elementCount: 42,
    auto: false,
  }

  it('parses a well-formed value', () => {
    const result: VersionEntry = versionEntrySchema.parse(valid)
    expect(result.id).toBe('ver-1')
  })

  it('roundtrip preserves all fields', () => {
    const withOptionals: VersionEntry = {
      ...valid,
      label: 'Checkpoint',
      operator: { kind: 'ai', actor: 'process:agent-1' },
    }
    const result: VersionEntry = roundtrip(versionEntrySchema, withOptionals)
    expect(result).toEqual(withOptionals)
  })

  it('rejects non-finite elementCount', () => {
    expect(versionEntrySchema.safeParse({ ...valid, elementCount: Infinity }).success).toBe(false)
    expect(versionEntrySchema.safeParse({ ...valid, elementCount: NaN }).success).toBe(false)
  })

  it('publishes no branchName, and drops one an older daemon still sends', () => {
    expect(Object.keys(versionEntrySchema.shape)).not.toContain('branchName')
    const parsed = versionEntrySchema.parse({ ...valid, branchName: 'main' })
    expect(parsed).not.toHaveProperty('branchName')
  })
})

describe('listVersionsResponseSchema', () => {
  const entry: VersionEntry = {
    id: 'ver-1',
    path: 'canvas',
    createdAt: '2024-01-01T00:00:00.000Z',
    elementCount: 1,
    auto: true,
  }
  const valid: ListVersionsResponse = { versions: [entry] }

  it('parses a well-formed value', () => {
    const result: ListVersionsResponse = listVersionsResponseSchema.parse(valid)
    expect(result.versions).toHaveLength(1)
  })

  it('roundtrip preserves versions array', () => {
    const result: ListVersionsResponse = roundtrip(listVersionsResponseSchema, valid)
    expect(result).toEqual(valid)
  })

  it('rejects missing versions', () => {
    expect(listVersionsResponseSchema.safeParse({}).success).toBe(false)
  })
})

describe('saveVersionResponseSchema', () => {
  const entry: VersionEntry = {
    id: 'ver-2',
    path: 'canvas',
    createdAt: '2024-06-01T00:00:00.000Z',
    elementCount: 5,
    auto: false,
  }
  const valid: SaveVersionResponse = { version: entry }

  it('parses a well-formed value', () => {
    const result: SaveVersionResponse = saveVersionResponseSchema.parse(valid)
    expect(result.version.id).toBe('ver-2')
  })

  it('roundtrip preserves version', () => {
    const result: SaveVersionResponse = roundtrip(saveVersionResponseSchema, valid)
    expect(result).toEqual(valid)
  })

  it('rejects missing version', () => {
    expect(saveVersionResponseSchema.safeParse({}).success).toBe(false)
  })
})

describe('workspaceSummarySchema', () => {
  const valid: WorkspaceSummary = { workspaceId: 'ws-abc' }

  it('parses a well-formed value', () => {
    const result: WorkspaceSummary = workspaceSummarySchema.parse(valid)
    expect(result.workspaceId).toBe('ws-abc')
  })

  it('spells the daemon default segment as the README tells an agent to address it', () => {
    expect(DAEMON_DEFAULT_SEGMENT).toBe('default')
  })

  it('carries the daemon default segment as a well-formed workspace address', () => {
    const result = workspaceSummarySchema.parse({ ...valid, segment: DAEMON_DEFAULT_SEGMENT })
    expect(workspaceSegmentSchema.safeParse(result.segment).success).toBe(true)
  })

  it('roundtrip preserves fields', () => {
    const result: WorkspaceSummary = roundtrip(workspaceSummarySchema, valid)
    expect(result).toEqual(valid)
  })

  it('rejects missing workspaceId', () => {
    expect(workspaceSummarySchema.safeParse({}).success).toBe(false)
  })

  // ADR-0019: old daemons and pre-minting workspaces answer {workspaceId}
  // alone — the widened schema must keep accepting that shape so an old
  // daemon's response and a new client stay compatible.
  it('accepts a bare workspaceId with no segment/displayName', () => {
    expect(workspaceSummarySchema.safeParse({ workspaceId: 'ws-abc' }).success).toBe(true)
  })

  it('accepts segment and displayName when the daemon serves them', () => {
    const full: WorkspaceSummary = {
      workspaceId: 'ws-abc',
      segment: 'team-notes',
      displayName: 'Team notes',
    }
    const result: WorkspaceSummary = workspaceSummarySchema.parse(full)
    expect(result).toEqual(full)
  })

  // The refinement is model's, not a restated copy — this only proves the
  // widened field actually delegates to workspaceSegmentSchema rather than a
  // bare z.string(): a bare string would keep the segment.
  it('reads a ULID-shaped segment as absent, keeping the workspace', () => {
    expect(
      workspaceSummarySchema.parse({
        workspaceId: 'ws-abc',
        segment: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      }),
    ).toEqual({ workspaceId: 'ws-abc' })
  })

  it('accepts a tier when the daemon threads a resolver', () => {
    expect(
      workspaceSummarySchema.safeParse({ workspaceId: 'ws-abc', tier: 'bounded' }).success,
    ).toBe(true)
  })

  it('reads an unknown tier string as not stated, so the row and its siblings stay listed', () => {
    const parsed = workspaceSummarySchema.parse({ workspaceId: 'ws-abc', tier: 'full-offline' })
    expect(parsed).toEqual({ workspaceId: 'ws-abc' })
  })
})

describe('listWorkspacesResponseSchema', () => {
  const valid: ListWorkspacesResponse = { workspaces: [{ workspaceId: 'ws-1' }] }

  it('parses a well-formed value', () => {
    const result: ListWorkspacesResponse = listWorkspacesResponseSchema.parse(valid)
    expect(result.workspaces).toHaveLength(1)
  })

  it('roundtrip preserves workspaces', () => {
    const result: ListWorkspacesResponse = roundtrip(listWorkspacesResponseSchema, valid)
    expect(result).toEqual(valid)
  })

  it('rejects missing workspaces', () => {
    expect(listWorkspacesResponseSchema.safeParse({}).success).toBe(false)
  })

  // A daemon may hold a name stored before the bound. Failing the whole
  // answer over it emptied the switcher of every workspace, not just that one.
  it('lists every workspace when one holds a name past the bound, reading that name as absent', () => {
    const parsed = listWorkspacesResponseSchema.parse({
      workspaces: [
        { workspaceId: 'ws-1', segment: 'one', displayName: 'n'.repeat(201) },
        { workspaceId: 'ws-2', segment: 'two', displayName: 'Two' },
      ],
    })
    expect(parsed.workspaces).toEqual([
      { workspaceId: 'ws-1', segment: 'one' },
      { workspaceId: 'ws-2', segment: 'two', displayName: 'Two' },
    ])
  })
})

describe('documentSummarySchema', () => {
  const valid: DocumentSummary = {
    path: 'canvas-1',
    documentId: 'doc-nanoid-1',
    updatedAt: '2024-01-01T00:00:00.000Z',
    kind: 'spatial',
  }

  it('parses a well-formed value', () => {
    const result: DocumentSummary = documentSummarySchema.parse(valid)
    expect(result.path).toBe('canvas-1')
  })

  it('roundtrip preserves fields', () => {
    const result: DocumentSummary = roundtrip(documentSummarySchema, valid)
    expect(result).toEqual(valid)
  })

  // Was `rejects missing updatedAt`. Required stopped being true when the
  // list route became an adapter over `wbDocumentList`: `DocumentEntry`
  // leaves the field optional because an index may genuinely not own a
  // timestamp — apps/web's IndexedDB index reads them from a separate store —
  // and a response type cannot promise more than the port it reads from.
  //
  // Absent is still not the same as arbitrary: a value that IS present must
  // be a string, which is the half worth keeping.
  it('leaves updatedAt ABSENT rather than requiring one the port cannot promise', () => {
    expect(documentSummarySchema.safeParse({ path: 'canvas-1', documentId: 'x' }).success).toBe(
      true,
    )
    expect(
      documentSummarySchema.safeParse({ path: 'canvas-1', documentId: 'x', updatedAt: 7 }).success,
    ).toBe(false)
  })

  // Absent, not false: a keeper that keeps no pins has said nothing about
  // them, and a client must not read that as "none pinned".
  it('carries pinned as an optional boolean', () => {
    expect(documentSummarySchema.parse({ ...valid, pinned: true }).pinned).toBe(true)
    expect(documentSummarySchema.parse({ ...valid, pinned: false }).pinned).toBe(false)
    expect('pinned' in documentSummarySchema.parse(valid)).toBe(false)
    expect(documentSummarySchema.safeParse({ ...valid, pinned: 'yes' }).success).toBe(false)
  })

  it('accepts an explicit kind: markdown', () => {
    const result = documentSummarySchema.parse({ ...valid, kind: 'markdown' })
    expect(result.kind).toBe('markdown')
  })

  // The id is what the workspace-granularity sync contract binds a session's
  // content by, so a summary without one leaves the client no document to
  // sync — required. `kind` follows the port's optional promise (the list
  // route is an adapter over wbDocumentList), though in practice a
  // workspace-tree entry always carries one.
  it('rejects a summary without a documentId', () => {
    const { documentId: _id, ...withoutId } = valid
    expect(documentSummarySchema.safeParse(withoutId).success).toBe(false)
  })

  // The port, /api/v1 and wb_document_list all say documentId and name; a
  // summary spelling them id and displayName is the surface that disagreed.
  it('refuses the id and displayName spelling the other document surfaces never used', () => {
    expect(
      documentSummarySchema.safeParse({ path: 'a', id: 'x', displayName: 'Weekly review' }).success,
    ).toBe(false)
  })

  it('carries the name the user chose under name', () => {
    const parsed = documentSummarySchema.parse({ ...valid, name: 'Weekly review' })
    expect(parsed.name).toBe('Weekly review')
  })

  it('accepts a summary without a kind — the port leaves it optional', () => {
    const { kind: _kind, ...withoutKind } = valid
    expect(documentSummarySchema.safeParse(withoutKind).success).toBe(true)
  })

  it('reads an unknown kind as absent, the same as a row the port gave none', () => {
    const parsed = documentSummarySchema.parse({ ...valid, kind: 'bogus' })
    expect(parsed.kind).toBeUndefined()
    expect(parsed.path).toBe(valid.path)
  })
})

describe('listDocumentsResponseSchema', () => {
  const valid: ListDocumentsResponse = {
    documents: [
      {
        path: 'canvas-1',
        documentId: 'doc-nanoid-1',
        updatedAt: '2024-01-01T00:00:00.000Z',
        kind: 'spatial',
      },
    ],
  }

  it('parses a well-formed value', () => {
    const result: ListDocumentsResponse = listDocumentsResponseSchema.parse(valid)
    expect(result.documents).toHaveLength(1)
  })

  it('roundtrip preserves documents', () => {
    const result: ListDocumentsResponse = roundtrip(listDocumentsResponseSchema, valid)
    expect(result).toEqual(valid)
  })

  it('rejects missing documents', () => {
    expect(listDocumentsResponseSchema.safeParse({}).success).toBe(false)
  })
})

describe('compactWorkspaceResultSchema', () => {
  const valid: CompactWorkspaceResult = {
    compacted: true,
    beforeBytes: 4096,
    afterBytes: 1024,
    reason: 'ok',
  }

  it('parses a well-formed value', () => {
    const result: CompactWorkspaceResult = compactWorkspaceResultSchema.parse(valid)
    expect(result.beforeBytes).toBe(4096)
  })

  it('roundtrip preserves fields', () => {
    const result: CompactWorkspaceResult = roundtrip(compactWorkspaceResultSchema, valid)
    expect(result).toEqual(valid)
  })

  it('reads a reason it cannot place as the one that claims least, not as a failed pass', () => {
    // A newer daemon's new reason must not turn a pass that ran into an error.
    expect(compactWorkspaceResultSchema.parse({ ...valid, reason: 'because' }).reason).toBe(
      'no-gain',
    )
    expect(
      compactWorkspaceResultSchema.parse({ compacted: false, beforeBytes: 4096, afterBytes: 4096 })
        .reason,
    ).toBe('no-gain')
  })

  it('rejects negative or fractional byte counts', () => {
    expect(compactWorkspaceResultSchema.safeParse({ ...valid, beforeBytes: -1 }).success).toBe(
      false,
    )
    expect(compactWorkspaceResultSchema.safeParse({ ...valid, afterBytes: 1.5 }).success).toBe(
      false,
    )
  })
})

describe('pruneSandwichedVersionsResponseSchema', () => {
  const valid: PruneSandwichedVersionsResponse = { totalDeleted: 3 }

  it('parses a well-formed value', () => {
    const result: PruneSandwichedVersionsResponse =
      pruneSandwichedVersionsResponseSchema.parse(valid)
    expect(result.totalDeleted).toBe(3)
  })

  it('roundtrip preserves fields', () => {
    const result: PruneSandwichedVersionsResponse = roundtrip(
      pruneSandwichedVersionsResponseSchema,
      valid,
    )
    expect(result).toEqual(valid)
  })

  it('rejects missing totalDeleted', () => {
    expect(pruneSandwichedVersionsResponseSchema.safeParse({}).success).toBe(false)
  })

  it('rejects a negative or fractional deletion count', () => {
    expect(pruneSandwichedVersionsResponseSchema.safeParse({ totalDeleted: -2 }).success).toBe(
      false,
    )
    expect(pruneSandwichedVersionsResponseSchema.safeParse({ totalDeleted: 0.5 }).success).toBe(
      false,
    )
  })
})

describe('purgeResultSchema', () => {
  const valid = { purgedCount: 2, purgedBytes: 4096 }

  it('parses a well-formed value', () => {
    const result = purgeResultSchema.parse(valid)
    expect(result.purgedCount).toBe(2)
  })

  it('roundtrip preserves fields', () => {
    const result = roundtrip(purgeResultSchema, valid)
    expect(result).toEqual(valid)
  })

  it('reads a skipped reason it does not know as absent, keeping the counts', () => {
    const result = purgeResultSchema.parse({ ...valid, skippedReason: 'a-newer-reason' })
    expect(result.skippedReason).toBeUndefined()
    expect(result.purgedCount).toBe(2)
    expect(
      purgeResultSchema.parse({ ...valid, skippedReason: 'backup-in-progress' }),
    ).toMatchObject({ skippedReason: 'backup-in-progress' })
  })

  it('rejects missing purgedBytes', () => {
    expect(purgeResultSchema.safeParse({ purgedCount: 2 }).success).toBe(false)
  })

  it('rejects negative or fractional counts and byte totals', () => {
    expect(purgeResultSchema.safeParse({ purgedCount: -1, purgedBytes: 0 }).success).toBe(false)
    expect(purgeResultSchema.safeParse({ purgedCount: 0, purgedBytes: 0.5 }).success).toBe(false)
  })
})

describe('createWorkspaceRequestSchema', () => {
  it('parses a well-formed value', () => {
    const result = createWorkspaceRequestSchema.parse({
      displayName: 'Marketing',
    })
    expect(result.displayName).toBe('Marketing')
  })

  it('roundtrip preserves fields', () => {
    const valid = { displayName: 'Marketing' }
    expect(roundtrip(createWorkspaceRequestSchema, valid)).toEqual(valid)
  })

  it('requires a display name — a workspace with no name has nothing to show', () => {
    expect(createWorkspaceRequestSchema.safeParse({}).success).toBe(false)
    expect(createWorkspaceRequestSchema.safeParse({ displayName: '' }).success).toBe(false)
    expect(createWorkspaceRequestSchema.safeParse({ displayName: '  padded  ' }).success).toBe(
      false,
    )
  })

  it('refuses a caller-chosen segment or id rather than dropping it', () => {
    // Both are the server's to decide (ADR-0019): the id is minted, and the
    // segment is derived so the two keepers' create surfaces agree. A body
    // naming either is refused, so a caller is told the value did not take
    // effect instead of reading a 200 as honoured.
    for (const extra of [
      { segment: 'chosen-by-me' },
      { workspaceId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' },
    ]) {
      expect(
        createWorkspaceRequestSchema.safeParse({ displayName: 'Marketing', ...extra }).success,
      ).toBe(false)
    }
  })
})

describe('renameWorkspaceRequestSchema', () => {
  it('parses each layer alone, and both together', () => {
    expect(renameWorkspaceRequestSchema.parse({ segment: 'moved' }).segment).toBe('moved')
    expect(renameWorkspaceRequestSchema.parse({ displayName: 'Named' }).displayName).toBe('Named')
    expect(renameWorkspaceRequestSchema.parse({ segment: 'a', displayName: 'B' })).toEqual({
      segment: 'a',
      displayName: 'B',
    })
  })

  it('accepts an empty body — every layer absent means change nothing', () => {
    expect(renameWorkspaceRequestSchema.safeParse({}).success).toBe(true)
  })

  it('rejects a segment shaped like a canonical id, which the address cannot disambiguate', () => {
    expect(
      renameWorkspaceRequestSchema.safeParse({ segment: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }).success,
    ).toBe(false)
  })

  it('rejects a segment outside the path-segment charset', () => {
    expect(renameWorkspaceRequestSchema.safeParse({ segment: 'has spaces' }).success).toBe(false)
    expect(renameWorkspaceRequestSchema.safeParse({ segment: 'nested/path' }).success).toBe(false)
  })
})
