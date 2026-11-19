/**
 * Whether a trashed document's bytes may be put back into a workspace record.
 *
 * A trash row and the bytes it names both arrive from outside the keeper: the
 * row is synced data any writer of the record can rewrite, and a promotion
 * carries bytes the other keeper chose. A restore places what they say into
 * the live record without passing the sync-write checks — the trash map is not
 * node meta, so no placement check sees the row change — so it is held to the
 * same bounds here: the text limits `importWithinTextLimits` judges, the
 * path grammar on every node it places, folders included, the name bound,
 * and readable node meta.
 *
 * Judged on scratch records, before anything touches the live one, so a
 * refusal leaves the workspace as it was. Both keepers restore through
 * `LoroWorkspaceDocumentIndex`, so this is the one place the judgement lives.
 */
import {
  type CrdtEngine,
  loadCrdtEngine,
  randomPeerId,
  readValue,
  type WorkspaceNode,
} from '@kamiazya/whiteboard-loro-adapter'
import {
  bytesToBase64,
  DOCUMENT_NAME_MAX_LENGTH,
  DOCUMENT_PATH_MAX_LENGTH,
  documentPathSchema,
  isSelfOrDescendant,
} from '@kamiazya/whiteboard-model'

// The readers answer in the shapes the loro-adapter functions behind them
// return; this package asserts the type and holds no schema of its own for it.
const assertedAs = <T>() => ({ parse: (value: unknown) => value as T })

/**
 * How many documents and folders the bytes would place for `documentId`
 * under `parentPath` — the document and everything it held, not counting
 * the folders `parentPath` itself needs — or `null` when they may not be
 * placed at all.
 */
export async function restorableTrashDocuments(
  bytes: Uint8Array,
  input: { readonly documentId: string; readonly parentPath: string | undefined },
): Promise<{ readonly documents: number; readonly folders: number } | null> {
  const engine = await loadCrdtEngine()
  const encoded = bytesToBase64(bytes)
  // An empty record replays no runs, so this judges what the bytes HOLD — a
  // body or node text past its bound — at the cost of loading a snapshot.
  const judged = engine.open({ peer: randomPeerId() })
  try {
    if (engine.import({ handle: judged.handle, bytes: encoded }).outcome === 'refused') return null
  } finally {
    engine.close({ handle: judged.handle })
  }
  // Placed under the row's parent path as the live record would place it, so
  // the paths read back are the ones the restore would create.
  const placed = engine.open({ peer: randomPeerId() })
  try {
    return await placementOf(engine, placed.handle, encoded, input)
  } finally {
    engine.close({ handle: placed.handle })
  }
}

async function placementOf(
  engine: CrdtEngine,
  handle: number,
  encoded: string,
  input: { readonly documentId: string; readonly parentPath: string | undefined },
): Promise<{ readonly documents: number; readonly folders: number } | null> {
  const placed = engine.importSubtree({
    handle,
    bytes: encoded,
    ...(input.parentPath === undefined ? {} : { parentPath: input.parentPath }),
  })
  if (placed.outcome === 'refused') return null
  const restored = await readValue(
    engine,
    handle,
    { query: 'workspaceDocumentEntry', args: { documentId: input.documentId } },
    assertedAs<{ readonly path: string } | null>(),
  )
  // Bytes holding some other document — another row's, say — are refused, so
  // a row can only bring back the document it is for.
  if (restored === null) return null
  const unreadable = await readValue(
    engine,
    handle,
    { query: 'unreadableNodes' },
    assertedAs<readonly string[]>(),
  )
  if (unreadable.length > 0) return null
  const nodes = await readValue(
    engine,
    handle,
    { query: 'nodes' },
    assertedAs<readonly WorkspaceNode[]>(),
  )
  return placeableNodes(nodes, restored.path)
}

/**
 * The documents and the folders below `top` that `nodes` hold, or `null`
 * when any node sits at a path the grammar refuses or a document carries a
 * name past the bound.
 */
function placeableNodes(
  nodes: readonly WorkspaceNode[],
  top: string,
): { readonly documents: number; readonly folders: number } | null {
  let documents = 0
  let folders = 0
  for (const node of nodes) {
    if (node.path.length > DOCUMENT_PATH_MAX_LENGTH) return null
    if (!documentPathSchema.safeParse(node.path).success) return null
    if (node.type === 'document') {
      if ((node.meta.name?.length ?? 0) > DOCUMENT_NAME_MAX_LENGTH) return null
      documents += 1
    } else if (isSelfOrDescendant(node.path, top)) {
      folders += 1
    }
  }
  return { documents, folders }
}
