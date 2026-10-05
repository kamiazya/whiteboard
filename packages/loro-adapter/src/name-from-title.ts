// A document named after the title its body announces, judged once for every
// keeper: the browser's store and the daemon, which names on every content
// write, take the same bytes, so a note typed into at `untitled` must come out
// named the same way whichever of them keeps it.
import type { ContainerID, LoroDoc, LoroTreeNode, TreeID, VersionVector } from 'loro-crdt'
import { LoroText } from 'loro-crdt'
import { MARKDOWN_BODY_KEY } from './containers.js'
import { titleFromMarkdownBody } from './title-from-body.js'
import {
  WORKSPACE_TREE_KEY,
  workspaceNodeMetaSchema,
  writeWorkspaceDocumentContent,
} from './workspace-tree.js'

/**
 * Whether a path is one the new-document flow chose, rather than one a person
 * did — the shape apps/web's `newDocumentPathIn` produces, which a property
 * there holds this predicate to.
 *
 * The pair matters because "nobody has named this yet" is not something the
 * tree records: clearing a name in the rename dialog leaves the same absent
 * `name` a brand-new document has. A still-generated path is the closest
 * honest proxy — someone who cleared the name of a document they had also
 * placed somewhere has engaged with naming, and must not be overridden.
 */
function isGeneratedDocumentPath(path: string): boolean {
  const last = path.slice(path.lastIndexOf('/') + 1)
  return /^untitled(?:-(?:[2-9]|[1-9]\d+))?$/.test(last)
}

const META_KEYS = Object.keys(workspaceNodeMetaSchema.shape)

/**
 * The name `node` should be given now, or `null` to leave it as it is.
 *
 * Someone who opens a note and types `# Weekly review` has said what it is
 * called. Without this the workspace keeps calling it `untitled`, in the
 * card, the URL and every search result, and the only way to fix that is to
 * type the same words a second time into the rename dialog.
 *
 * A name somebody CHOSE (`nameChosen`) is never replaced, whatever the
 * heading says. Past that, two gates, and the second is the load-bearing
 * one. `name` absent means "nobody named it" — but it is ALSO what the
 * rename dialog leaves behind when someone deliberately clears a name to
 * show the path instead, and re-seeding over that would be this codebase's
 * recurring defect: state keyed on something that has since changed. A
 * still-generated path is the proxy that separates them
 * (`isGeneratedDocumentPath`). Only the node's own segment is read: the
 * predicate looks at nothing else of a path.
 *
 * The PATH is never touched. ADR-0008 measured deriving one from a display
 * name and found every non-Latin title collapsing to `untitled-N`; ADR-0007's
 * addendum retracted it. Seeding the name leaves the address alone, so a
 * heading edit can never move a document out from under a link.
 *
 * KEEPS UP with a heading still being typed. Typing outlasts a save's
 * debounce on a loaded machine, so a save lands while the title is half
 * written — and a first version of this stopped there, because a name being
 * present was what closed its gate. Measured in a real browser: `# From` …
 * ` the list` produced a document called "From", forever. A wrong name is
 * worse than `untitled`, because it looks deliberate. So a name this
 * produced may be replaced, and the test for "this one is ours" is that it
 * is not marked chosen and the title still STARTS WITH it — exactly the shape
 * a half-typed heading leaves behind. The prefix alone cannot tell a seeded
 * name from a short one somebody gave a longer heading; the marker can.
 *
 * The body is read where it already is and never attached: attaching a
 * container on a tree node is an op, and a read that writes would make every
 * keeper's judgement a write of its own.
 */
function nameToSeed(node: LoroTreeNode): string | null {
  const meta = workspaceNodeMetaSchema.safeParse(
    Object.fromEntries(META_KEYS.map((key) => [key, node.data.get(key)])),
  )
  if (!meta.success || meta.data.nameChosen || !isGeneratedDocumentPath(meta.data.segment)) {
    return null
  }
  const body = node.data.get(MARKDOWN_BODY_KEY)
  if (!(body instanceof LoroText)) return null
  const title = titleFromMarkdownBody(body.toString())
  const { name } = meta.data
  if (title === undefined || title === name) return null
  // Absent: nobody has named it. A strict prefix of the title: we named it,
  // from a heading that has since grown.
  return name === undefined || title.startsWith(name) ? title : null
}

