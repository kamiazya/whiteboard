import { LoroDoc, type LoroTree, type LoroTreeNode, type TreeID } from 'loro-crdt'

const TREE_KEY = 'tree'
const SEGMENT_PATTERN = /^[a-zA-Z0-9]([a-zA-Z0-9_-]*[a-zA-Z0-9])?$/

export interface WorkspaceNode {
  readonly id: TreeID
  readonly canvasId: string
  readonly segment: string
}

export interface WorkspaceTreeSnapshot {
  readonly nodes: readonly WorkspaceNode[]
}

export class WorkspaceTree {
  readonly #doc: LoroDoc
  readonly #tree: LoroTree<{ canvasId: string; segment: string }>

  constructor(doc: LoroDoc) {
    this.#doc = doc
    this.#tree = doc.getTree(TREE_KEY) as LoroTree<{
      canvasId: string
      segment: string
    }>
  }

  static fromSnapshot(bytes: Uint8Array): WorkspaceTree {
    const doc = LoroDoc.fromSnapshot(bytes)
    return new WorkspaceTree(doc)
  }

  exportSnapshot(): Uint8Array {
    return this.#doc.export({ mode: 'snapshot' })
  }

  exportFrontier(): Uint8Array<ArrayBuffer> {
    const encoded = this.#doc.version().encode()
    return new Uint8Array(encoded)
  }

  createNode(canvasId: string, segment: string, parent?: TreeID, index?: number): TreeID {
    validateSegment(segment)
    this.#assertNoSiblingConflict(parent, segment)
    const node = this.#tree.createNode(parent, index)
    node.data.set('canvasId', canvasId)
    node.data.set('segment', segment)
    this.#doc.commit()
    return node.id
  }

  move(target: TreeID, newParent?: TreeID, index?: number): void {
    const node = this.#getNode(target)
    const segment = node.data.get('segment') as string
    this.#assertNoSiblingConflict(newParent, segment, target)
    this.#tree.move(target, newParent, index)
    this.#doc.commit()
  }

  rename(target: TreeID, newSegment: string): void {
    validateSegment(newSegment)
    const node = this.#getNode(target)
    const parentNode = node.parent()
    const parentId = parentNode?.id
    this.#assertNoSiblingConflict(parentId, newSegment, target)
    node.data.set('segment', newSegment)
    this.#doc.commit()
  }

  delete(target: TreeID): void {
    this.#tree.delete(target)
    this.#doc.commit()
  }

  getNode(id: TreeID): WorkspaceNode | undefined {
    const node = this.#tree.getNodeByID(id)
    if (!node || this.#tree.isNodeDeleted(id)) return undefined
    return toWorkspaceNode(node)
  }

  children(parent?: TreeID): readonly WorkspaceNode[] {
    if (parent === undefined) {
      const all = this.#tree.getNodes()
      return all.filter((n) => n.parent() === undefined).map(toWorkspaceNode)
    }
    const node = this.#tree.getNodeByID(parent)
    if (!node) return []
    const kids = node.children()
    if (!kids) return []
    return kids.map(toWorkspaceNode)
  }

  /**
   * Alias derivation is a pure function of tree state (ADR-0008 point 5): a
   * CRDT merge can legally leave two siblings with the same raw segment, and
   * nothing may rewrite the tree to fix that on read. So at each level of
   * the root-to-leaf walk, the raw segment is replaced by its disambiguated
   * form among live siblings at that level (see `disambiguateSegments`).
   * ponytail: recomputes the sibling group at every level of every call
   * (O(depth x siblings log siblings) per resolve); fine at workspace
   * scale, memoize per-parent within one derivation pass if this shows up
   * on a profile.
   */
  resolveAlias(id: TreeID): string | undefined {
    const node = this.#tree.getNodeByID(id)
    if (!node || this.#tree.isNodeDeleted(id)) return undefined
    const segments: string[] = []
    let current: LoroTreeNode<{ canvasId: string; segment: string }> | undefined = node
    while (current) {
      const parent = current.parent()
      const disambiguated = disambiguateSegments(this.children(parent?.id))
      segments.unshift(disambiguated.get(current.id) ?? (current.data.get('segment') as string))
      current = parent
    }
    return segments.join('/')
  }

  findByAlias(alias: string): WorkspaceNode | undefined {
    const parts = alias.split('/')

    let candidates = this.#tree.getNodes().filter((n) => n.parent() === undefined)

    let matched: LoroTreeNode<{ canvasId: string; segment: string }> | undefined

    for (const part of parts) {
      const disambiguated = disambiguateSegments(candidates.map(toWorkspaceNode))
      matched = candidates.find((n) => disambiguated.get(n.id) === part)
      if (!matched) return undefined
      candidates = matched.children() ?? []
    }

    return matched ? toWorkspaceNode(matched) : undefined
  }

  snapshot(): WorkspaceTreeSnapshot {
    return {
      nodes: this.#tree.getNodes().map(toWorkspaceNode),
    }
  }

  #getNode(id: TreeID): LoroTreeNode<{ canvasId: string; segment: string }> {
    const node = this.#tree.getNodeByID(id)
    if (!node) throw new Error(`Tree node not found: ${id}`)
    return node
  }

  /**
   * A courtesy check on local mutations only (ADR-0008 point 5): it refuses
   * a conflict this peer can see coming, but a CRDT merge of two concurrent
   * creates on different peers is not an operation anyone can decline, so
   * duplicate sibling segments are legal tree state. `resolveAlias`/
   * `findByAlias` disambiguate them at read time instead.
   */
  #assertNoSiblingConflict(
    parentId: TreeID | undefined,
    segment: string,
    excludeId?: TreeID,
  ): void {
    const siblings = this.children(parentId)
    const conflict = siblings.find((s) => s.segment === segment && s.id !== excludeId)
    if (conflict) {
      throw new Error(`Sibling segment conflict: "${segment}" already exists under this parent`)
    }
  }
}

