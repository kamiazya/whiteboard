import type { OperatorInfo } from '@kamiazya/whiteboard-daemon-client/api-contracts/document'
import { frontiersToBase64 } from '@kamiazya/whiteboard-history'
import type { RecordSession } from '@kamiazya/whiteboard-loro-adapter'
import { DocumentNotFoundError } from '@kamiazya/whiteboard-ports'
import { TooManyVersionsError } from '@kamiazya/whiteboard-server-core'
import { nanoid } from 'nanoid'
import { validateVersionId } from '../validators.js'
import type { TenantDatabase } from './db/tenant-database.js'
import { refusePastManualCeiling } from './version-ceilings.js'
import { versionRow } from './version-row.js'

// The engine answers in the shapes the loro-adapter readers return; this
// module asserts the type and holds no schema of its own for it.
const assertedAs = <T>() => ({ parse: (value: unknown) => value as T })

/** A document as the record's listing shows it, which is all a batch reads of one. */
interface ListedDocument {
  documentId: string
  path: string
  kind: string
  contentDigest: string
  shadowed?: true
}

/** What a checkpoint records of a document beside the frontier the record stands at. */
export interface StatedDocument {
  documentId: string
  elementCount: number
  contentDigest: string
}

/**
 * What the record says of every document in the batch, from ONE listing of it:
 * the digest and kind come off that read rather than one walk of the tree per
 * document. Nothing writes between the checkpoints, so they all name the state
 * the record stands at. A document the listing does not show at its path as the
 * path's owner is `DocumentNotFoundError`, as a save by path would say.
 */
export async function statedAtRecord(
  workspaceId: string,
  record: RecordSession | null,
  documents: readonly { documentId: string; path: string }[],
): Promise<{ frontiers: string; stated: StatedDocument[] }> {
  if (record === null) throw new DocumentNotFoundError(workspaceId, documents[0]?.path ?? '')
  const listing = await record.read({ query: 'documents' }, assertedAs<ListedDocument[]>())
  const byId = new Map(listing.map((entry) => [entry.documentId, entry]))
  const stated: StatedDocument[] = []
  for (const { documentId, path } of documents) {
    const entry = byId.get(documentId)
    if (entry === undefined || entry.path !== path || entry.shadowed === true) {
      throw new DocumentNotFoundError(workspaceId, path)
    }
    // Only a spatial document has nodes to count: any other kind reads 0.
    const elementCount =
      entry.kind === 'spatial'
        ? await record.read(
            { query: 'spatialNodeCount', args: { documentId } },
            assertedAs<number>(),
          )
        : 0
    stated.push({ documentId, elementCount, contentDigest: entry.contentDigest })
  }
  return { frontiers: frontiersToBase64(record.version().encodedFrontiers), stated }
}

/**
 * One row per stated document, each through the same ceiling and prune a save
 * of it alone goes through. A document whose history is full is left out of the
 * answer and the rest still land.
 */
export async function insertCheckpoints(input: {
  db: TenantDatabase
  workspaceId: string
  opts: { auto: boolean; operator?: OperatorInfo }
  frontiers: string
  stated: readonly StatedDocument[]
  prune: (documentId: string) => Promise<void>
}): Promise<string[]> {
  const { db, workspaceId, opts, frontiers, stated, prune } = input
  const recorded: string[] = []
  for (const { documentId, elementCount, contentDigest } of stated) {
    try {
      if (!opts.auto) await refusePastManualCeiling(db, workspaceId, documentId)
    } catch (err) {
      if (err instanceof TooManyVersionsError) continue
      throw err
    }
    const id = nanoid(12)
    validateVersionId(id)
    await db
      .insertInto('versions')
      .values(
        versionRow({
          id,
          documentId,
          workspaceId,
          opts,
          operator: opts.operator,
          elementCount,
          frontiers,
          contentDigest,
          createdAt: Date.now(),
        }),
      )
      .execute()
    await prune(documentId)
    recorded.push(documentId)
  }
  return recorded
}