/** Seeds `node`'s name, uncommitted. */
function seedNode(node: LoroTreeNode): void {
  const name = nameToSeed(node)
  if (name !== null) node.data.set('name', workspaceNodeMetaSchema.shape.name.parse(name))
}

/**
 * Names the document `documentId` after its heading while nobody has named
 * it and nobody has placed it (`nameToSeed`). For a keeper that knows which
 * document it just wrote. A commit with nothing pending records nothing, so
 * a document it leaves alone costs no write.
 */
export function seedNameFromTitle(workspace: LoroDoc, documentId: string): void {
  const node = documentNode(workspace, documentId)
  if (node === undefined) return
  seedNode(node)
  workspace.commit()
}

/**
 * Writes `source` into the record as `documentId`'s content and names a note
 * still at a generated path after its heading (`seedNameFromTitle`) — false,
 * with nothing written, when the record holds no such document.
 *
 * Every whole-content write a keeper makes outside this package comes through
 * here — the daemon's saves, tools, `/api/v1` and restore, and the browser's
 * restore — so a note is named however its body was written. One that skipped
 * the seed kept its old name until the next unrelated keystroke named it,
 * which reads as a rename nobody made. Before the caller's save, so the name
 * rides the same write and its fan-out.
 *
 * Two writes inside this package call `writeWorkspaceDocumentContent` bare on
 * purpose, because the caller supplies the name: `duplicateWorkspaceDocument`
 * (the copy's name is chosen) and `adoptWorkspaceDocument` (a fold carries the
 * name the document already had). A browser create writes no content at all —
 * its node starts empty — so it has nothing to name from.
 * `document-content-write-one-place.test.ts` keeps the bare write inside here.
 */
export function writeDocumentContentAndName(
  workspace: LoroDoc,
  documentId: string,
  source: LoroDoc,
): boolean {
  if (!writeWorkspaceDocumentContent(workspace, documentId, source)) return false
  seedNameFromTitle(workspace, documentId)
  return true
}

/**
 * The name the record holds for `documentId`: the name, `null` when it has
 * none, `undefined` when it cannot say — no such document, or a stored value
 * that is not a name.
 *
 * For a page following its document's name while the record changes under
 * it, so it is read on every change: it finds the node and reads one key,
 * where resolving the whole entry would also digest the content.
 */
export function readWorkspaceDocumentName(
  workspace: LoroDoc,
  documentId: string,
): string | null | undefined {
  const node = documentNode(workspace, documentId)
  if (node === undefined) return undefined
  const name = workspaceNodeMetaSchema.shape.name.safeParse(node.data.get('name'))
  return name.success ? (name.data ?? null) : undefined
}

function documentNode(workspace: LoroDoc, documentId: string): LoroTreeNode | undefined {
  return workspace
    .getTree(WORKSPACE_TREE_KEY)
    .getNodes()
    .find((each) => each.data.get('documentId') === documentId)
}

/**
 * `seedNameFromTitle` for every document the operations after `since` wrote
 * to — the shape a keeper taking a whole workspace update needs, since the
 * update does not say which document it is about.
 *
 * Read off the operations rather than the tree, so the cost follows the
 * update: a walk of the tree reads every document's content, which on a
 * large workspace is a per-keystroke cost the bytes did not ask for.
 */
export function seedNamesFromTitles(workspace: LoroDoc, since: VersionVector): void {
  const containers = new Set<ContainerID>()
  const { changes } = workspace.exportJsonUpdates(since, workspace.oplogVersion(), false)
  for (const change of changes) for (const op of change.ops) containers.add(op.container)
  const nodes = new Set<TreeID>()
  for (const container of containers) {
    // A node's own map and every container under it sit at `[tree, <node>, …]`.
    const path = workspace.getPathToContainer(container)
    if (path !== undefined && path.length >= 2 && path[0] === WORKSPACE_TREE_KEY) {
      nodes.add(path[1] as TreeID)
    }
  }
  const tree = workspace.getTree(WORKSPACE_TREE_KEY)
  for (const id of nodes) {
    const node = tree.getNodeByID(id)
    if (node !== undefined) seedNode(node)
  }
  workspace.commit()
}