function validateSegment(segment: string): void {
  if (segment === '') throw new Error('Segment must not be empty')
  if (!SEGMENT_PATTERN.test(segment)) {
    throw new Error(
      `Invalid segment "${segment}": must match /^[a-zA-Z0-9]([a-zA-Z0-9_-]*[a-zA-Z0-9])?$/`,
    )
  }
}

function toWorkspaceNode(node: LoroTreeNode<{ canvasId: string; segment: string }>): WorkspaceNode {
  return {
    id: node.id,
    canvasId: node.data.get('canvasId') as string,
    segment: node.data.get('segment') as string,
  }
}

/** Plain code-unit string compare — never `localeCompare`, whose collation is environment-dependent. */
function compareCanvasId(a: WorkspaceNode, b: WorkspaceNode): number {
  if (a.canvasId < b.canvasId) return -1
  if (a.canvasId > b.canvasId) return 1
  return 0
}

/**
 * Derives a unique alias segment per node among `siblings` (one parent's
 * live children). Non-colliding raw segments pass through unchanged
 * (identity). A group of nodes sharing a raw segment is ordered by
 * `canvasId` — the winner keeps the bare segment, the rest take the first
 * free `segment-2`, `segment-3`, ... candidate, skipping any candidate
 * already taken by another sibling's raw segment or by an earlier
 * assignment in this same pass (so a real sibling literally named
 * `notes-2` can never collide with a generated suffix). Pure function of
 * `siblings` — reads no Loro state and performs no write, which is what
 * keeps derivation idempotent and identical on every peer.
 */
function disambiguateSegments(siblings: readonly WorkspaceNode[]): Map<TreeID, string> {
  const groups = new Map<string, WorkspaceNode[]>()
  for (const node of siblings) {
    const group = groups.get(node.segment)
    if (group) group.push(node)
    else groups.set(node.segment, [node])
  }

  const result = new Map<TreeID, string>()
  const taken = new Set(groups.keys())
  for (const [segment, group] of groups) {
    const [winner, ...rest] = group.sort(compareCanvasId)
    result.set(winner!.id, segment)
    let suffix = 2
    for (const node of rest) {
      let candidate = `${segment}-${suffix}`
      while (taken.has(candidate)) {
        suffix += 1
        candidate = `${segment}-${suffix}`
      }
      result.set(node.id, candidate)
      taken.add(candidate)
      suffix += 1
    }
  }

  return result
}
