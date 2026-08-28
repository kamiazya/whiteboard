import { expectTypeOf, it } from 'vitest'
import type {
  BlobDeleteInput,
  BlobGetInput,
  BlobGetResult,
  BlobHasInput,
  BlobHasResult,
  BlobPutInput,
  BlobPutResult,
  BlobStore,
} from './blob-store.js'
import type { CreateWorkspaceInput, DocumentIndex, WorkspaceEntry } from './document-index.js'
import type {
  AppendDeltasInput,
  AppendDeltasResult,
  DocumentStore,
  LoadDeltasInput,
  LoadDeltasResult,
  LoadSnapshotInput,
  LoadSnapshotResult,
  ReadFrontierInput,
  ReadFrontierResult,
  SaveSnapshotInput,
} from './document-store.js'
import type { PresenceChannel, PresenceState } from './presence.js'

// Compile-time only: proves each port method's Parameters/Awaited-ReturnType
// are exactly the named z.infer DTOs, so the interface cannot silently drift
// from its schema (the class of bug the create_frame assignedMembers
// number-vs-string[] mismatch shipped as).

it('DocumentStore: every method param/return is exactly its named DTO', () => {
  expectTypeOf<Parameters<DocumentStore['loadSnapshot']>[0]>().toEqualTypeOf<LoadSnapshotInput>()
  expectTypeOf<
    Awaited<ReturnType<DocumentStore['loadSnapshot']>>
  >().toEqualTypeOf<LoadSnapshotResult>()

  expectTypeOf<Parameters<DocumentStore['saveSnapshot']>[0]>().toEqualTypeOf<SaveSnapshotInput>()
  expectTypeOf<Awaited<ReturnType<DocumentStore['saveSnapshot']>>>().toEqualTypeOf<void>()

  expectTypeOf<Parameters<DocumentStore['appendDeltas']>[0]>().toEqualTypeOf<AppendDeltasInput>()
  expectTypeOf<
    Awaited<ReturnType<DocumentStore['appendDeltas']>>
  >().toEqualTypeOf<AppendDeltasResult>()

  expectTypeOf<Parameters<DocumentStore['loadDeltas']>[0]>().toEqualTypeOf<LoadDeltasInput>()
  expectTypeOf<Awaited<ReturnType<DocumentStore['loadDeltas']>>>().toEqualTypeOf<LoadDeltasResult>()

  expectTypeOf<Parameters<DocumentStore['readFrontier']>[0]>().toEqualTypeOf<ReadFrontierInput>()
  expectTypeOf<
    Awaited<ReturnType<DocumentStore['readFrontier']>>
  >().toEqualTypeOf<ReadFrontierResult>()
})

it('BlobStore: every method param/return is exactly its named DTO', () => {
  expectTypeOf<Parameters<BlobStore['put']>[0]>().toEqualTypeOf<BlobPutInput>()
  expectTypeOf<Awaited<ReturnType<BlobStore['put']>>>().toEqualTypeOf<BlobPutResult>()

  expectTypeOf<Parameters<BlobStore['get']>[0]>().toEqualTypeOf<BlobGetInput>()
  expectTypeOf<Awaited<ReturnType<BlobStore['get']>>>().toEqualTypeOf<BlobGetResult>()

  expectTypeOf<Parameters<BlobStore['has']>[0]>().toEqualTypeOf<BlobHasInput>()
  expectTypeOf<Awaited<ReturnType<BlobStore['has']>>>().toEqualTypeOf<BlobHasResult>()

  expectTypeOf<Parameters<BlobStore['delete']>[0]>().toEqualTypeOf<BlobDeleteInput>()
  expectTypeOf<Awaited<ReturnType<BlobStore['delete']>>>().toEqualTypeOf<void>()
})

it('DocumentIndex: createWorkspace/listWorkspaces param/return are exactly their named DTOs', () => {
  expectTypeOf<
    Parameters<DocumentIndex['createWorkspace']>[0]
  >().toEqualTypeOf<CreateWorkspaceInput>()
  expectTypeOf<Awaited<ReturnType<DocumentIndex['createWorkspace']>>>().toEqualTypeOf<void>()

  expectTypeOf<Awaited<ReturnType<DocumentIndex['listWorkspaces']>>>().toEqualTypeOf<
    WorkspaceEntry[]
  >()
})

it('PresenceChannel: publish param and subscribe callback param are PresenceState; subscribe return is control-plane (not a DTO)', () => {
  expectTypeOf<Parameters<PresenceChannel['publish']>[0]>().toEqualTypeOf<PresenceState>()
  expectTypeOf<Awaited<ReturnType<PresenceChannel['publish']>>>().toEqualTypeOf<void>()

  expectTypeOf<
    Parameters<Parameters<PresenceChannel['subscribe']>[0]>[0]
  >().toEqualTypeOf<PresenceState>()
  expectTypeOf<ReturnType<PresenceChannel['subscribe']>>().toEqualTypeOf<() => void>()
})
